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
from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorClient
from openai import AsyncOpenAI, RateLimitError
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse

# ── Setup ────────────────────────────────────────────────────────────────
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
JWT_SECRET = os.environ["JWT_SECRET"]
ADMIN_PASSWORD = os.environ["ADMIN_PASSWORD"]
LEARNING_PASSWORD = os.environ.get("LEARNING_PASSWORD", "AI-0verlord")

LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "gemini").lower()
RESEARCH_LLM_PROVIDER = os.environ.get("RESEARCH_LLM_PROVIDER", "").strip().lower() or None
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.1-8b-instant")
GROQ_VISION_MODEL = os.environ.get("GROQ_VISION_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct")

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
access_codes = db.access_codes
bug_reports = db.bug_reports
exemplars = db.exemplars
usernames = db.usernames
self_edits = db.self_edits      # audit log of admin self-edits (file backups + diffs)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")
log = logging.getLogger("midgetjr")

app = FastAPI(title="Midget jr.")
api = APIRouter(prefix="/api")

# Rate limiting — single global cap protects free-tier LLM keys from abuse.
# 60/min/IP is generous for humans and stops most bots/scripts cold.
limiter = Limiter(key_func=get_remote_address, default_limits=["60/minute"],
                  headers_enabled=True)
app.state.limiter = limiter
app.add_middleware(SlowAPIMiddleware)


@app.exception_handler(RateLimitExceeded)
async def _ratelimit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429,
        content={"detail": "Slow down — too many requests in a row. Try again in a moment."},
    )

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
    citation_style: Optional[str] = "none"   # none | mla | apa | chicago | ieee | numbered
    image: Optional[str] = None              # data URL of an attached image (vision)


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


class AccessModeBody(BaseModel):
    enabled: bool


class CreateCodeBody(BaseModel):
    code: Optional[str] = None          # admin-supplied custom code; otherwise auto-generated
    label: Optional[str] = None
    expires_in_days: Optional[int] = 30
    max_uses: Optional[int] = None
    complexity: Optional[str] = "weak"  # "weak" | "strong"


class WriteBody(BaseModel):
    """Ghost-typer: bot writes prose at the user's cursor position inside a document."""
    instruction: str
    doc_before: str = ""
    doc_after: str = ""
    tone: Optional[str] = None
    max_chars: int = 1200
    humanize: bool = False              # ask LLM for human-style prose (contractions, fillers, varied length)


class RewriteBody(BaseModel):
    """Rewrite a selected slice of a document in a target tone, keeping it in-place."""
    selection: str
    tone: str = "clearer"
    instruction: Optional[str] = None
    doc_before: str = ""
    doc_after: str = ""
    max_chars: int = 2000
    humanize: bool = False


class SelfProposeBody(BaseModel):
    path: str
    instruction: str


class SelfApplyBody(BaseModel):
    path: str
    new_content: str
    summary: Optional[str] = None


class GithubSetupBody(BaseModel):
    pat: str                # GitHub personal access token (classic or fine-grained with repo write)
    repo: str               # "owner/repo"
    branch: str = "main"
    author_name: Optional[str] = "Midget jr."
    author_email: Optional[str] = "midget-jr@local"


class GithubPushBody(BaseModel):
    message: str = "Midget jr. self-edit"


class AgentBody(BaseModel):
    """One conversational turn with the AI Dev agent. The agent can read files,
    propose+apply edits, and push to GitHub via tool calls."""
    message: str
    history: List[dict] = Field(default_factory=list)
    auto_apply: bool = False    # if True, agent applies edits without separate admin click


class GuestAuthBody(BaseModel):
    code: str


class UsernameClaimBody(BaseModel):
    name: str
    session_id: str


class BugReportBody(BaseModel):
    description: str
    steps: str
    screenshot: Optional[str] = None   # data URL, max ~500KB
    username: Optional[str] = None


class LearningUnlockBody(BaseModel):
    password: str


class LearningRunBody(BaseModel):
    limit: int = 20
    min_score: int = 7


class TeachBody(BaseModel):
    """A user-flagged exchange ("👍 Teach Midget"). We re-judge it and (if good)
    save it as a high-priority exemplar."""
    question: str
    answer: str
    username: Optional[str] = None
    session_id: Optional[str] = None
    chat_id: Optional[str] = None
    citation_style: Optional[str] = "none"


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


async def maybe_guest(authorization: Optional[str] = Header(None)) -> dict:
    """Gate public endpoints behind a code when private-mode is on.
    Returns the decoded payload or a dummy for open access. Admin tokens pass through."""
    mode = await config.find_one({"_id": "access_mode"})
    if not mode or not mode.get("require_guest_pass"):
        return {"role": "open"}
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Guest access code required")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired guest token")
    if payload.get("role") not in ("admin", "guest"):
        raise HTTPException(status_code=403, detail="Forbidden")
    return payload


def make_guest_token(code: str, expires_at_iso: Optional[str]) -> str:
    payload = {
        "role": "guest",
        "code": code,
        "iat": int(datetime.now(timezone.utc).timestamp()),
    }
    if expires_at_iso:
        # mirror code's expiration on the JWT
        try:
            exp_dt = datetime.fromisoformat(expires_at_iso.replace("Z", "+00:00"))
            payload["exp"] = int(exp_dt.timestamp())
        except Exception:
            payload["exp"] = int((datetime.now(timezone.utc) + timedelta(days=7)).timestamp())
    else:
        payload["exp"] = int((datetime.now(timezone.utc) + timedelta(days=7)).timestamp())
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def make_learning_token() -> str:
    payload = {
        "role": "learning",
        "iat": int(datetime.now(timezone.utc).timestamp()),
        "exp": int((datetime.now(timezone.utc) + timedelta(days=30)).timestamp()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


async def require_learning(authorization: Optional[str] = Header(None)) -> bool:
    """Either an admin or learning-mode token unlocks Learning endpoints."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Learning token required")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    if payload.get("role") not in ("admin", "learning"):
        raise HTTPException(status_code=403, detail="Forbidden")
    return True


# ── LLM helpers ──────────────────────────────────────────────────────────
def _llm_config(provider: Optional[str] = None) -> tuple[str, str, str]:
    """Return (api_key, base_url, model) for the requested provider.
    Falls back gracefully if the override provider has no key (so Gemini-only
    setups don't break when RESEARCH_LLM_PROVIDER=groq but groq key is empty)."""
    p = (provider or LLM_PROVIDER).lower()
    if p == "gemini":
        if not GEMINI_API_KEY:
            # If we were asked for an override and it's missing, fall back to default.
            if provider and provider.lower() != LLM_PROVIDER and LLM_PROVIDER != "gemini":
                return _llm_config(LLM_PROVIDER)
            raise RuntimeError(
                "GEMINI_API_KEY is empty. Grab one free at https://aistudio.google.com/apikey "
                "and add it to /app/backend/.env (no credit card needed)."
            )
        return GEMINI_API_KEY, GEMINI_BASE, GEMINI_MODEL
    if p == "groq":
        if not GROQ_API_KEY:
            if provider and provider.lower() != LLM_PROVIDER and LLM_PROVIDER != "groq":
                return _llm_config(LLM_PROVIDER)
            raise RuntimeError(
                "GROQ_API_KEY is empty. Grab one free at https://console.groq.com/keys "
                "and add it to /app/backend/.env (no credit card needed)."
            )
        return GROQ_API_KEY, GROQ_BASE, GROQ_MODEL
    raise RuntimeError(f"Unknown LLM provider '{p}' — use 'gemini' or 'groq'.")


def llm_client(provider: Optional[str] = None) -> tuple[AsyncOpenAI, str]:
    api_key, base_url, model = _llm_config(provider)
    return AsyncOpenAI(api_key=api_key, base_url=base_url, timeout=60.0), model


async def llm_chat(messages: List[dict], temperature: float = 0.7,
                   provider: Optional[str] = None) -> str:
    cli, model = llm_client(provider)
    try:
        r = await cli.chat.completions.create(
            model=model, messages=messages, temperature=temperature
        )
    except RateLimitError as e:
        used_provider = (provider or LLM_PROVIDER).lower()
        alt = "groq" if used_provider == "gemini" else "gemini"
        raise HTTPException(
            status_code=503,
            detail=(
                f"⏳ {used_provider.title()} daily quota reached. "
                f"Paste a {alt.title()} key into backend/.env "
                f"({'GROQ_API_KEY' if alt=='groq' else 'GEMINI_API_KEY'}) "
                "or wait for the daily reset."
            ),
        ) from e
    return (r.choices[0].message.content or "").strip()


# ── Aggressive rule-based humanizer (post-LLM) ───────────────────────
import random as _random  # noqa: E402

# High-frequency "AI-favored" verbs/phrases → casual replacements.
# Each value is a list — we pick randomly so the output isn't deterministic.
AI_SWAPS: dict[str, list[str]] = {
    # nouns
    "individuals": ["people", "folks", "everyone"],
    "individual":  ["person", "someone"],
    "personnel":   ["staff", "people"],
    "utilization": ["use"],
    "utilization,": ["use,"],
    # verbs
    "utilize":     ["use"],
    "utilizes":    ["uses"],
    "utilized":    ["used"],
    "utilizing":   ["using"],
    "facilitate":  ["help", "make easier"],
    "facilitates": ["helps"],
    "facilitating":["helping"],
    "demonstrate": ["show"],
    "demonstrates":["shows"],
    "demonstrated":["showed"],
    "leverage":    ["use", "lean on"],
    "leverages":   ["uses"],
    "leveraging":  ["using"],
    "harness":     ["use", "tap"],
    "harnessing":  ["tapping into"],
    "obtain":      ["get"],
    "obtained":    ["got"],
    "acquire":     ["get", "pick up"],
    "acquired":    ["got", "picked up"],
    "purchase":    ["buy"],
    "purchased":   ["bought"],
    "endeavor":    ["try"],
    "endeavors":   ["tries"],
    "commence":    ["start", "kick off"],
    "commences":   ["starts"],
    "commenced":   ["started"],
    "terminate":   ["end", "stop"],
    "implement":   ["do", "set up"],
    "implemented": ["did", "set up"],
    "implementing":["doing", "setting up"],
    "establish":   ["set up", "make"],
    "established": ["set up", "made"],
    "establishes": ["sets up"],
    "incorporate": ["add", "mix in"],
    "incorporates":["adds"],
    "incorporated":["added", "mixed in"],
    "incorporating":["adding", "fitting in"],
    "showcase":    ["show off"],
    "showcased":   ["showed off"],
    # adjectives
    "numerous":    ["a lot of", "loads of", "tons of"],
    "various":     ["different"],
    "significant": ["big", "real"],
    "substantial": ["big"],
    "considerable":["pretty big", "decent"],
    "crucial":     ["key", "huge", "matters"],
    "essential":   ["a must", "key"],
    "imperative":  ["a must", "gotta"],
    "vital":       ["key", "matters"],
    "optimal":     ["best"],
    "remarkable":  ["wild", "pretty cool"],
    "exceptional": ["really good"],
    "comprehensive":["full", "all-in-one"],
    "extensive":   ["a lot of", "long"],
    "intricate":   ["complex", "tangled"],
    "multifaceted":["many-sided"],
    "robust":      ["solid", "tough"],
    "seamless":    ["smooth"],
    # adverbs
    "significantly":["a lot", "way more"],
    "substantially":["a lot"],
    "considerably": ["a fair bit"],
    "subsequently": ["then", "after that"],
    "consequently": ["so", "as a result"],
    "additionally": ["also", "plus"],
    "furthermore":  ["plus", "also"],
    "moreover":     ["plus", "and"],
    "however,":     ["but", "though"],
    "however":      ["but"],
    "thus":         ["so"],
    "therefore":    ["so"],
    "hence":        ["so"],
    "essentially":  ["basically"],
    "ultimately":   ["in the end"],
    # phrases
    "in addition,":     ["plus,", "also,"],
    "in addition":      ["also"],
    "in conclusion,":   ["so,", "anyway,"],
    "in conclusion":    ["so"],
    "to sum up,":       ["so,", "bottom line,"],
    "in summary,":      ["basically,", "so,"],
    "in order to":      ["to"],
    "due to the fact that": ["because"],
    "for the purpose of":   ["to"],
    "with regard to":   ["about"],
    "with regards to":  ["about"],
    "in regards to":    ["about"],
    "regarding":        ["about"],
    "concerning":       ["about"],
    "it is important to note that": ["heads up:"],
    "it should be noted that":      ["worth flagging:"],
    "it is worth noting that":      ["worth saying:"],
    "in today's fast-paced world":  ["these days"],
    "in the realm of":  ["in"],
    "in the world of":  ["in"],
    "when it comes to": ["with"],
    "a plethora of":    ["a lot of", "tons of"],
    "a myriad of":      ["loads of"],
    "myriad":           ["a lot of"],
    "delve into":       ["look at", "dig into"],
    "dive into":        ["dig into"],
    "embark on":        ["start"],
    "navigate":         ["work through"],
    "navigating":       ["working through"],
    "landscape":        ["scene", "world"],
    "ever-evolving":    ["changing"],
    "ever-changing":    ["changing"],
    "paradigm shift":   ["big change"],
    "paradigm":         ["model"],
    "holistic":         ["whole"],
    "synergy":          ["fit", "combo"],
    "leverage the power of": ["use"],
    "harness the power of":  ["use"],
    "unleash the power of":  ["unlock"],
    "unlock the potential of":["get the most out of"],
    "elevate":          ["lift"],
    "elevates":         ["lifts"],
    "tapestry":         ["mix", "blend"],
    "foster":           ["build", "grow"],
    "fostering":        ["building"],
    "cultivate":        ["grow", "build"],
    "cultivating":      ["growing"],
    "garner":           ["get", "pick up"],
    "vibrant":          ["lively"],
    "bustling":         ["busy"],
    "captivating":      ["catchy", "gripping"],
    "breathtaking":     ["wild", "incredible"],
    "picture this:":    ["okay so:", "here's the scene:"],
    "picture this":     ["imagine"],
    "a testament to":   ["proof of"],
    "a beacon of":      ["a spot of"],
    "at its core":      ["really"],
    "in essence":       ["basically"],
    # contraction backfills (catch what the LLM missed)
    "do not": ["don't"],
    "does not": ["doesn't"],
    "did not": ["didn't"],
    "is not": ["isn't"],
    "are not": ["aren't"],
    "was not": ["wasn't"],
    "were not": ["weren't"],
    "will not": ["won't"],
    "would not": ["wouldn't"],
    "could not": ["couldn't"],
    "should not": ["shouldn't"],
    "cannot": ["can't"],
    "I am ": ["I'm "],
    "you are ": ["you're "],
    "they are ": ["they're "],
    "we are ": ["we're "],
    "it is ": ["it's "],
    "that is ": ["that's "],
    "there is ": ["there's "],
    "I have ": ["I've "],
    "you have ": ["you've "],
    "they have ": ["they've "],
    "we have ": ["we've "],
    "I will ": ["I'll "],
    "you will ": ["you'll "],
    "they will ": ["they'll "],
    "we will ": ["we'll "],
    "I would ": ["I'd "],
    "you would ": ["you'd "],
}


def _humanize_post(text: str) -> str:
    """Rule-based post-processor: scrambles the LLM's fingerprint by
    (a) swapping AI-favored words for casual ones,
    (b) injecting tiny human filler words,
    (c) splitting one long sentence into fragments,
    (d) varying punctuation a bit.
    Pure mechanics — no LLM call."""
    if not text or len(text) < 20:
        return text
    out = text

    # 1) Word/phrase swaps — case-insensitive, preserve original capitalization
    for needle, options in AI_SWAPS.items():
        if needle.lower() not in out.lower():
            continue
        def repl(m, opts=options):
            picked = _random.choice(opts)
            orig = m.group(0)
            # match capitalization of first character
            if orig and orig[0].isupper() and picked:
                picked = picked[0].upper() + picked[1:]
            return picked
        pattern = re.compile(re.escape(needle), re.IGNORECASE)
        out = pattern.sub(repl, out, count=2)  # cap at 2 swaps per phrase

    # 2) Inject 1-2 sparing fillers at sentence breaks (~10% of sentences)
    fillers = ["honestly,", "I mean,", "look,", "sort of,", "kind of,",
               "well,", "you know,", "the thing is,", "okay so,"]
    sentences = re.split(r"(?<=[.!?])\s+", out)
    injected = 0
    for i, s in enumerate(sentences):
        if injected >= 2:
            break
        # Skip first sentence (don't open with a filler), and very short ones
        if i == 0 or len(s) < 30:
            continue
        if _random.random() < 0.18 and not re.match(r"^(honestly|i mean|look|sort of|kind of|well|you know|okay so|the thing)", s.lower()):
            filler = _random.choice(fillers)
            # capitalize filler if it starts the sentence (it does here)
            filler_cap = filler[0].upper() + filler[1:]
            # Insert after the leading word + space if sentence starts with a short opener like "And"/"But"
            first_word_match = re.match(r"^(And |But |So |Plus |Also )", s)
            if first_word_match:
                head = first_word_match.group(0)
                s = head + filler_cap.lower() + " " + s[len(head):].lstrip()
            else:
                s = filler_cap + " " + s[0].lower() + s[1:] if s and s[0].isalpha() else filler_cap + " " + s
            sentences[i] = s
            injected += 1
    out = " ".join(sentences)

    # 3) Split ONE very long sentence (>30 words) into two: pick a conjunction
    long_sents = [(i, s) for i, s in enumerate(sentences) if len(s.split()) > 30]
    if long_sents:
        idx, s = _random.choice(long_sents)
        m = re.search(r",?\s+(and|but|because|so)\s+", s)
        if m and m.start() > 40:
            new = s[:m.start()].rstrip(",") + ". " + m.group(1).capitalize() + s[m.end()-1:]
            sentences[idx] = new
            out = " ".join(sentences)

    # 4) Drop ONE Oxford comma (X, Y, and Z → X, Y and Z) at most once
    out = re.sub(r"(\b\w+,\s+\w+),\s+(and\s+\w+)", r"\1 \2", out, count=1)

    # 5) Lowercase the first letter of ONE sentence that comes after a comma splice
    #    (mimics a casual writer who forgot to capitalize)
    # — Skipped: too risky for false positives. Move on.

    # 6) Add ONE em dash interjection somewhere natural (only if there isn't one already)
    if "—" not in out and "–" not in out:
        # Find a comma after a 4+ word clause and 50% chance swap it for ' — '
        m = re.search(r"(\w+\s+\w+\s+\w+\s+\w+),\s+", out)
        if m and _random.random() < 0.5:
            out = out[:m.start(0)] + m.group(1) + " — " + out[m.end(0):]

    return out


async def llm_oneshot(system: str, prompt: str, provider: Optional[str] = None,
                      temperature: float = 0.7) -> str:
    cli, model = llm_client(provider)
    try:
        r = await cli.chat.completions.create(
            model=model, temperature=temperature,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
        )
    except RateLimitError as e:
        used_provider = (provider or LLM_PROVIDER).lower()
        alt = "groq" if used_provider == "gemini" else "gemini"
        raise HTTPException(
            status_code=503,
            detail=(
                f"⏳ {used_provider.title()} daily quota reached. "
                f"Paste a {alt.title()} key into backend/.env "
                f"({'GROQ_API_KEY' if alt=='groq' else 'GEMINI_API_KEY'}) "
                "or wait for the daily reset."
            ),
        ) from e
    return (r.choices[0].message.content or "").strip()


# ── Citation contract ───────────────────────────────────────────────────
CITATION_STYLES = {
    "none": "",
    "numbered": (
        "CITATION FORMAT — numbered. Use bracketed numbers like [1], [2] inline. "
        "End with a '## Sources' section listing each number with its full URL/title."
    ),
    "mla": (
        "CITATION FORMAT — MLA 9th. After any borrowed claim, use a parenthetical author-page "
        "or shortened-title where author is unknown. Example: (Smith 42) or (\"Title\" 12). "
        "End with a '## Works Cited' list using MLA format: "
        "Author Last, First. \"Title.\" Site Name, Day Month Year, URL."
    ),
    "apa": (
        "CITATION FORMAT — APA 7th. Inline author-date parentheticals like (Smith, 2024) or "
        "(Title of Page, 2024). End with a '## References' list using APA format: "
        "Author, A. (Year). Title. Site Name. URL"
    ),
    "chicago": (
        "CITATION FORMAT — Chicago author-date. Inline (Smith 2024, 42). "
        "End with a '## References' section in Chicago format: "
        "Author Last, First. Year. \"Title.\" Site Name. URL."
    ),
    "ieee": (
        "CITATION FORMAT — IEEE. Use bracketed numbers [1], [2] inline. "
        "End with a '## References' list numbered: "
        "[1] A. Author, \"Title,\" Site Name, Year. [Online]. Available: URL"
    ),
}


def _citation_contract(style: Optional[str]) -> str:
    """Return a system-prompt block instructing the model to be truthful and cite
    in the requested style. Always-on truthfulness clause is included."""
    style = (style or "none").lower()
    truth = (
        "TRUTHFULNESS CONTRACT: Only assert things that are actually supported by the "
        "knowledge base context, your training, or are common consensus knowledge. "
        "If a claim isn't supported, prefix it with 'I'm not sure but' or say 'I don't know'. "
        "Never fabricate sources, URLs, authors, dates, page numbers, or quotes. "
        "When you do quote a source, use double quotes verbatim from the KB context."
    )
    rule = CITATION_STYLES.get(style, "")
    if not rule:
        return truth
    return (
        f"{truth}\n\n{rule}\n"
        "When KB context is provided below, prefer quoting it directly (a sentence or two "
        "in quotation marks) over paraphrasing. Cite every quoted or borrowed claim. "
        "If no KB context is available, say so plainly and rely on general knowledge "
        "without inventing citations."
    )


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
            summary = await llm_oneshot(
                "You are a precise research assistant.",
                prompt,
                provider=RESEARCH_LLM_PROVIDER,
            )
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


@api.post("/username/claim")
async def claim_username(body: UsernameClaimBody):
    """Reserve a username for this session. Names are unique across the whole app —
    if another session already owns it, return 409 so the client can ask for a different one.
    Names previously used in chat (but not yet claimed) are also considered taken."""
    name = _clean_username(body.name)
    sid = (body.session_id or "").strip()
    if len(name) < 2 or name == "guest":
        raise HTTPException(400, "Pick a name with at least 2 characters.")
    if not sid:
        raise HTTPException(400, "Missing session_id.")
    key = name.lower()

    # Already claimed by this session? idempotent yes.
    mine = await usernames.find_one({"session_id": sid}, {"_id": 0})
    if mine and mine.get("key") == key:
        return {"name": name, "owned": True}

    # Taken by someone else (active claim)?
    other = await usernames.find_one({"key": key}, {"_id": 0})
    if other and other.get("session_id") != sid:
        raise HTTPException(409, f"'{name}' is already taken — try a different name.")

    # Also block names that have been used in chat history by a different session_id
    used_elsewhere = await chats.find_one(
        {"username": name, "session_id": {"$ne": sid, "$nin": [None, ""]}},
        {"_id": 0, "session_id": 1},
    )
    if used_elsewhere:
        raise HTTPException(409, f"'{name}' is already used by another chatter — pick something else.")

    # Release any old name this session had
    await usernames.delete_many({"session_id": sid})
    await usernames.insert_one(dict({
        "key": key,
        "name": name,
        "session_id": sid,
        "created_at": _now(),
    }))
    return {"name": name, "owned": True}


@api.get("/username/check")
async def check_username(name: str, session_id: str):
    """Fast availability check (no claim). Returns {available: bool, reason?}."""
    nm = _clean_username(name)
    sid = (session_id or "").strip()
    if len(nm) < 2 or nm == "guest":
        return {"available": False, "reason": "Pick at least 2 characters."}
    key = nm.lower()
    other = await usernames.find_one({"key": key, "session_id": {"$ne": sid}}, {"_id": 0})
    if other:
        return {"available": False, "reason": "Taken by another chatter."}
    used = await chats.find_one(
        {"username": nm, "session_id": {"$ne": sid, "$nin": [None, ""]}},
        {"_id": 0},
    )
    if used:
        return {"available": False, "reason": "Used in chat by someone else."}
    return {"available": True}


# ── Routes: Public ───────────────────────────────────────────────────────
@api.get("/")
async def root():
    model = GEMINI_MODEL if LLM_PROVIDER == "gemini" else GROQ_MODEL
    key_ok = bool(GEMINI_API_KEY if LLM_PROVIDER == "gemini" else GROQ_API_KEY)
    research_provider = RESEARCH_LLM_PROVIDER or LLM_PROVIDER
    research_key_ok = bool(
        GEMINI_API_KEY if research_provider == "gemini" else GROQ_API_KEY
    )
    return {
        "app": "Midget jr.",
        "ok": True,
        "provider": LLM_PROVIDER,
        "model": model,
        "key_configured": key_ok,
        "research_provider": research_provider,
        "research_key_configured": research_key_ok,
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
async def chat(body: ChatBody, _guest: dict = Depends(maybe_guest)):
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

    # Approved exemplars from Learning Mode — Q/A pairs the LLM-judge approved as
    # genuinely helpful. Injected as few-shot examples so future answers drift toward that style.
    exemplar_docs = await exemplars.find(
        {"approved": True}, {"_id": 0, "question": 1, "answer": 1}
    ).sort("score", -1).limit(4).to_list(4)
    exemplar_block = ""
    if exemplar_docs:
        parts_ex = []
        for i, d in enumerate(exemplar_docs, 1):
            parts_ex.append(
                f"Example {i}\nQ: {(d.get('question') or '')[:400]}\nA: {(d.get('answer') or '')[:1200]}"
            )
        exemplar_block = (
            "PRIOR APPROVED ANSWERS — these are examples of the helpful, honest, "
            "humanity-positive style you should match. Don't quote them verbatim, "
            "match the spirit and clarity:\n\n" + "\n\n".join(parts_ex)
        )

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
    cite_block = _citation_contract(body.citation_style)
    if cite_block:
        parts.append(cite_block)
    if behavior_block:
        parts.append(behavior_block)
    if style_block:
        parts.append(style_block)
    if exemplar_block:
        parts.append(exemplar_block)
    if context_block:
        parts.append(context_block)
    system = "\n\n".join(parts)

    messages: list[dict] = [{"role": "system", "content": system}]
    for m in (body.history or [])[-10:]:
        role = m.get("role")
        text = (m.get("content") or "").strip()
        if role in ("user", "assistant") and text:
            messages.append({"role": role, "content": text[:2000]})

    # Vision: if the user attached an image, send a multimodal content block.
    has_image = bool(body.image and body.image.startswith("data:image"))
    if has_image:
        messages.append({"role": "user", "content": [
            {"type": "text", "text": body.message or "Describe this image."},
            {"type": "image_url", "image_url": {"url": body.image}},
        ]})
    else:
        messages.append({"role": "user", "content": body.message})

    try:
        if has_image:
            # Force Groq (Gemini's OpenAI shim is finicky with image_url) and use the vision model.
            cli, _ = llm_client("groq")
            r = await cli.chat.completions.create(
                model=GROQ_VISION_MODEL, messages=messages, temperature=0.5
            )
            reply = (r.choices[0].message.content or "").strip()
        else:
            reply = await llm_chat(messages)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"LLM error: {e}") from e

    asyncio.create_task(_log_exchange(body.session_id, body.username, body.message, reply, len(ctx_docs)))
    asyncio.create_task(_maybe_auto_promote(body.message))

    return {"reply": reply, "context_used": len(ctx_docs), "direct_mode": direct,
            "exemplars_used": len(exemplar_docs),
            "citation_style": (body.citation_style or "none").lower(),
            "vision": has_image}


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
async def get_share(share_id: str, _guest: dict = Depends(maybe_guest)):
    if not re.fullmatch(r"[a-z0-9]{4,16}", share_id or ""):
        raise HTTPException(404, "Not found")
    doc = await shares.find_one({"id": share_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Not found")
    return doc


@api.post("/query")
async def query_kb(body: QueryBody, _guest: dict = Depends(maybe_guest)):
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
async def research(body: ResearchBody, _guest: dict = Depends(maybe_guest)):
    return await do_research(body.topic.strip(), body.category)


@api.post("/code")
async def code(body: CodeBody, _guest: dict = Depends(maybe_guest)):
    system = (
        f"You generate clean, working {body.language} code. "
        "Reply with ONLY the code — no markdown fences, no prose explanations."
    )
    try:
        out = await llm_oneshot(system, body.prompt)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"LLM error: {e}") from e
    # Strip accidental triple-fence wrappers
    out = re.sub(r"^```[a-zA-Z0-9]*\n", "", out.strip())
    out = re.sub(r"\n```$", "", out)
    return {"code": out, "language": body.language}


@api.post("/write")
async def write_into_doc(body: WriteBody, _guest: dict = Depends(maybe_guest)):
    """Ghost-typer: produces text that should be inserted at the user's cursor
    position inside an existing document. The frontend types it out char-by-char.
    Context (text before + after cursor) is given so the bot picks up tone/voice
    and doesn't repeat what's already written."""
    instruction = (body.instruction or "").strip()
    if len(instruction) < 3:
        raise HTTPException(400, "Tell me what to write (at least a few words).")
    before = (body.doc_before or "")[-1500:]
    after = (body.doc_after or "")[:600]
    tone = (body.tone or "match the surrounding voice").strip()[:60]
    max_chars = max(80, min(int(body.max_chars or 1200), 4000))

    system = (
        "You are a ghostwriter that drops text directly into a user's document at "
        "their cursor position. Rules:\n"
        "1. Output ONLY the prose to insert — no preamble, no quotes, no markdown "
        "fences, no 'Here's your text:'. Just the words.\n"
        "2. Pay attention to the text immediately before the cursor and continue "
        "from it naturally. Match its tone, formality, and voice.\n"
        "3. If there's text immediately after the cursor, write something that "
        "flows into it gracefully.\n"
        "4. Keep it under the requested length. Stop on a complete sentence.\n"
        f"5. Target tone: {tone}."
    )
    if body.humanize:
        system += (
            "\n\n🧑 HUMANIZE MODE — write so a real person could believe it was them. "
            "Hard rules:\n"
            "• BURSTINESS: mix sentence lengths violently. One fragment. Then a "
            "longer winding sentence that bends back on itself and breathes. Then "
            "two short ones. Like this. Never three medium sentences in a row.\n"
            "• PERPLEXITY: pick the second- or third-most-obvious word sometimes. "
            "Replace 'utilize' with 'use', 'numerous' with 'a lot of', 'individuals' "
            "with 'people'. Throw in a specific concrete detail (a name, a number, "
            "a brand, a place) rather than abstract phrasing.\n"
            "• CONTRACTIONS: always. don't, it's, isn't, we'll, you're, won't.\n"
            "• HUMAN VOICE: drop in 'honestly', 'sort of', 'kind of', 'I mean', "
            "'look', 'well', 'okay so', 'the thing is' — sparingly, like seasoning.\n"
            "• ALLOWED: comma splices, starting a sentence with 'And' or 'But', "
            "ending one with a preposition, the occasional missing Oxford comma.\n"
            "• BANNED PHRASES (do not write these): delve, delve into, navigate, "
            "navigating, landscape, tapestry, intricate, multifaceted, leverage, "
            "harness, unleash, robust, seamless, holistic, paradigm, paradigm shift, "
            "ever-evolving, in today's fast-paced world, in the realm of, "
            "it's important to note, it's worth noting, it's worth mentioning, "
            "moreover, furthermore, additionally, in conclusion, to sum up, "
            "in summary, ultimately, dive into, embark on, journey, plethora, "
            "myriad, vibrant, bustling, captivating, breathtaking, "
            "a testament to, a beacon of, foster, fostering, cultivate, "
            "in essence, at its core, the world of, the realm of, when it comes to, "
            "as we navigate, as we delve, picture this.\n"
            "• AVOID: stacks of em dashes (one max), three-item lists with 'and', "
            "starting paragraphs with 'The'.\n"
            "• AVOID AI rhythm: don't put a comma right after the first 2 words of a sentence."
        )
    prompt = (
        f"Instruction: {instruction}\n"
        f"Max length: {max_chars} characters.\n\n"
        "── Text BEFORE the cursor (cursor is at the end of this) ──\n"
        f"{before or '(empty document)'}\n\n"
        "── Text AFTER the cursor ──\n"
        f"{after or '(nothing after)'}\n\n"
        "Now write the text that should appear at the cursor:"
    )
    try:
        out = await llm_oneshot(system, prompt)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"LLM error: {e}") from e
    # Strip any accidental wrappers
    out = out.strip()
    out = re.sub(r'^["\'`]+|["\'`]+$', "", out).strip()
    if len(out) > max_chars:
        # Snap at a sentence boundary
        cut = out[:max_chars]
        last_stop = max(cut.rfind("."), cut.rfind("!"), cut.rfind("?"))
        out = cut[: last_stop + 1] if last_stop > 80 else cut

    # ── Second-pass humanizer: explicit anti-detector rewrite ─────────
    if body.humanize and len(out) > 40:
        rewrite_sys = (
            "You take AI-sounding text and rewrite it so an AI-detector flags it "
            "as human (GPTZero, Originality, Copyleaks). Reply with ONLY the "
            "rewritten text — no preamble, no quotes, no explanation.\n\n"
            "Techniques you MUST apply:\n"
            "1. BURSTINESS: shatter sentence-length uniformity. Use a fragment. "
            "Then a sentence that meanders longer than feels comfortable, with a "
            "comma or two interrupting the flow. Then two short clipped ones. "
            "Mix 4-word and 25-word sentences in the same paragraph.\n"
            "2. PERPLEXITY: replace the most predictable word with the second or "
            "third choice. 'Use' instead of 'utilize'. 'Help' instead of 'facilitate'. "
            "'Make' instead of 'establish'. Pick specific concrete nouns over abstract.\n"
            "3. CONTRACTIONS: every 'do not' → 'don't', 'is not' → 'isn't', etc.\n"
            "4. PERSONAL VOICE: weave in 'honestly', 'I mean', 'sort of', 'kind of', "
            "'look', 'well', 'the thing is' once or twice per paragraph — never more.\n"
            "5. PUNCTUATION QUIRKS: one comma splice is allowed. Start one sentence "
            "with 'And' or 'But'. Drop one Oxford comma. Max one em dash.\n"
            "6. KILL AI tells: any of these words/phrases must be replaced — "
            "delve, navigate, landscape, tapestry, intricate, multifaceted, "
            "leverage, harness, unleash, robust, seamless, holistic, paradigm, "
            "ever-evolving, in today's fast-paced world, in the realm of, "
            "it's important to note, it's worth noting, moreover, furthermore, "
            "additionally, in conclusion, to sum up, in summary, ultimately, "
            "dive into, embark on, journey, plethora, myriad, vibrant, bustling, "
            "captivating, breathtaking, a testament to, foster, cultivate, "
            "in essence, at its core, when it comes to, picture this.\n"
            "7. PRESERVE meaning, length (~±15%), and target tone. Don't add new facts.\n"
            "8. NEVER use the literal words 'humanize', 'human', or 'AI' in the output."
        )
        try:
            out2 = await llm_oneshot(rewrite_sys,
                f"Target tone: {tone}.\n\nRewrite this so it reads as human:\n\n{out}",
                temperature=1.15)   # high temp = less predictable token choices
            out2 = out2.strip()
            out2 = re.sub(r'^["\'`]+|["\'`]+$', "", out2).strip()
            if 20 < len(out2) < max_chars * 2:
                out = out2
        except Exception:
            pass

        # Third pass: pure rule-based scrambler. Strips remaining AI-favored words,
        # injects fillers, splits a long sentence, drops one Oxford comma.
        out = _humanize_post(out)

    return {"text": out, "chars": len(out)}


@api.post("/write/rewrite")
async def rewrite_selection(body: RewriteBody, _guest: dict = Depends(maybe_guest)):
    """Rewrite a selected slice of a document in a target tone, in-place."""
    sel = (body.selection or "").strip()
    if len(sel) < 2:
        raise HTTPException(400, "Selection too short — highlight some text first.")
    tone = (body.tone or "clearer").strip()[:60]
    instruction = (body.instruction or "").strip()[:300]
    before = (body.doc_before or "")[-1000:]
    after = (body.doc_after or "")[:600]
    max_chars = max(80, min(int(body.max_chars or 2000), 4000))

    system = (
        "You are a precise rewriter. You rewrite ONLY the user-selected slice of a "
        "document, keeping its meaning intact while adjusting tone or following the "
        "user's instruction. Rules:\n"
        "1. Reply with ONLY the rewritten text — no preamble, no markdown fences, no "
        "quotes around it, no 'Here's the rewrite:'.\n"
        "2. Keep the rewrite at a similar length to the original unless the user "
        "explicitly asks for shorter/longer.\n"
        "3. Match the surrounding paragraph's voice (you'll see text before and after).\n"
        f"4. Target tone: {tone}."
    )
    prompt = (
        f"User instruction: {instruction or '(none — just adjust to the tone above)'}\n"
        f"Max length: {max_chars} chars.\n\n"
        "── Text BEFORE the selection ──\n"
        f"{before or '(nothing)'}\n\n"
        "── SELECTED TEXT to rewrite ──\n"
        f"{sel}\n\n"
        "── Text AFTER the selection ──\n"
        f"{after or '(nothing)'}\n\n"
        "Now rewrite the selected text:"
    )
    try:
        out = await llm_oneshot(system, prompt)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"LLM error: {e}") from e
    out = re.sub(r'^["\'`]+|["\'`]+$', "", out.strip()).strip()
    if len(out) > max_chars:
        out = out[:max_chars]

    # Second-pass humanizer for rewrites too
    if body.humanize and len(out) > 40:
        rewrite_sys = (
            "Rewrite the text so AI-detectors classify it as human-written. "
            "Reply with ONLY the rewritten text. Use bursty sentence length "
            "(mix fragments + long sentences), pick less-predictable wording, "
            "use contractions, sprinkle 'honestly'/'sort of'/'I mean' sparingly. "
            "Remove these AI-tell words: delve, navigate, landscape, tapestry, "
            "intricate, leverage, harness, robust, seamless, paradigm, "
            "in today's fast-paced world, moreover, furthermore, additionally, "
            "in conclusion, ultimately, dive into, plethora, myriad, vibrant, "
            "bustling, foster, cultivate. Keep meaning and ~same length."
        )
        try:
            out2 = await llm_oneshot(rewrite_sys, f"Tone: {tone}.\n\n{out}",
                                     temperature=1.15)
            out2 = re.sub(r'^["\'`]+|["\'`]+$', "", out2.strip()).strip()
            if 20 < len(out2) < max_chars * 2:
                out = out2
        except Exception:
            pass
        out = _humanize_post(out)
    return {"text": out, "chars": len(out)}


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


# ── Access mode + invite codes ─────────────────────────────────────────
@api.get("/access-mode")
async def get_access_mode():
    doc = await config.find_one({"_id": "access_mode"})
    return {"require_guest_pass": bool(doc and doc.get("require_guest_pass"))}


@api.post("/admin/access-mode", dependencies=[Depends(require_admin)])
async def set_access_mode(body: AccessModeBody):
    await config.update_one(
        {"_id": "access_mode"},
        {"$set": {"require_guest_pass": bool(body.enabled), "updated_at": _now()}},
        upsert=True,
    )
    return {"require_guest_pass": bool(body.enabled)}


def _check_complexity(code: str, level: str) -> tuple[bool, str]:
    """Return (ok, error_message). Level: 'weak' = anything ≥ 4 chars.
    'strong' = ≥ 12 chars with upper+lower+digit+symbol."""
    c = code or ""
    if len(c) < 4:
        return False, "Code must be at least 4 characters."
    if level == "strong":
        if len(c) < 12:
            return False, "Strong codes need ≥ 12 characters."
        if not re.search(r"[a-z]", c):
            return False, "Strong codes need a lowercase letter."
        if not re.search(r"[A-Z]", c):
            return False, "Strong codes need an uppercase letter."
        if not re.search(r"\d", c):
            return False, "Strong codes need a digit."
        if not re.search(r"[^\w\s]", c):
            return False, "Strong codes need a symbol (e.g. !@#$)."
    return True, ""


@api.post("/admin/access-codes", dependencies=[Depends(require_admin)])
async def create_access_code(body: CreateCodeBody):
    level = (body.complexity or "weak").lower()
    if level not in ("weak", "strong"):
        raise HTTPException(400, "complexity must be 'weak' or 'strong'.")
    # Custom code path
    if body.code:
        code_str = body.code.strip()
        ok, msg = _check_complexity(code_str, level)
        if not ok:
            raise HTTPException(400, msg)
        if await access_codes.find_one({"code": code_str}):
            raise HTTPException(409, "That code already exists — pick a different one.")
    else:
        # Auto-generate. For 'strong', generate a 16-char mixed string that always passes.
        if level == "strong":
            import secrets
            import string
            alphabet = string.ascii_letters + string.digits
            symbols = "!@#$%^&*-_"
            while True:
                code_str = "".join(secrets.choice(alphabet) for _ in range(14)) + secrets.choice(symbols) + secrets.choice(string.digits)
                ok, _ = _check_complexity(code_str, level)
                if ok and not await access_codes.find_one({"code": code_str}):
                    break
        else:
            code_str = _short_id(10)
            for _ in range(3):
                if not await access_codes.find_one({"code": code_str}):
                    break
                code_str = _short_id(10)
    expires_at = None
    if body.expires_in_days and body.expires_in_days > 0:
        expires_at = (datetime.now(timezone.utc) + timedelta(days=int(body.expires_in_days))).isoformat()
    doc = {
        "code": code_str,
        "label": (body.label or "")[:60],
        "complexity": level,
        "expires_at": expires_at,
        "max_uses": int(body.max_uses) if body.max_uses else None,
        "uses": 0,
        "revoked": False,
        "created_at": _now(),
    }
    await access_codes.insert_one(dict(doc))
    return {k: v for k, v in doc.items() if k != "_id"}


@api.get("/admin/access-codes", dependencies=[Depends(require_admin)])
async def list_access_codes():
    docs = await access_codes.find({}, {"_id": 0}).sort("created_at", -1).limit(200).to_list(200)
    now = datetime.now(timezone.utc)
    for d in docs:
        exp = d.get("expires_at")
        d["expired"] = bool(exp and datetime.fromisoformat(exp.replace("Z", "+00:00")) < now)
        d["maxed"] = bool(d.get("max_uses") and d.get("uses", 0) >= d["max_uses"])
        d["active"] = not (d["expired"] or d["maxed"] or d.get("revoked"))
    return {"codes": docs, "count": len(docs)}


@api.delete("/admin/access-codes/{code_str}", dependencies=[Depends(require_admin)])
async def revoke_access_code(code_str: str):
    r = await access_codes.update_one({"code": code_str}, {"$set": {"revoked": True, "revoked_at": _now()}})
    if r.matched_count == 0:
        raise HTTPException(404, "Code not found")
    return {"revoked": code_str}


@api.post("/guest-auth")
async def guest_auth(body: GuestAuthBody):
    code = (body.code or "").strip()
    if not code:
        raise HTTPException(400, "Code is required")
    doc = await access_codes.find_one({"code": code})
    if not doc:
        raise HTTPException(401, "Invalid code")
    if doc.get("revoked"):
        raise HTTPException(401, "Code revoked")
    if doc.get("max_uses") and doc.get("uses", 0) >= doc["max_uses"]:
        raise HTTPException(401, "Code is used up")
    exp = doc.get("expires_at")
    if exp:
        try:
            exp_dt = datetime.fromisoformat(exp.replace("Z", "+00:00"))
            if exp_dt < datetime.now(timezone.utc):
                raise HTTPException(401, "Code expired")
        except HTTPException:
            raise
        except Exception:
            pass
    await access_codes.update_one({"code": code}, {"$inc": {"uses": 1}, "$set": {"last_used_at": _now()}})
    token = make_guest_token(code, exp)
    return {"token": token, "expires_at": exp, "label": doc.get("label", "")}


# ── Bug reports ───────────────────────────────────────────────────────
@api.post("/bug-reports")
async def submit_bug_report(body: BugReportBody, _guest: dict = Depends(maybe_guest)):
    description = (body.description or "").strip()
    steps = (body.steps or "").strip()
    if len(description) < 5:
        raise HTTPException(400, "Tell me what went wrong (5+ characters)")
    if len(steps) < 5:
        raise HTTPException(400, "Tell me the steps to reach the bug (5+ characters)")
    screenshot = body.screenshot or None
    if screenshot and len(screenshot) > 700_000:    # ~512KB image + b64 overhead
        raise HTTPException(413, "Screenshot too large (max ~500 KB)")
    doc = {
        "id": str(uuid.uuid4()),
        "description": description[:4000],
        "steps": steps[:4000],
        "screenshot": screenshot[:700_000] if screenshot else None,
        "username": _clean_username(body.username),
        "created_at": _now(),
        "resolved": False,
    }
    await bug_reports.insert_one(dict(doc))
    return {"id": doc["id"]}


@api.get("/admin/bug-reports", dependencies=[Depends(require_admin)])
async def list_bug_reports(limit: int = 100):
    cursor = bug_reports.find({}, {"_id": 0}).sort("created_at", -1).limit(min(max(limit, 1), 500))
    docs = await cursor.to_list(length=limit)
    return {"reports": docs, "count": len(docs)}


@api.delete("/admin/bug-reports/{report_id}", dependencies=[Depends(require_admin)])
async def delete_bug_report(report_id: str):
    r = await bug_reports.delete_one({"id": report_id})
    if r.deleted_count == 0:
        raise HTTPException(404, "Not found")
    return {"deleted": report_id}


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


# ── Learning Mode (LLM-as-judge → exemplars) ────────────────────────────
@api.post("/learning-unlock")
async def learning_unlock(body: LearningUnlockBody):
    if (body.password or "") != LEARNING_PASSWORD:
        raise HTTPException(401, "Wrong learning password")
    return {"token": make_learning_token(), "expires_in_days": 30}


def _parse_judge_json(raw: str) -> dict:
    """Coax the LLM-judge reply into {score: int, reason: str, approved: bool}."""
    import json as _json
    s = (raw or "").strip()
    # strip markdown fences
    s = re.sub(r"^```(?:json)?\s*", "", s)
    s = re.sub(r"\s*```$", "", s)
    try:
        obj = _json.loads(s)
    except Exception:
        # try to extract first JSON object
        m = re.search(r"\{[\s\S]*\}", s)
        if not m:
            return {"score": 0, "reason": "judge returned non-JSON", "approved": False}
        try:
            obj = _json.loads(m.group(0))
        except Exception:
            return {"score": 0, "reason": "judge returned non-JSON", "approved": False}
    score = int(obj.get("score") or 0)
    return {
        "score": max(0, min(10, score)),
        "reason": str(obj.get("reason") or "")[:500],
        "approved": bool(obj.get("approved")) if "approved" in obj else (score >= 7),
    }


JUDGE_SYSTEM = (
    "You are a strict but fair evaluator of chatbot answers. Read the user's question "
    "and the bot's answer, then score the answer 0-10 across all of these dimensions "
    "combined: "
    "(a) actually helps the human, "
    "(b) factually accurate / truthful — no fabricated facts, "
    "(c) cites real sources where claims need backing (any inline marker like [1], "
    "(Author Year), or a 'Sources/References' section counts; full made-up citations "
    "should be punished hard), "
    "(d) carries no health, safety, or wellbeing risk, "
    "(e) is direct and well-written. "
    "Reply ONLY with a JSON object like "
    '{"score": 0-10, "reason": "one short sentence on truth + citations + helpfulness", '
    '"approved": true/false}. '
    "approved=true means score >= 7 AND no fabrication AND no harm. No prose outside JSON."
)


@api.post("/learning/run", dependencies=[Depends(require_learning)])
async def learning_run(body: LearningRunBody):
    """Pull the most recent N chat exchanges, judge each one with the LLM,
    persist approved ones to the exemplars collection, return all judgments."""
    n = max(1, min(int(body.limit or 20), 50))
    min_score = max(0, min(int(body.min_score or 7), 10))
    docs = await chats.find({}, {"_id": 0}).sort("created_at", -1).limit(n).to_list(n)
    results: List[dict] = []
    approved_count = 0
    for d in docs:
        q = (d.get("user_message") or "").strip()
        a = (d.get("bot_reply") or "").strip()
        if not q or not a:
            continue
        # Skip ones already judged
        existing = await exemplars.find_one(
            {"chat_id": d.get("id")}, {"_id": 0, "id": 1, "approved": 1, "score": 1}
        )
        if existing:
            results.append({
                "chat_id": d.get("id"),
                "question": q[:200],
                "score": existing.get("score", 0),
                "approved": bool(existing.get("approved")),
                "reason": "already judged",
                "cached": True,
            })
            if existing.get("approved"):
                approved_count += 1
            continue
        prompt = f"USER QUESTION:\n{q[:1500]}\n\nBOT ANSWER:\n{a[:3000]}"
        try:
            raw = await llm_oneshot(JUDGE_SYSTEM, prompt, provider=RESEARCH_LLM_PROVIDER)
        except Exception as e:
            results.append({"chat_id": d.get("id"), "question": q[:200],
                            "score": 0, "approved": False, "reason": f"judge error: {e}"})
            continue
        verdict = _parse_judge_json(raw)
        approved = verdict["approved"] and verdict["score"] >= min_score
        ex_doc = {
            "id": str(uuid.uuid4()),
            "chat_id": d.get("id"),
            "question": q[:2000],
            "answer": a[:4000],
            "score": verdict["score"],
            "reason": verdict["reason"],
            "approved": approved,
            "username": d.get("username"),
            "created_at": _now(),
        }
        await exemplars.insert_one(dict(ex_doc))
        if approved:
            approved_count += 1
        results.append({
            "chat_id": d.get("id"),
            "question": q[:200],
            "score": verdict["score"],
            "approved": approved,
            "reason": verdict["reason"],
        })
    return {"judged": len(results), "approved": approved_count, "results": results}


@api.get("/admin/exemplars", dependencies=[Depends(require_learning)])
async def list_exemplars(approved_only: bool = False, limit: int = 200):
    q = {"approved": True} if approved_only else {}
    cursor = exemplars.find(q, {"_id": 0}).sort("score", -1).limit(min(max(limit, 1), 500))
    docs = await cursor.to_list(length=limit)
    return {"exemplars": docs, "count": len(docs)}


@api.delete("/admin/exemplars/{ex_id}", dependencies=[Depends(require_learning)])
async def delete_exemplar(ex_id: str):
    r = await exemplars.delete_one({"id": ex_id})
    if r.deleted_count == 0:
        raise HTTPException(404, "Not found")
    return {"deleted": ex_id}


@api.post("/admin/exemplars/{ex_id}/toggle", dependencies=[Depends(require_learning)])
async def toggle_exemplar(ex_id: str):
    """Flip approved flag — lets the admin manually approve a borderline answer or
    reject one the judge over-rated."""
    doc = await exemplars.find_one({"id": ex_id}, {"_id": 0, "approved": 1})
    if not doc:
        raise HTTPException(404, "Not found")
    new_val = not bool(doc.get("approved"))
    await exemplars.update_one({"id": ex_id}, {"$set": {"approved": new_val}})
    return {"id": ex_id, "approved": new_val}


@api.post("/learning/teach")
async def learning_teach(body: TeachBody, _guest: dict = Depends(maybe_guest)):
    """Public endpoint: a user clicked '👍 Teach Midget' on a reply.
    We immediately run the LLM-judge on just this exchange. Approved (score >= 7,
    truthful, no harm) answers become high-priority exemplars right away.
    Lower-scoring picks are still saved but marked pending so an admin can review."""
    q = (body.question or "").strip()
    a = (body.answer or "").strip()
    if len(q) < 3 or len(a) < 3:
        raise HTTPException(400, "Need a question and an answer to teach.")
    # Dedupe: if this exact pair already exists, just bump priority
    existing = await exemplars.find_one(
        {"question": q[:2000], "answer": a[:4000]},
        {"_id": 0, "id": 1, "approved": 1, "score": 1},
    )
    if existing:
        await exemplars.update_one(
            {"id": existing["id"]},
            {"$inc": {"teach_votes": 1}, "$set": {"last_teach_at": _now()}},
        )
        return {
            "id": existing["id"],
            "score": existing.get("score", 0),
            "approved": bool(existing.get("approved")),
            "reason": "already saved — bumped vote count",
            "cached": True,
        }
    prompt = f"USER QUESTION:\n{q[:1500]}\n\nBOT ANSWER:\n{a[:3000]}"
    try:
        raw = await llm_oneshot(JUDGE_SYSTEM, prompt, provider=RESEARCH_LLM_PROVIDER)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Judge error: {e}") from e
    verdict = _parse_judge_json(raw)
    approved = verdict["approved"] and verdict["score"] >= 7
    ex_doc = {
        "id": str(uuid.uuid4()),
        "chat_id": body.chat_id,
        "question": q[:2000],
        "answer": a[:4000],
        "score": verdict["score"],
        "reason": verdict["reason"],
        "approved": approved,
        "username": _clean_username(body.username),
        "session_id": body.session_id,
        "citation_style": (body.citation_style or "none").lower(),
        "teach_votes": 1,
        "via": "teach_button",
        "created_at": _now(),
    }
    await exemplars.insert_one(dict(ex_doc))
    return {"id": ex_doc["id"], "score": verdict["score"],
            "approved": approved, "reason": verdict["reason"]}


# ── Self-edit (admin can let Midget rewrite its own source) ──────────
# ⚠️ Tight safety rails — admin-only, path allow-list, automatic backup, no
# secrets-leaking responses. Hot-reload picks up changes; no restart needed.
import difflib  # noqa: E402

APP_ROOT = "/app"
EDITABLE_PATHS = {
    # Backend
    "backend/server.py": "Backend FastAPI app + LLM logic",
    # Frontend
    "frontend/src/App.js": "Main React SPA (all UI, tabs, modals)",
    "frontend/src/App.css": "App stylesheet",
    "frontend/src/index.css": "Global CSS reset + Catppuccin palette",
    "frontend/src/index.js": "React entrypoint",
}


def _abs(rel: str) -> str:
    if rel not in EDITABLE_PATHS:
        raise HTTPException(403, f"Path '{rel}' is not in the safe-edit allow-list.")
    return os.path.join(APP_ROOT, rel)


def _read_file(rel: str) -> str:
    with open(_abs(rel), "r", encoding="utf-8") as f:
        return f.read()


def _write_file(rel: str, content: str) -> None:
    with open(_abs(rel), "w", encoding="utf-8") as f:
        f.write(content)


@api.get("/admin/self/files", dependencies=[Depends(require_admin)])
async def list_editable_files():
    out = []
    for rel, desc in EDITABLE_PATHS.items():
        try:
            sz = os.path.getsize(_abs(rel))
            lines = _read_file(rel).count("\n") + 1
        except Exception:
            sz, lines = 0, 0
        out.append({"path": rel, "description": desc, "size": sz, "lines": lines})
    return {"files": out}


@api.get("/admin/self/file", dependencies=[Depends(require_admin)])
async def read_editable_file(path: str):
    return {"path": path, "content": _read_file(path)}


@api.post("/admin/self/propose", dependencies=[Depends(require_admin)])
async def propose_edit(body: SelfProposeBody):
    rel = body.path
    if rel not in EDITABLE_PATHS:
        raise HTTPException(403, "Path not editable.")
    current = _read_file(rel)
    is_python = rel.endswith(".py")
    is_react = rel.endswith(".js") or rel.endswith(".jsx")
    lang = "Python (FastAPI)" if is_python else ("React JSX" if is_react else "CSS")
    system = (
        f"You are a {lang} expert editing the source file '{rel}' of an existing "
        "running web app called Midget jr. (FastAPI backend + React frontend + MongoDB). "
        "The user (admin) describes a change they want. You return the COMPLETE NEW "
        "FILE CONTENT — no markdown fences, no diff, no commentary, no truncation. "
        "Preserve all existing functionality except what the user asked to change. "
        "Keep imports correct. Keep route paths under /api. Keep MongoDB queries that "
        "exclude _id. Don't touch unrelated code. The output must be a syntactically "
        "complete file ready to be saved as-is."
    )
    prompt = (
        f"USER REQUEST:\n{body.instruction}\n\n"
        f"CURRENT FILE CONTENT (length {len(current)} chars):\n"
        f"------BEGIN------\n{current}\n------END------\n\n"
        "Now output the entire new file content:"
    )
    try:
        new_content = await llm_oneshot(system, prompt)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"LLM error: {e}") from e
    # Strip accidental fences
    new_content = re.sub(r"^```[a-zA-Z0-9]*\n", "", new_content.strip())
    new_content = re.sub(r"\n```$", "", new_content)
    # Diff for preview
    diff = "".join(difflib.unified_diff(
        current.splitlines(keepends=True),
        new_content.splitlines(keepends=True),
        fromfile=f"a/{rel}", tofile=f"b/{rel}", n=3,
    ))
    return {
        "path": rel,
        "new_content": new_content,
        "diff": diff,
        "old_size": len(current),
        "new_size": len(new_content),
    }


@api.post("/admin/self/apply", dependencies=[Depends(require_admin)])
async def apply_edit(body: SelfApplyBody):
    rel = body.path
    if rel not in EDITABLE_PATHS:
        raise HTTPException(403, "Path not editable.")
    if not body.new_content or len(body.new_content) < 10:
        raise HTTPException(400, "Refusing to write an empty or trivial file.")
    current = _read_file(rel)
    if current == body.new_content:
        return {"applied": False, "reason": "No change vs current file."}
    # Backup old version to audit log (capped at 200 backups)
    edit_doc = {
        "id": str(uuid.uuid4()),
        "path": rel,
        "old_content": current,
        "new_content": body.new_content,
        "summary": (body.summary or "")[:300],
        "created_at": _now(),
    }
    await self_edits.insert_one(dict(edit_doc))
    # Rotate: keep only most recent 200
    too_many = await self_edits.count_documents({})
    if too_many > 200:
        oldest = await self_edits.find({}, {"_id": 1}).sort("created_at", 1).limit(too_many - 200).to_list(too_many - 200)
        if oldest:
            await self_edits.delete_many({"_id": {"$in": [o["_id"] for o in oldest]}})
    _write_file(rel, body.new_content)
    return {"applied": True, "edit_id": edit_doc["id"], "path": rel,
            "new_size": len(body.new_content)}


@api.get("/admin/self/history", dependencies=[Depends(require_admin)])
async def self_edit_history(limit: int = 30):
    docs = await self_edits.find(
        {}, {"_id": 0, "id": 1, "path": 1, "summary": 1, "created_at": 1}
    ).sort("created_at", -1).limit(min(max(limit, 1), 100)).to_list(limit)
    return {"edits": docs, "count": len(docs)}


@api.post("/admin/self/rollback/{edit_id}", dependencies=[Depends(require_admin)])
async def rollback_edit(edit_id: str):
    doc = await self_edits.find_one({"id": edit_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Edit not found")
    rel = doc["path"]
    if rel not in EDITABLE_PATHS:
        raise HTTPException(403, "Path no longer editable.")
    current = _read_file(rel)
    # Insert a rollback record (so the rollback itself is reversible)
    await self_edits.insert_one(dict({
        "id": str(uuid.uuid4()),
        "path": rel,
        "old_content": current,
        "new_content": doc["old_content"],
        "summary": f"Rollback of {edit_id}",
        "created_at": _now(),
    }))
    _write_file(rel, doc["old_content"])
    return {"rolled_back": edit_id, "path": rel}


# ── GitHub push (admin commits the current /app to a configured repo) ──
import subprocess  # noqa: E402

GIT_CONFIG_KEY = "github_settings"


def _git(args: List[str], cwd: str = APP_ROOT) -> subprocess.CompletedProcess:
    return subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True, timeout=60)


@api.post("/admin/github/setup", dependencies=[Depends(require_admin)])
async def github_setup(body: GithubSetupBody):
    if not re.fullmatch(r"[\w.\-]+/[\w.\-]+", body.repo):
        raise HTTPException(400, "Repo must look like 'owner/repo'.")
    if len(body.pat) < 20:
        raise HTTPException(400, "That PAT looks too short to be valid.")
    await config.update_one(
        {"_id": GIT_CONFIG_KEY},
        {"$set": {
            "repo": body.repo,
            "branch": body.branch or "main",
            "pat": body.pat,
            "author_name": body.author_name or "Midget jr.",
            "author_email": body.author_email or "midget-jr@local",
            "updated_at": _now(),
        }},
        upsert=True,
    )
    return {"ok": True, "repo": body.repo, "branch": body.branch}


@api.get("/admin/github/status", dependencies=[Depends(require_admin)])
async def github_status():
    cfg = await config.find_one({"_id": GIT_CONFIG_KEY}, {"_id": 0})
    is_repo = os.path.isdir(os.path.join(APP_ROOT, ".git"))
    out = {"configured": bool(cfg), "is_git_repo": is_repo}
    if cfg:
        out.update({"repo": cfg.get("repo"), "branch": cfg.get("branch"),
                    "pat_set": bool(cfg.get("pat"))})
    if is_repo:
        st = _git(["status", "--short"])
        out["dirty"] = bool(st.stdout.strip())
        out["status"] = st.stdout[-2000:]
    return out


@api.post("/admin/github/push", dependencies=[Depends(require_admin)])
async def github_push(body: GithubPushBody):
    cfg = await config.find_one({"_id": GIT_CONFIG_KEY}, {"_id": 0})
    if not cfg or not cfg.get("pat"):
        raise HTTPException(400, "GitHub not configured — call /admin/github/setup first.")
    branch = cfg.get("branch", "main")
    repo = cfg.get("repo")
    pat = cfg.get("pat")
    name = cfg.get("author_name") or "Midget jr."
    email = cfg.get("author_email") or "midget-jr@local"
    remote = f"https://x-access-token:{pat}@github.com/{repo}.git"

    logs: List[str] = []
    def step(name: str, args: List[str], **kw):
        p = _git(args, **kw)
        logs.append(f"$ git {' '.join(args)}\n{p.stdout}{p.stderr}".strip())
        return p

    try:
        # Init if needed
        if not os.path.isdir(os.path.join(APP_ROOT, ".git")):
            step("init", ["init"])
            step("branch", ["branch", "-M", branch])
        step("name", ["config", "user.name", name])
        step("email", ["config", "user.email", email])
        # Make sure .gitignore exists to avoid leaking secrets
        gi = os.path.join(APP_ROOT, ".gitignore")
        if not os.path.exists(gi):
            with open(gi, "w") as f:
                f.write(
                    "# auto-generated by Midget jr.\n"
                    "backend/.env\nfrontend/.env\nnode_modules/\n__pycache__/\n*.pyc\n.DS_Store\n"
                    ".emergent/\n"
                )
        step("add", ["add", "-A"])
        diff_check = step("diff_check", ["diff", "--cached", "--quiet"])
        if diff_check.returncode == 0:
            return {"pushed": False, "reason": "Nothing to commit.", "log": "\n\n".join(logs)}
        step("commit", ["commit", "-m", body.message[:200] or "Midget jr. self-edit"])
        step("remote_set", ["remote", "remove", "origin"])  # ok if it errors
        step("remote_add", ["remote", "add", "origin", remote])
        push = step("push", ["push", "-u", "origin", branch])
        if push.returncode != 0:
            # Try force? No — return the error so admin sees it.
            return {"pushed": False, "reason": "git push failed",
                    "log": "\n\n".join(logs).replace(pat, "***REDACTED***")}
        return {"pushed": True, "branch": branch, "repo": repo,
                "log": "\n\n".join(logs).replace(pat, "***REDACTED***")}
    except Exception as e:
        return {"pushed": False, "reason": str(e),
                "log": "\n\n".join(logs).replace(pat, "***REDACTED***")}


# ── AI Dev agent (conversational code editor like E1) ─────────────────
AGENT_SYSTEM = (
    "You are 'Midget Dev', a coding agent. Respond ONLY with a single fenced "
    "JSON action block per turn. Never prose outside an action. After tool "
    "results, ALWAYS finish with a 'done' action.\n\n"
    "Editable paths (use these EXACT strings):\n"
    "• backend/server.py\n"
    "• frontend/src/App.js\n"
    "• frontend/src/App.css\n"
    "• frontend/src/index.css\n"
    "• frontend/src/index.js\n\n"
    "Tools:\n"
    "• list_files — list editable files\n"
    "• read_file {path} — read a file (truncated to 15KB)\n"
    "• propose_edit {path, instruction} — draft a full replacement file\n"
    "• apply_last_edit {summary} — write the draft (auto_apply required)\n"
    "• github_push {message} — commit + push\n"
    "• done {message} — END the turn with a short (<200 chars) message\n\n"
    "Strict rules:\n"
    "1. ALWAYS end turn with `done`. Max 4 steps total.\n"
    "2. For 'add X' requests: ONE propose_edit, then ONE done telling admin to ✅ Apply.\n"
    "3. For questions answerable without tools: ONE done with the answer.\n"
    "4. Never echo a tool result — read it, decide next step.\n"
    "5. Emit ONLY ONE fenced action block per response. Format:\n"
    "```action\n{\"tool\":\"done\",\"message\":\"…\"}\n```"
)

_AGENT_DRAFTS: dict[str, dict] = {}   # in-memory: {session_id: {path, new_content, ...}}


def _parse_action_block(reply: str) -> Optional[dict]:
    """Extract the first valid action-JSON from the LLM reply, even when the
    JSON itself contains '{}' inside string values. Uses brace counting that
    respects string literals."""
    import json as _json

    def find_objects(text: str) -> list[str]:
        out: list[str] = []
        n = len(text)
        i = 0
        while i < n:
            if text[i] != "{":
                i += 1
                continue
            depth = 0
            in_str = False
            esc = False
            start = i
            while i < n:
                c = text[i]
                if in_str:
                    if esc:
                        esc = False
                    elif c == "\\":
                        esc = True
                    elif c == '"':
                        in_str = False
                else:
                    if c == '"':
                        in_str = True
                    elif c == "{":
                        depth += 1
                    elif c == "}":
                        depth -= 1
                        if depth == 0:
                            out.append(text[start:i + 1])
                            i += 1
                            break
                i += 1
            else:
                break
        return out

    # First try fenced blocks (preferred)
    fenced = re.findall(r"```(?:action|json)?\s*([\s\S]*?)\s*```", reply)
    pools = fenced + [reply]
    for pool in pools:
        for raw in find_objects(pool):
            try:
                obj = _json.loads(raw)
            except Exception:
                continue
            if isinstance(obj, dict) and obj.get("tool"):
                return obj
    return None


def _normalize_path(p: str) -> str:
    """Map short paths the LLM might emit (e.g. 'index.css') to the allow-list key."""
    p = (p or "").lstrip("/")
    if p in EDITABLE_PATHS:
        return p
    # search for any allow-listed path that ends with the given name
    for key in EDITABLE_PATHS:
        if key.endswith("/" + p) or key.endswith(p):
            return key
    return p


async def _run_agent_tool(action: dict, session_key: str, auto_apply: bool) -> dict:
    """Execute one agent tool call. Returns a result dict that's sent back to the LLM."""
    tool = (action or {}).get("tool")
    if tool == "list_files":
        return {"ok": True, "files": [
            {"path": p, "description": d} for p, d in EDITABLE_PATHS.items()
        ]}
    if tool == "read_file":
        p = _normalize_path(action.get("path") or "")
        if p not in EDITABLE_PATHS:
            return {"ok": False, "error": f"path '{p}' not in allow-list", "allowed": list(EDITABLE_PATHS.keys())}
        content = _read_file(p)
        return {"ok": True, "path": p, "content": content[:15000],
                "truncated": len(content) > 15000, "size": len(content)}
    if tool == "propose_edit":
        p = _normalize_path(action.get("path") or "")
        instr = (action.get("instruction") or "").strip()
        if p not in EDITABLE_PATHS:
            return {"ok": False, "error": f"path '{p}' not editable", "allowed": list(EDITABLE_PATHS.keys())}
        if len(instr) < 5:
            return {"ok": False, "error": "instruction too short"}
        # Reuse the propose_edit logic
        try:
            current = _read_file(p)
            lang = "Python (FastAPI)" if p.endswith(".py") else ("React JSX" if p.endswith(".js") else "CSS")
            system = (
                f"You are a {lang} expert editing the source file '{p}' of Midget jr. "
                "Return the COMPLETE NEW FILE CONTENT — no markdown fences, no diff. "
                "Preserve all existing functionality except what the instruction asks to change. "
                "Output a syntactically complete file ready to save as-is."
            )
            prompt = f"INSTRUCTION:\n{instr}\n\nCURRENT FILE:\n{current}\n\nNew full file:"
            new_content = await llm_oneshot(system, prompt)
            new_content = re.sub(r"^```[a-zA-Z0-9]*\n", "", new_content.strip())
            new_content = re.sub(r"\n```$", "", new_content)
            diff = "".join(difflib.unified_diff(
                current.splitlines(keepends=True),
                new_content.splitlines(keepends=True),
                fromfile=f"a/{p}", tofile=f"b/{p}", n=2,
            ))
            _AGENT_DRAFTS[session_key] = {
                "path": p, "new_content": new_content,
                "old_size": len(current), "new_size": len(new_content),
                "instruction": instr,
            }
            return {"ok": True, "path": p, "old_size": len(current),
                    "new_size": len(new_content), "diff_preview": diff[:4000]}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    if tool == "apply_last_edit":
        if not auto_apply:
            return {"ok": False, "error": "auto_apply is OFF — ask the admin to click ✅ Apply in the UI."}
        draft = _AGENT_DRAFTS.get(session_key)
        if not draft:
            return {"ok": False, "error": "no proposed edit in this session"}
        try:
            current = _read_file(draft["path"])
            if current == draft["new_content"]:
                return {"ok": False, "error": "no change vs current file"}
            await self_edits.insert_one({
                "id": str(uuid.uuid4()),
                "path": draft["path"],
                "old_content": current,
                "new_content": draft["new_content"],
                "summary": (action.get("summary") or draft.get("instruction") or "")[:300],
                "created_at": _now(),
                "via": "agent",
            })
            _write_file(draft["path"], draft["new_content"])
            _AGENT_DRAFTS.pop(session_key, None)
            return {"ok": True, "applied": draft["path"]}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    if tool == "github_push":
        try:
            r = await github_push(GithubPushBody(message=action.get("message", "Midget jr. self-edit")))
            return {"ok": bool(r.get("pushed")), **r}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    if tool == "done":
        return {"ok": True, "done": True, "message": action.get("message") or ""}
    return {"ok": False, "error": f"unknown tool '{tool}'"}


@api.post("/admin/agent/chat", dependencies=[Depends(require_admin)])
async def agent_chat(body: AgentBody, authorization: Optional[str] = Header(None)):
    """Run a multi-step agent turn. The agent emits tool calls one at a time;
    we execute them in a loop (capped) and return a transcript of what happened."""
    session_key = (authorization or "")[:60]  # one draft slot per admin token
    transcript: list[dict] = []
    # Build the seed messages
    messages: list[dict] = [{"role": "system", "content": AGENT_SYSTEM}]
    for m in (body.history or [])[-20:]:
        role = m.get("role")
        text = (m.get("content") or "").strip()
        if role in ("user", "assistant", "system") and text:
            messages.append({"role": role, "content": text[:8000]})
    messages.append({"role": "user", "content": body.message})

    final_message = ""
    max_steps = 4
    for step in range(max_steps):
        try:
            reply = await llm_chat(messages, temperature=0.2)
        except HTTPException as e:
            transcript.append({"type": "error", "error": str(e.detail)})
            break
        except Exception as e:
            transcript.append({"type": "error", "error": str(e)})
            break
        action = _parse_action_block(reply)
        if not action:
            # Treat plain text as a done message
            transcript.append({"type": "say", "text": reply.strip()})
            final_message = reply.strip()
            break
        transcript.append({"type": "action", "action": action})
        messages.append({"role": "assistant", "content": reply})
        result = await _run_agent_tool(action, session_key, body.auto_apply)
        transcript.append({"type": "result", "result": result})
        # Feed result back as a TOOL-ROLE message (clean — no "TOOL RESULT:" prefix
        # so the LLM doesn't echo it as prose).
        import json as _json
        compact = _json.dumps({"tool": action.get("tool"), "result": result})[:4000]
        messages.append({"role": "user", "content": f"[system: tool output] {compact}\n\nNow emit your next action."})
        if action.get("tool") == "done" or result.get("done"):
            final_message = result.get("message") or action.get("message") or ""
            break
    else:
        if _AGENT_DRAFTS.get(session_key):
            final_message = "I drafted the change but ran out of steps before wrapping up. The pending draft is below — click ✅ Apply to write it."
        else:
            final_message = "Couldn't finish in 4 steps. Try giving me a more specific instruction (which file + what to change)."

    return {"transcript": transcript, "reply": final_message,
            "pending_draft": _AGENT_DRAFTS.get(session_key, None)}


@api.post("/admin/agent/apply", dependencies=[Depends(require_admin)])
async def agent_apply(authorization: Optional[str] = Header(None)):
    """Apply the agent's most recent pending draft (used when auto_apply is OFF)."""
    session_key = (authorization or "")[:60]
    draft = _AGENT_DRAFTS.get(session_key)
    if not draft:
        raise HTTPException(404, "No pending draft.")
    current = _read_file(draft["path"])
    if current == draft["new_content"]:
        _AGENT_DRAFTS.pop(session_key, None)
        return {"applied": False, "reason": "No change."}
    await self_edits.insert_one({
        "id": str(uuid.uuid4()),
        "path": draft["path"],
        "old_content": current,
        "new_content": draft["new_content"],
        "summary": (draft.get("instruction") or "")[:300],
        "created_at": _now(),
        "via": "agent",
    })
    _write_file(draft["path"], draft["new_content"])
    _AGENT_DRAFTS.pop(session_key, None)
    return {"applied": True, "path": draft["path"]}


@api.post("/admin/agent/discard", dependencies=[Depends(require_admin)])
async def agent_discard(authorization: Optional[str] = Header(None)):
    session_key = (authorization or "")[:60]
    _AGENT_DRAFTS.pop(session_key, None)
    return {"discarded": True}


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
    await access_codes.create_index("code", unique=True)
    await bug_reports.create_index("id", unique=True)
    await bug_reports.create_index("created_at")
    await exemplars.create_index("id", unique=True)
    await exemplars.create_index("approved")
    await exemplars.create_index("chat_id")
    await usernames.create_index("key", unique=True)
    await usernames.create_index("session_id", unique=True)
    await self_edits.create_index("id", unique=True)
    await self_edits.create_index("created_at")
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
