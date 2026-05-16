"""Midget jr. backend — FastAPI + MongoDB + GPT-5.2 (via Emergent LLM key)."""
from __future__ import annotations

import asyncio
import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

import bcrypt
import httpx
import jwt
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field
from starlette.middleware.cors import CORSMiddleware

from emergentintegrations.llm.chat import LlmChat, UserMessage

# ── Setup ────────────────────────────────────────────────────────────────
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
EMERGENT_LLM_KEY = os.environ["EMERGENT_LLM_KEY"]
JWT_SECRET = os.environ["JWT_SECRET"]
ADMIN_PASSWORD = os.environ["ADMIN_PASSWORD"]
LLM_MODEL = os.environ.get("LLM_MODEL", "gpt-5.2")
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "openai")

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]
kb = db.knowledge_entries
queue = db.research_queue
config = db.app_config

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")
log = logging.getLogger("midgetjr")

app = FastAPI(title="Midget jr.")
api = APIRouter(prefix="/api")

# ── Models ───────────────────────────────────────────────────────────────
def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class UnlockBody(BaseModel):
    password: str


class ChatBody(BaseModel):
    message: str
    history: List[dict] = Field(default_factory=list)


class QueryBody(BaseModel):
    query: str


class ResearchBody(BaseModel):
    topic: str
    category: str = "General"


class CodeBody(BaseModel):
    prompt: str
    language: str = "python"


class QueueBody(BaseModel):
    topic: str
    category: str = "General"
    priority: int = 2


class ImportItem(BaseModel):
    name: str
    content: str
    category: str = "Imported"
    tags: List[str] = Field(default_factory=list)


class ImportBody(BaseModel):
    files: List[ImportItem]


class KnowledgeEntry(BaseModel):
    id: str
    topic: str
    summary: str
    content: str = ""
    category: str = "General"
    source_url: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    added_by: str = "user"
    created_at: str


class QueueItem(BaseModel):
    id: str
    topic: str
    category: str = "General"
    priority: int = 2
    status: str = "pending"
    added_by: str = "user"
    created_at: str
    last_attempt: Optional[str] = None
    error: Optional[str] = None


# ── Auth ─────────────────────────────────────────────────────────────────
async def seed_admin() -> None:
    """Ensure the admin password hash is in the DB. Re-seeds if ADMIN_PASSWORD changed."""
    doc = await config.find_one({"_id": "auth"})
    pw_bytes = ADMIN_PASSWORD.encode()
    needs_seed = doc is None or not bcrypt.checkpw(pw_bytes, doc["password_hash"].encode())
    if needs_seed:
        hashed = bcrypt.hashpw(pw_bytes, bcrypt.gensalt()).decode()
        await config.update_one(
            {"_id": "auth"},
            {"$set": {"password_hash": hashed, "updated_at": _now()}},
            upsert=True,
        )
        log.info("Admin password (re)seeded.")


def make_token() -> str:
    payload = {
        "role": "admin",
        "iat": int(datetime.now(timezone.utc).timestamp()),
        "exp": int((datetime.now(timezone.utc) + timedelta(days=7)).timestamp()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


async def require_admin(authorization: Optional[str] = Header(None)) -> bool:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Admin token required")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    if payload.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Forbidden")
    return True


# ── LLM helpers ──────────────────────────────────────────────────────────
def new_chat(session_id: str, system: str) -> LlmChat:
    return LlmChat(
        api_key=EMERGENT_LLM_KEY,
        session_id=session_id,
        system_message=system,
    ).with_model(LLM_PROVIDER, LLM_MODEL)


async def llm_oneshot(system: str, prompt: str) -> str:
    chat = new_chat(f"oneshot-{uuid.uuid4().hex[:8]}", system)
    return await chat.send_message(UserMessage(text=prompt))


# ── Knowledge search ─────────────────────────────────────────────────────
def _tokenize(q: str) -> List[str]:
    toks = re.findall(r"[A-Za-z0-9_]{3,}", q.lower())
    seen, out = set(), []
    for t in toks:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out[:8]


async def search_kb(q: str, limit: int = 5) -> List[dict]:
    toks = _tokenize(q)
    if not toks:
        return []
    or_clauses = []
    for t in toks:
        rx = {"$regex": re.escape(t), "$options": "i"}
        or_clauses.extend([{"topic": rx}, {"summary": rx}, {"content": rx}, {"tags": rx}])
    cursor = kb.find({"$or": or_clauses}, {"_id": 0}).limit(limit * 4)
    docs = await cursor.to_list(length=limit * 4)
    # Rank by token-match count across topic+summary
    def score(d: dict) -> int:
        blob = " ".join([d.get("topic", ""), d.get("summary", ""), " ".join(d.get("tags", []))]).lower()
        return sum(1 for t in toks if t in blob)
    docs.sort(key=score, reverse=True)
    return docs[:limit]


# ── Web research (Google + scrape) ───────────────────────────────────────
def _google_search(query: str, num: int = 5) -> List[str]:
    """Try Google first, fall back to DuckDuckGo (Google blocks most datacenter IPs)."""
    urls: List[str] = []
    try:
        from googlesearch import search  # type: ignore
        urls = list(search(query, num_results=num, lang="en"))
    except Exception as e:
        log.info(f"Google search threw: {e}")
    if urls:
        log.info(f"Google returned {len(urls)} URLs")
        return urls
    try:
        from ddgs import DDGS  # type: ignore
        with DDGS() as d:
            res = list(d.text(query, max_results=num))
        urls = [r.get("href") for r in res if r.get("href")]
        log.info(f"DDG fallback returned {len(urls)} URLs")
    except Exception as e:
        log.warning(f"DDG fallback failed: {e}")
    return urls


async def fetch_url(url: str, timeout: float = 12.0) -> str:
    headers = {"User-Agent": "Mozilla/5.0 (compatible; MidgetJrBot/1.0)"}
    async with httpx.AsyncClient(follow_redirects=True, timeout=timeout, headers=headers) as c:
        try:
            r = await c.get(url)
            if r.status_code != 200:
                return ""
            ctype = r.headers.get("content-type", "")
            if "html" not in ctype and "text" not in ctype:
                return ""
            soup = BeautifulSoup(r.text, "html.parser")
            for tag in soup(["script", "style", "nav", "footer", "header", "noscript"]):
                tag.decompose()
            text = re.sub(r"\s+", " ", soup.get_text(" ", strip=True))
            return text[:6000]
        except Exception as e:
            log.info(f"fetch_url failed for {url}: {e}")
            return ""


async def do_research(topic: str, category: str = "General") -> dict:
    urls = await asyncio.to_thread(_google_search, topic, 5)
    pages: List[dict] = []
    if urls:
        results = await asyncio.gather(*(fetch_url(u) for u in urls), return_exceptions=True)
        for url, text in zip(urls, results):
            if isinstance(text, str) and len(text) > 200:
                pages.append({"url": url, "text": text})

    if pages:
        joined = "\n\n---\n\n".join(f"[Source: {p['url']}]\n{p['text'][:2500]}" for p in pages[:4])
        prompt = (
            f"Write a clear, factual summary about: {topic}\n\n"
            f"Use only the sources below. Cite source URLs inline like [1], [2]. "
            f"End with a short '## Sources' list mapping numbers to URLs. "
            f"Aim for 6–10 sentences.\n\nSources:\n{joined}"
        )
        try:
            summary = await llm_oneshot("You are a precise research assistant.", prompt)
        except Exception as e:
            summary = f"(LLM summarization failed: {e})\n\nRaw excerpts:\n" + joined[:1500]
    else:
        summary = ""

    entry_id = str(uuid.uuid4())
    entry = {
        "id": entry_id,
        "topic": topic,
        "summary": summary or f"No web sources found for '{topic}'.",
        "content": "\n\n".join(p["text"] for p in pages),
        "category": category,
        "source_url": pages[0]["url"] if pages else None,
        "tags": [category.lower(), "research"],
        "added_by": "research",
        "created_at": _now(),
    }
    await kb.insert_one(dict(entry))  # mutates with _id, that's fine — we don't reuse this dict
    return {
        "topic": topic,
        "sources_found": len(pages),
        "summary": entry["summary"],
        "id": entry_id,
    }


# ── Routes: Public ───────────────────────────────────────────────────────
@api.get("/")
async def root():
    return {"app": "Midget jr.", "ok": True, "model": LLM_MODEL}


@api.post("/unlock")
async def unlock(body: UnlockBody):
    doc = await config.find_one({"_id": "auth"})
    if not doc:
        raise HTTPException(500, "Auth not initialized")
    if not bcrypt.checkpw(body.password.encode(), doc["password_hash"].encode()):
        raise HTTPException(401, "Wrong password")
    return {"token": make_token(), "expires_in_days": 7}


@api.post("/chat")
async def chat(body: ChatBody):
    ctx_docs = await search_kb(body.message, limit=4)
    context_block = ""
    if ctx_docs:
        bits = []
        for i, d in enumerate(ctx_docs, 1):
            bits.append(
                f"[{i}] {d.get('topic','')}\n{d.get('summary','')[:600]}"
                + (f"\nsource: {d['source_url']}" if d.get("source_url") else "")
            )
        context_block = "Knowledge base entries (may help):\n\n" + "\n\n".join(bits)

    system = (
        "You are Midget jr., a curious, friendly self-growing knowledge bot. "
        "Answer concisely. If knowledge base context is provided, prefer it; "
        "cite entries like [1], [2]. If you don't know, say so."
    )
    session_id = "chat-session"
    llm = new_chat(session_id, system + ("\n\n" + context_block if context_block else ""))

    # Replay short history so multi-turn works without persisting on the LLM side
    for m in (body.history or [])[-10:]:
        role = m.get("role")
        text = (m.get("content") or "").strip()
        if role in ("user", "assistant") and text:
            # Send each prior user message; the lib only takes user messages, so we
            # fold prior assistant replies into the user prompt as light context.
            pass

    # Build a single prompt with light recap (LlmChat manages its own history per session)
    if body.history:
        recap_lines = []
        for m in body.history[-6:]:
            who = "User" if m.get("role") == "user" else "Assistant"
            recap_lines.append(f"{who}: {(m.get('content') or '').strip()[:400]}")
        recap = "Recent conversation:\n" + "\n".join(recap_lines) + "\n\nNew user message:\n"
        user_text = recap + body.message
    else:
        user_text = body.message

    try:
        reply = await llm.send_message(UserMessage(text=user_text))
    except Exception as e:
        raise HTTPException(502, f"LLM error: {e}")
    return {"reply": reply, "context_used": len(ctx_docs)}


@api.post("/query")
async def query_kb(body: QueryBody):
    docs = await search_kb(body.query, limit=10)
    results = []
    for d in docs:
        results.append({
            "id": d.get("id"),
            "topic": d.get("topic"),
            "summary": d.get("summary", "")[:600],
            "source_url": d.get("source_url"),
            "tags": d.get("tags", []),
            "category": d.get("category"),
        })
    return {"results": results, "result_count": len(results)}


@api.post("/research")
async def research(body: ResearchBody):
    return await do_research(body.topic.strip(), body.category)


@api.post("/code")
async def code(body: CodeBody):
    system = (
        f"You generate clean, working {body.language} code. "
        "Reply with ONLY the code — no markdown fences, no prose explanations."
    )
    try:
        out = await llm_oneshot(system, body.prompt)
    except Exception as e:
        raise HTTPException(502, f"LLM error: {e}")
    # Strip accidental triple-fence wrappers
    out = re.sub(r"^```[a-zA-Z0-9]*\n", "", out.strip())
    out = re.sub(r"\n```$", "", out)
    return {"code": out, "language": body.language}


# ── Routes: Admin ────────────────────────────────────────────────────────
@api.get("/knowledge")
async def list_kb():
    docs = await kb.find({}, {"_id": 0}).sort("created_at", -1).limit(200).to_list(200)
    return {"entries": docs, "count": len(docs)}


@api.post("/knowledge/import", dependencies=[Depends(require_admin)])
async def import_files(body: ImportBody):
    saved, errors = [], []
    for f in body.files:
        try:
            text = (f.content or "").strip()
            if not text:
                errors.append({"name": f.name, "error": "empty"})
                continue
            ext = (f.name.rsplit(".", 1)[-1] if "." in f.name else "").lower()
            entry = {
                "id": str(uuid.uuid4()),
                "topic": f.name,
                "summary": re.sub(r"\s+", " ", text)[:500],
                "content": text[:200_000],
                "category": f.category or "Imported",
                "source_url": None,
                "tags": list({*(f.tags or []), ext, "imported"} - {""}),
                "added_by": "import",
                "created_at": _now(),
            }
            await kb.insert_one(dict(entry))
            saved.append({"name": f.name, "id": entry["id"]})
        except Exception as e:
            errors.append({"name": f.name, "error": str(e)})
    return {"saved": saved, "errors": errors}


@api.delete("/knowledge/{entry_id}", dependencies=[Depends(require_admin)])
async def delete_kb(entry_id: str):
    r = await kb.delete_one({"id": entry_id})
    if r.deleted_count == 0:
        raise HTTPException(404, "Not found")
    return {"deleted": entry_id}


@api.get("/queue")
async def list_queue():
    docs = await queue.find({}, {"_id": 0}).sort("created_at", -1).limit(200).to_list(200)
    return docs


@api.post("/queue", dependencies=[Depends(require_admin)])
async def add_queue(body: QueueBody):
    item = {
        "id": str(uuid.uuid4()),
        "topic": body.topic.strip(),
        "category": body.category,
        "priority": body.priority,
        "status": "pending",
        "added_by": "user",
        "created_at": _now(),
        "last_attempt": None,
        "error": None,
    }
    await queue.insert_one(dict(item))
    return item


@api.delete("/queue/{item_id}", dependencies=[Depends(require_admin)])
async def delete_queue(item_id: str):
    r = await queue.delete_one({"id": item_id})
    if r.deleted_count == 0:
        raise HTTPException(404, "Not found")
    return {"deleted": item_id}


@api.post("/queue/run", dependencies=[Depends(require_admin)])
async def run_queue_now():
    n = await process_queue()
    return {"processed": n}


# ── Auto-research scheduler ──────────────────────────────────────────────
async def process_queue() -> int:
    """Process up to 5 pending queue items, oldest first."""
    pending = await queue.find({"status": "pending"}, {"_id": 0}).sort("created_at", 1).limit(5).to_list(5)
    processed = 0
    for item in pending:
        try:
            await queue.update_one(
                {"id": item["id"]},
                {"$set": {"status": "running", "last_attempt": _now()}},
            )
            await do_research(item["topic"], item.get("category", "General"))
            await queue.update_one(
                {"id": item["id"]},
                {"$set": {"status": "done", "last_attempt": _now(), "error": None}},
            )
            processed += 1
        except Exception as e:
            log.exception("queue item failed")
            await queue.update_one(
                {"id": item["id"]},
                {"$set": {"status": "failed", "last_attempt": _now(), "error": str(e)[:300]}},
            )
    return processed


scheduler: Optional[AsyncIOScheduler] = None


@app.on_event("startup")
async def on_startup():
    global scheduler
    await seed_admin()
    await kb.create_index("id", unique=True)
    await kb.create_index([("topic", "text"), ("summary", "text"), ("content", "text")])
    await queue.create_index("id", unique=True)
    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(process_queue, "interval", hours=6, id="auto_research",
                      next_run_time=datetime.now(timezone.utc) + timedelta(minutes=2))
    scheduler.start()
    log.info("Midget jr. backend up. Auto-research every 6h.")


@app.on_event("shutdown")
async def on_shutdown():
    if scheduler:
        scheduler.shutdown(wait=False)
    client.close()


# ── Wire ─────────────────────────────────────────────────────────────────
app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)
