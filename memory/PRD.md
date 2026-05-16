# Midget jr. — Product Requirements (PRD)

## Original Problem Statement
User uploaded a single-file HTML app called **Midget jr.** — a self-growing knowledge bot with Chat, Query, Research, Code, and Queue modes — running on **base44** as backend. After a code review, the user asked to (a) fix flagged issues, (b) add file-import to grow the bot's knowledge, and (c) password-protect admin actions with `MidgetsRcool`. Then they asked to move off base44 to a real owned backend, and finally to make it **zero-cost forever** with **no strings attached**, deployable to **the cloud**.

## User Choices (final)
- **LLM:** Configurable via `LLM_PROVIDER` env. Supports **Google Gemini** (free tier, 1,500 req/day) **and Groq** (free tier, llama-3.1-8b-instant). User toggles by env var.
- **LLM access:** Uses each provider's **OpenAI-compatible endpoint** via the `openai` Python client → one code path for both.
- **NO Emergent dependency** — `emergentintegrations` removed from requirements; user owns every credential.
- **Web research:** Google primary (via googlesearch-python) + DuckDuckGo fallback (DDGS — works from datacenter IPs).
- **Admin password:** `MidgetsRcool`, bcrypt-hashed in MongoDB.
- **Deploy target:** Koyeb (backend) + MongoDB Atlas (db) + Vercel (frontend) + Gemini/Groq (LLM) — **all free, no credit cards anywhere**.
- **Auto-research scheduler:** Kept, runs every 6 hours, only fires when pending queue items exist.

## Architecture
| Layer | Tech | Free home |
|---|---|---|
| Frontend | React 19 (CRA), Catppuccin theme, Geist font, single `App.js` | **Vercel** free |
| Backend | FastAPI + Motor (async MongoDB) | **Koyeb** free (always-on web service) |
| LLM | `openai.AsyncOpenAI` → Gemini *or* Groq via OpenAI-compatible base URLs | **Gemini AI Studio** or **Groq Cloud** free tier |
| Web search | `googlesearch-python` → `ddgs` fallback | Free, no key |
| Web scrape | `httpx` + `BeautifulSoup4` | — |
| Auth | bcrypt + 7-day JWT | — |
| Scheduler | `APScheduler` (in-process, every 6h) | — |
| Persistence | MongoDB: `knowledge_entries`, `research_queue`, `app_config` | **MongoDB Atlas** M0 free (512 MB forever) |

## Environment Variables (all configurable)
| Var | Purpose |
|---|---|
| `MONGO_URL` | MongoDB connection (Atlas SRV string in prod) |
| `DB_NAME` | Database name (default `midgetjr_db`) |
| `JWT_SECRET` | JWT signing secret |
| `ADMIN_PASSWORD` | Admin password (seeded into bcrypt hash on startup) |
| `LLM_PROVIDER` | `gemini` (default) or `groq` — toggle without code changes |
| `GEMINI_API_KEY` | Free key from aistudio.google.com/apikey |
| `GEMINI_MODEL` | Default `gemini-2.0-flash` (most generous free quota) |
| `GROQ_API_KEY` | Free key from console.groq.com/keys |
| `GROQ_MODEL` | Default `llama-3.1-8b-instant` |
| `CORS_ORIGINS` | Comma-separated allowed origins |

## Endpoints (all under `/api`)
**Public:** `GET /`, `POST /unlock`, `POST /chat`, `POST /query`, `POST /research`, `POST /code`, `GET /knowledge`, `GET /queue`
**Admin (Bearer JWT):** `POST /knowledge/import`, `DELETE /knowledge/{id}`, `POST /queue`, `DELETE /queue/{id}`, `POST /queue/run`

## What's Implemented (2026-01-16)
- ✅ Full migration off base44 → owned FastAPI/MongoDB backend
- ✅ Pluggable free LLM (Gemini default, Groq alternative) via OpenAI-compatible endpoints
- ✅ Zero Emergent dependency — `emergentintegrations` uninstalled
- ✅ All 6 frontend tabs: Chat, Query, Research, Code, Import, Queue
- ✅ Lock toggle, password modal, sessionStorage JWT
- ✅ Chat persists in localStorage, replays last 6 turns
- ✅ File import (drag-drop + click), 25+ text formats, 1MB cap
- ✅ Auto-research scheduler (6h, only on pending items)
- ✅ Catppuccin theme + Geist font
- ✅ XSS-safe DOM rendering
- ✅ bcrypt password seed re-runs if ADMIN_PASSWORD env changes
- ✅ Helpful error messages when API key is missing (points user to free signup URL)
- ✅ Testing subagent verified: 11/11 backend tests pass, all critical frontend flows pass
- ✅ **Deploy artifacts written:** `backend/Dockerfile`, `render.yaml`, `frontend/vercel.json`, `DEPLOY.md` (step-by-step click-by-click guide)

## What's Waiting On the User
- 🟡 **Gemini API key** — user said they'd grab one at aistudio.google.com/apikey and paste it. Once pasted into `GEMINI_API_KEY` env, all LLM features come alive. Backend returns a friendly error pointing at the signup URL until then.

## Known Limitations / Backlog
- KB search is regex-based (no embeddings) — fine for hundreds of docs (P1).
- No KB management UI — can import/delete via API only (P1).
- APScheduler is in-process; durable cron needs Redis-backed queue (P2).
- No rate limiting on public endpoints — add before any public deployment (P1).
- Ollama (truly local zero-cloud) not wired in yet but documented in DEPLOY.md (P2).

## Next Action Items (priority)
1. **(blocking)** User pastes Gemini API key → re-test chat/research/code end-to-end.
2. **(P1)** KB management panel in UI.
3. **(P1)** Rate limiting before public deploy.
4. **(P2)** Ollama as a third provider option.
