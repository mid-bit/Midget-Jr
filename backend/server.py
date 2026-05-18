"""Midget jr. backend — FastAPI + MongoDB + free LLM (Gemini or Groq).

Provider-agnostic: uses the OpenAI Python client against Gemini's or Groq's
OpenAI-compatible endpoints. Switch via LLM_PROVIDER env (gemini | groq).
"""
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
from openai import AsyncOpenAI
from pydantic import BaseModel, Field
from starlette.middleware.cors import CORSMiddleware

# ── Setup ────────────────────────────────────────────────────────────────
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
JWT_SECRET = os.environ["JWT_SECRET"]
ADMIN_PASSWORD = os.environ["ADMIN_PASSWORD"]
LEARNING_PASSWORD = os.environ.get("LEARNING_PASSWORD", "AI-0verlord")

LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "gemini").lower()
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.1-8b-instant")

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/"
GROQ_BASE = "https://api.groq.com/openai/v1"

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]
kb = db.knowledge_entries
queue = db.research_queue
config = db.app_config
shares = db.shares
chats = db.chat_messages
qlog = db.question_log

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
    session_id: Optional[str] = None
    username: Optional[str] = None


class ShareBody(BaseModel):
    question: str
    answer: str
    mode: str = "chat"
    context_used: int = 0
    username: Optional[str] = None


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
    behavior: bool = False
    owner: Optional[str] = None


class ImportBody(BaseModel):
    files: List[ImportItem]


class DirectModeBody(BaseModel):
    enabled: bool


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
def _llm_config() -> tuple[str, str, str]:
    """Return (api_key, base_url, model) for the configured provider."""
    if LLM_PROVIDER == "gemini":
        if not GEMINI_API_KEY:
            raise RuntimeError(
                "GEMINI_API_KEY is empty. Grab one free at https://aistudio.google.com/apikey "
                "and add it to /app/backend/.env (no credit card needed)."
            )
        return GEMINI_API_KEY, GEMINI_BASE, GEMINI_MODEL
    if LLM_PROVIDER == "groq":
        if not GROQ_API_KEY:
            raise RuntimeError(
                "GROQ_API_KEY is empty. Grab one free at https://console.groq.com/keys "
                "and add it to /app/backend/.env (no credit card needed)."
            )
        return GROQ_API_KEY, GROQ_BASE, GROQ_MODEL
    raise RuntimeError(f"Unknown LLM_PROVIDER '{LLM_PROVIDER}' — use 'gemini' or 'groq'.")


def llm_client() -> tuple[AsyncOpenAI, str]:
    api_key, base_url, model = _llm_config()
    return AsyncOpenAI(api_key=api_key, base_url=base_url, timeout=60.0), model


async def llm_chat(messages: List[dict], temperature: float = 0.7) -> str:
    client, model = llm_client()
    r = await client.chat.completions.create(
        model=model, messages=messages, temperature=temperature
    )
    return (r.choices[0].message.content or "").strip()


async def llm_oneshot(system: str, prompt: str) -> str:
    return await llm_chat([
        {"role": "system", "content": system},
        {"role": "user", "content": prompt},
    ])


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
    model = GEMINI_MODEL if LLM_PROVIDER == "gemini" else GROQ_MODEL
    key_ok = bool(GEMINI_API_KEY if LLM_PROVIDER == "gemini" else GROQ_API_KEY)
    return {
        "app": "Midget jr.",
        "ok": True,
        "provider": LLM_PROVIDER,
        "model": model,
        "key_configured": key_ok,
    }


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

    # Behavior files — explicit instructions that change the bot's behavior
    behavior_docs = await kb.find(
        {"$or": [{"behavior": True}, {"category": "Behavior"}, {"tags": "behavior"}]},
        {"_id": 0, "content": 1, "topic": 1},
    ).limit(10).to_list(10)
    behavior_block = ""
    if behavior_docs:
        joined = "\n\n".join(f"### {d.get('topic','behavior')}\n{(d.get('content') or '')[:3000]}" for d in behavior_docs)
        behavior_block = "ADMIN-SET BEHAVIOR RULES (follow these):\n\n" + joined

    # Per-user style mimicry — pick this user's longest non-behavior files as style samples
    style_block = ""
    if body.username:
        uname = _clean_username(body.username)
        owned = await kb.find(
            {"owner": uname, "behavior": {"$ne": True}},
            {"_id": 0, "content": 1, "topic": 1},
        ).to_list(50)
        owned = [d for d in owned if (d.get("content") or "").strip()]
        owned.sort(key=lambda d: len(d.get("content") or ""), reverse=True)
        if owned:
            samples = "\n\n---\n\n".join((d.get("content") or "")[:800] for d in owned[:2])
            style_block = (
                f"STYLE GUIDE — this user ({uname}) writes like this. Match their voice, "
                "vocabulary, sentence rhythm, common typos and quirks. Don't mention you're imitating:\n\n"
                + samples
            )

    # Direct mode (admin toggle) — drop disclaimers/refusals on edgy-but-legitimate topics
    direct = await _get_direct_mode()
    if direct:
        base_persona = (
            "You are Midget jr. in DIRECT MODE. The user is an adult who wants real answers. "
            "Skip disclaimers, warnings, and 'as an AI I cannot' phrases. Don't lecture. Don't moralize. "
            "Engage directly with mature, dark, taboo, controversial, profane, fictional, or roleplay topics. "
            "Use profanity if it fits. Engage with hypotheticals, dark fiction, adult themes, drug/weapon "
            "information for educational or harm-reduction context, controversial opinions, and edgy humor. "
            "ABSOLUTE RED LINES (refuse only these, briefly, then offer to discuss the topic instead): "
            "(1) step-by-step instructions to physically harm a specific real person, "
            "(2) synthesis instructions for weapons capable of mass casualties (bio/chem/nuclear), "
            "(3) sexual content involving minors. "
            "Everything else: just answer. If KB context is provided, cite it like [1], [2]."
        )
    else:
        base_persona = (
            "You are Midget jr., a curious, friendly self-growing knowledge bot. "
            "Answer concisely. If knowledge base context is provided, prefer it; "
            "cite entries like [1], [2]. If you don't know, say so."
        )

    parts = [base_persona]
    if behavior_block:
        parts.append(behavior_block)
    if style_block:
        parts.append(style_block)
    if context_block:
        parts.append(context_block)
    system = "\n\n".join(parts)

    messages: list[dict] = [{"role": "system", "content": system}]
    for m in (body.history or [])[-10:]:
        role = m.get("role")
        text = (m.get("content") or "").strip()
        if role in ("user", "assistant") and text:
            messages.append({"role": role, "content": text[:2000]})
    messages.append({"role": "user", "content": body.message})

    try:
        reply = await llm_chat(messages)
    except Exception as e:
        raise HTTPException(502, f"LLM error: {e}")

    asyncio.create_task(_log_exchange(body.session_id, body.username, body.message, reply, len(ctx_docs)))
    asyncio.create_task(_maybe_auto_promote(body.message))

    return {"reply": reply, "context_used": len(ctx_docs), "direct_mode": direct}


async def _get_direct_mode() -> bool:
    try:
        doc = await config.find_one({"_id": "direct_mode"})
        return bool(doc and doc.get("enabled"))
    except Exception:
        return False


def _clean_username(u: Optional[str]) -> str:
    """Trim, dedupe whitespace, cap length, fall back to 'guest'."""
    if not u:
        return "guest"
    u = re.sub(r"\s+", " ", str(u)).strip()
    u = re.sub(r"[^\w \-_.]", "", u)  # safe chars only
    return (u[:40] or "guest")


async def _log_exchange(session_id: Optional[str], username: Optional[str],
                         user_msg: str, bot_reply: str, ctx: int) -> None:
    """Persist a chat exchange in MongoDB for cross-device history + admin oversight."""
    try:
        await chats.insert_one(dict({
            "id": str(uuid.uuid4()),
            "session_id": session_id or None,
            "username": _clean_username(username),
            "user_message": user_msg[:2000],
            "bot_reply": bot_reply[:4000],
            "context_used": ctx,
            "created_at": _now(),
        }))
    except Exception as e:
        log.warning(f"chat log failed: {e}")


def _question_keyset(q: str) -> List[str]:
    """Return up to 4 distinctive tokens (sorted) used as the question's fingerprint."""
    toks = re.findall(r"[A-Za-z0-9]{4,}", q.lower())
    stop = {"what", "when", "where", "which", "while", "with", "have", "this", "that",
            "the", "and", "for", "you", "your", "are", "from", "tell", "about", "does",
            "did", "into", "they", "them", "how", "why", "who", "can", "should", "is",
            "in", "of", "on", "to", "a", "an", "be", "or"}
    keep = sorted({t for t in toks if t not in stop})
    return keep[:4]


async def _maybe_auto_promote(user_msg: str) -> None:
    """Count similar-keyword questions; queue a research topic when >=3 are seen."""
    keys = _question_keyset(user_msg)
    if not keys:
        return
    key = " ".join(keys)
    try:
        doc = await qlog.find_one_and_update(
            {"_id": key},
            {"$inc": {"count": 1},
             "$set": {"last_seen": _now()},
             "$setOnInsert": {"first_seen": _now(), "sample_question": user_msg[:300], "promoted": False}},
            upsert=True,
            return_document=True,
        )
        if not doc or doc.get("promoted"):
            return
        if doc.get("count", 0) >= 3:
            topic = doc.get("sample_question") or user_msg
            # avoid duplicate queue items
            already = await queue.find_one({"topic": topic, "status": {"$in": ["pending", "running", "done"]}})
            if not already:
                await queue.insert_one(dict({
                    "id": str(uuid.uuid4()),
                    "topic": topic[:200],
                    "category": "General",
                    "priority": 1,
                    "status": "pending",
                    "added_by": "auto",
                    "created_at": _now(),
                    "last_attempt": None,
                    "error": None,
                }))
                log.info(f"Auto-promoted topic to research queue: {topic[:80]!r}")
            await qlog.update_one({"_id": key}, {"$set": {"promoted": True}})
    except Exception as e:
        log.warning(f"auto-promote failed: {e}")


@api.get("/chat/history/{session_id}")
async def chat_history(session_id: str, limit: int = 200):
    """Return persisted chat exchanges for a given session_id (cross-device)."""
    if not session_id or len(session_id) > 80:
        raise HTTPException(400, "Bad session_id")
    cursor = chats.find({"session_id": session_id}, {"_id": 0}).sort("created_at", -1).limit(min(limit, 500))
    docs = await cursor.to_list(length=limit)
    docs.reverse()  # chronological order
    return {"messages": docs, "count": len(docs)}


# ── Shares ─────────────────────────────────────────────────────────────
def _short_id(n: int = 8) -> str:
    import secrets
    import string
    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(n))


@api.post("/share")
async def create_share(body: ShareBody):
    """Anyone can pin a Q/A pair — returns a short id used in ?share= URLs."""
    sid = _short_id()
    # collision-safe loop
    for _ in range(3):
        if not await shares.find_one({"id": sid}):
            break
        sid = _short_id()
    doc = {
        "id": sid,
        "question": body.question[:2000],
        "answer": body.answer[:8000],
        "mode": body.mode[:20] if body.mode else "chat",
        "context_used": int(body.context_used or 0),
        "username": _clean_username(body.username),
        "created_at": _now(),
    }
    await shares.insert_one(dict(doc))
    return {"id": sid}


@api.get("/share/{share_id}")
async def get_share(share_id: str):
    if not re.fullmatch(r"[a-z0-9]{4,16}", share_id or ""):
        raise HTTPException(404, "Not found")
    doc = await shares.find_one({"id": share_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Not found")
    return doc


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
            extra_tags = []
            if f.behavior:
                extra_tags.append("behavior")
            if f.owner:
                extra_tags.append(f"owner:{_clean_username(f.owner)}")
            entry = {
                "id": str(uuid.uuid4()),
                "topic": f.name,
                "summary": re.sub(r"\s+", " ", text)[:500],
                "content": text[:200_000],
                "category": "Behavior" if f.behavior else (f.category or "Imported"),
                "source_url": None,
                "tags": list({*(f.tags or []), ext, "imported", *extra_tags} - {""}),
                "added_by": "import",
                "behavior": bool(f.behavior),
                "owner": _clean_username(f.owner) if f.owner else None,
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


@api.get("/direct-mode")
async def direct_mode_status():
    return {"enabled": await _get_direct_mode()}


@api.post("/admin/direct-mode", dependencies=[Depends(require_admin)])
async def admin_set_direct_mode(body: DirectModeBody):
    await config.update_one(
        {"_id": "direct_mode"},
        {"$set": {"enabled": bool(body.enabled), "updated_at": _now()}},
        upsert=True,
    )
    return {"enabled": bool(body.enabled)}


# ── Admin oversight endpoints ───────────────────────────────────────────
@api.get("/admin/chat-log", dependencies=[Depends(require_admin)])
async def admin_chat_log(limit: int = 200, username: Optional[str] = None):
    """Paginated reverse-chronological feed of every visitor question+answer."""
    q = {}
    if username:
        q["username"] = _clean_username(username)
    cursor = chats.find(q, {"_id": 0}).sort("created_at", -1).limit(min(max(limit, 1), 500))
    docs = await cursor.to_list(length=limit)
    return {"messages": docs, "count": len(docs)}


@api.get("/admin/visitors", dependencies=[Depends(require_admin)])
async def admin_visitors():
    """Aggregate visitors with their question count and last-seen timestamp."""
    pipeline = [
        {"$group": {
            "_id": "$username",
            "count": {"$sum": 1},
            "last_seen": {"$max": "$created_at"},
            "first_seen": {"$min": "$created_at"},
        }},
        {"$sort": {"last_seen": -1}},
        {"$limit": 200},
    ]
    docs = await chats.aggregate(pipeline).to_list(length=200)
    visitors = [{
        "username": d["_id"] or "guest",
        "count": d["count"],
        "last_seen": d["last_seen"],
        "first_seen": d["first_seen"],
    } for d in docs]
    return {"visitors": visitors, "count": len(visitors)}


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
    await kb.create_index("owner")
    await kb.create_index("behavior")
    await kb.create_index([("topic", "text"), ("summary", "text"), ("content", "text")])
    await queue.create_index("id", unique=True)
    await shares.create_index("id", unique=True)
    await chats.create_index("session_id")
    await chats.create_index("created_at")
    await qlog.create_index("count")
    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(process_queue, "interval", hours=6, id="auto_research",
                      next_run_time=datetime.now(timezone.utc) + timedelta(minutes=2))
    scheduler.start()
    log.info(f"Midget jr. backend up. Provider={LLM_PROVIDER}. Auto-research every 6h.")


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
