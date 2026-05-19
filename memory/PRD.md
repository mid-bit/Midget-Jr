# Midget jr. — Product Requirements (PRD)

## Original Problem Statement
User uploaded a single-file HTML app **Midget jr.** (Chat / Query / Research / Code / Queue) running on the `base44` proprietary backend. They asked, in order, to: (1) fix flagged bugs, (2) add file-import to grow the bot's knowledge, (3) password-protect admin with `MidgetsRcool`, (4) move off base44 to an owned backend, (5) make it **zero-cost forever, no strings**, (6) add PWA, chat history, per-tab isolation, Direct Mode, user-style mimicry, guest invite codes, bug reporting, share links + QR, (7) add a **Learning Mode** (LLM-as-judge reinforcement) gated by `AI-0verlord`, and (8) route **Research** through Groq while keeping **Chat/Query** on Gemini.

## Architecture (current)
| Layer | Tech | Free home |
|---|---|---|
| Frontend | React 19 (stripped CRA), Catppuccin theme, single `App.js` | Vercel |
| Backend | FastAPI + Motor (async MongoDB) | Render / Koyeb |
| LLM | `openai.AsyncOpenAI` → Gemini *or* Groq via OpenAI-compatible base URLs | Gemini AI Studio + Groq Cloud |
| Web search | googlesearch-python → ddgs fallback | free, no key |
| Web scrape | httpx + BeautifulSoup4 | — |
| Auth | bcrypt + JWT (admin 7d, guest mirrors code expiry, learning 30d) | — |
| Scheduler | APScheduler in-process, every 6h | — |
| DB | MongoDB collections: `knowledge_entries`, `research_queue`, `app_config`, `shares`, `chat_messages`, `question_log`, `access_codes`, `bug_reports`, `exemplars` | MongoDB Atlas M0 |

## Environment Variables
| Var | Purpose |
|---|---|
| `MONGO_URL` / `DB_NAME` | MongoDB |
| `JWT_SECRET` | JWT signing |
| `ADMIN_PASSWORD` | Admin (`MidgetsRcool`), bcrypt-seeded |
| `LEARNING_PASSWORD` | Learning Mode gate (`AI-0verlord`) |
| `LLM_PROVIDER` | Default provider: `gemini` or `groq` (chat/query/code) |
| `RESEARCH_LLM_PROVIDER` | Optional override for Research mode (set `groq` to save Gemini quota) |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | Gemini config (default `gemini-2.0-flash`, currently `gemini-2.5-flash`) |
| `GROQ_API_KEY` / `GROQ_MODEL` | Groq config (default `llama-3.1-8b-instant`) |
| `CORS_ORIGINS` | comma-separated allow list |

## Endpoints (all under `/api`)
**Public:** `/`, `/unlock`, `/chat`, `/query`, `/research`, `/code`, `/knowledge`, `/queue`, `/share`, `/share/{id}`, `/access-mode`, `/guest-auth`, `/bug-reports`, `/direct-mode`, `/chat/history/{session}`
**Admin (Bearer JWT):** `/knowledge/import`, `/knowledge/{id}` DELETE, `/queue` POST, `/queue/{id}` DELETE, `/queue/run`, `/admin/direct-mode`, `/admin/access-mode`, `/admin/access-codes` GET/POST, `/admin/access-codes/{code}` DELETE, `/admin/bug-reports` GET, `/admin/bug-reports/{id}` DELETE, `/admin/visitors`, `/admin/chat-log`
**Learning (Bearer JWT):** `/learning-unlock`, `/learning/run`, `/admin/exemplars` GET, `/admin/exemplars/{id}` DELETE, `/admin/exemplars/{id}/toggle`

## What's Implemented
- ✅ Full migration off base44 → owned FastAPI/MongoDB
- ✅ Pluggable free LLM (Gemini default, Groq alt) via OpenAI-compatible endpoints
- ✅ **Per-mode LLM routing**: `RESEARCH_LLM_PROVIDER` env can override the provider just for Research. Falls back gracefully if the override key is missing.
- ✅ **Currently running on Groq end-to-end (2026-02-19)** — `LLM_PROVIDER=groq` with `llama-3.1-8b-instant`; replaces Gemini after user hit daily quota.
- ✅ 6 frontend tabs (Chat, Query, Research, Code, Import, Queue) + 4 admin tabs (Manage, Visitors, Access, Bugs) + Learning tab
- ✅ Catppuccin theme, per-tab message isolation, tab intros, welcome banner
- ✅ Persistent chat archive (5000 cap, localStorage), date-grouped history modal, export-JSON
- ✅ XSS-safe DOM rendering, bcrypt admin seed, helpful missing-key errors
- ✅ Auto-research scheduler (6h, only when pending) + auto-promote popular questions
- ✅ Direct Mode toggle (admin) — drops disclaimers on edgy-but-legit topics; absolute red lines kept
- ✅ Behavior files (admin), per-user style mimicry (from owner-tagged uploads)
- ✅ Guest invite codes with expiry + max uses, Private mode toggle, Share+QR modal, Bug reports + screenshots
- ✅ PWA install button
- ✅ **Learning Mode (2026-02-18)** — password gate `AI-0verlord`, LLM-as-judge endpoint reads recent chats, scores each Q+A 0–10 on "helps humanity + truth + cites real sources + no health risk", saves approved ones to `exemplars` collection. Top 4 approved exemplars are injected as few-shot examples into every chat's system prompt. Admin can manually approve/reject/delete from the Learning tab.
- ✅ **Citation styles (2026-02-19)** — chat-tab dropdown: None / Numbered [1] / MLA / APA / Chicago / IEEE. Selected style is sent to `/api/chat`, which injects a truthfulness-contract + citation-format instruction into the system prompt. Bot is instructed to quote sources verbatim where possible, never fabricate citations.
- ✅ **👍 Teach Midget button (2026-02-19)** — every bot reply now has a "👍 Teach" button. One click runs the LLM judge on just that one Q+A pair, shows the verdict inline, and saves it as a high-priority exemplar (auto-approved if score ≥ 7, else pending admin review).
- ✅ **Friendlier LLM-quota errors (2026-02-19)** — when Gemini/Groq returns 429, the user sees "⏳ Gemini daily quota reached. Paste a Groq key into backend/.env (GROQ_API_KEY) or wait for the daily reset." instead of "HTTP 502".
- ✅ **Rate limiting (2026-02-19)** — slowapi middleware caps every IP at 60 requests/minute globally; emits `X-RateLimit-*` headers and a friendly 429 message.
- ✅ **Frontend `api()` helper switched from fetch → XHR (2026-02-19)** — the dev preview environment installs a global `fetch` interceptor that drains the response body before app code can read it; XHR isn't intercepted the same way, so error bodies now reach the UI.
- ✅ **UI polish (2026-02-19)** — header redesigned with unified `.hbtn` style: pill buttons, hover lift, accent-coloured states (Direct ON = amber, Learning ON = teal, Unlocked = green), labels collapse on narrow screens. Tab pills are translucent until active, with the language/citation selector cleanly anchored right via new `.tab-pill-select` style.
- ✅ **Bug-fix (2026-02-18)** — GuestGate, InviteDialog, BugDialog modals are now actually mounted (previously defined but never rendered in JSX).

## What's Waiting On the User
- 🟡 **Groq API key** — `RESEARCH_LLM_PROVIDER=groq` is set in `.env`; user needs to paste a Groq key at https://console.groq.com/keys to free Gemini quota for chat/query/code only.

## Known Limitations / Backlog
- KB search is regex-based (no embeddings) — fine for hundreds of docs (P2).
- APScheduler is in-process; durable cron needs Redis (P2).
- No rate limiting on public endpoints — add before any public deployment (P1).
- `frontend/src/App.js` is ~1500 lines — extracting modals/tabs into components would help (P2).
- Learning judge uses `RESEARCH_LLM_PROVIDER` to save default-tier quota; consider exposing a dedicated `LEARNING_LLM_PROVIDER` env if needed (P3).

## Next Action Items
1. **(blocking)** User pastes Groq API key → Research + Learning judge stop hitting Gemini quota.
2. **(P2)** Component split for App.js (~1700 lines now) into `components/AdminTabs.js`, `components/Modals.js`.
3. **(P2)** Real-time learning feedback — auto-run the judge in the background after every N chat exchanges.
4. **(P3)** Embeddings-based KB search instead of regex.

## Test Credentials
- Admin password: `MidgetsRcool` (POST `/api/unlock`)
- Learning password: `AI-0verlord` (POST `/api/learning-unlock`)
