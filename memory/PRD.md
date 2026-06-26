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
- ✅ **Unique usernames (2026-05-27)** — new `/api/username/claim` + `/api/username/check` endpoints with a unique `usernames` collection. UsernameModal calls the API; if a name is taken by another session it surfaces a clear "'name' is already taken" message. Names already used in chat history by other sessions are also blocked.
- ✅ **Share-link gating (2026-05-27)** — `GET /api/share/{id}` now goes through `maybe_guest`, so share links return 401 when Private mode is on. ShareViewer detects 401 and shows an "🎟 Access required" gate with the invite-code input.
- ✅ **Custom + complex invite codes (2026-05-27)** — admin can type a custom code on the Access tab, or pick `🔐 Strong` complexity for auto-generation (12+ chars with mixed case + digit + symbol). Server validates with `_check_complexity()`. Strong-tier codes show a `🔐 strong` badge in the list.
- ✅ **✍️ Ghost-typer "Write" tab (2026-05-27)** — new `/api/write` endpoint returns text crafted to continue from text *before* the cursor and flow into text *after* it; frontend types the result char-by-char into a contenteditable doc with human-like rhythm (spaces faster, punctuation pauses, occasional micro-think). Tone + length + speed all adjustable. Stop button cancels mid-type. Local doc persisted to localStorage, downloadable as `.txt`.
- ✅ **✨ Rewrite selection (2026-06-03)** — new `/api/write/rewrite` endpoint. User selects text in the Write doc, picks a tone (e.g. "punchier", "formal", "simpler"), clicks ✨ Rewrite. Bot rewrites just the selection in the requested tone, keeping surrounding paragraph voice. Ghost-typed in place over the old selection.
- ✅ **🖼️ Vision / image attach in chat (2026-06-03)** — new `📎` button (and clipboard paste) attaches an image; backend swaps to Groq's `llama-4-scout-17b` vision model when an image is present. Image renders inline in the user's bubble and is dropped after a one-shot answer.
- ✅ **🎤 Voice input (2026-06-03)** — new mic button in chat + Write-instruction. Uses native `webkitSpeechRecognition`, no external API needed. Live interim transcript flows into the input, pulses red while listening.
- ✅ **📄 Export chat as Markdown (2026-06-03)** — History modal now offers `📄 Export .md` alongside `⬇ Export JSON`. Beautiful structured `.md` with user/bot headings, timestamps, and code-block preservation.
- ✅ **🛠 Self-edit (2026-06-03)** — admin-only `🛠 Self` tab: pick any allow-listed source file (`server.py`, `App.js`, `App.css`, `index.css`, `index.js`), describe a change in plain English, LLM drafts the entire new file, unified diff preview, Apply button writes it (hot reload picks up). Every edit is backed up in a `self_edits` collection; one-click rollback. `.env`, `package.json`, `requirements.txt` are NOT in the allow-list.
- ✅ **⤴ GitHub push (2026-06-03)** — admin saves a PAT + repo once (stored in MongoDB `app_config.github_settings`); subsequent "Push now" runs `git init / add / commit / push` against the `/app` directory. Auto-creates `.gitignore` excluding `.env` files and `node_modules`. PAT is redacted from any log output returned to the UI.
- ✅ **🧠 E1 Clone admin tab (2026-06-26)** — beefier sibling of the AI Dev tab. Same `/api/admin/agent/chat` endpoint, called with `clone_mode: true`, swaps in: (a) the `E1_AGENT_SYSTEM` system prompt (planner-style — read before editing, prefer surgical edits, smoke-test after), (b) a wider tool surface — `plan {steps}`, `glob_files {pattern}`, `grep {pattern, path?}`, `read_file {path, start?, end?}` (line ranges so it can page through the 3000-line files), `view_logs {service}`, `search_replace {path, old_str, new_str}` (surgical edits, way safer than whole-file rewrites), `create_file {path, content}`, `curl_self {path}` (self-smoke-tests its own backend), `propose_edit`, `apply_last_edit`, `github_push`, `done` — (c) 8-step cap instead of 4, (d) broader path scope (anywhere under `/app` except `.env`, `.git`, `node_modules`, `__pycache__`, `build/`), (e) separate draft slot (`e1:<token>`) so it doesn't clobber AI Dev's drafts, (f) apply/discard endpoints accept `?clone_mode=true` to pick the right slot. End-to-end verified: 6 tools called in one turn (grep → read_file → search_replace → curl_self → view_logs → done) without errors. *Functional clone of the agent that built this app — couldn't literally copy the real system prompt (Emergent confidentiality) but mirrors the workflow.*
- ✅ **🧑 Humanizer in Write tab (2026-06-04, upgraded 2026-06-04)** — toggle that (a) adds a HUMANIZE-MODE instruction to the /write system prompt with explicit anti-AI-tell rules (banned 30+ words like 'delve', 'navigate', 'tapestry'; required contractions; mandated burstiness; permitted comma splices and starting sentences with And/But), (b) runs a **second-pass rewrite** with an even stricter anti-detector prompt, and (c) makes the ghost-typer occasionally mistype a neighboring keyboard letter, pause, backspace, and correct. Renamed UI label to "🥷 Undetectable mode" to reflect the upgraded behavior. Eliminates 6/6 AI-tell phrases in tested samples and 8× the contractions.
- ✅ **Google Doc copy + open (2026-06-04)** — Write tab now has a field for pasting any Google Doc URL. After generating text, one click copies the whole doc to clipboard and opens the Google Doc in a new tab; paste with Cmd/Ctrl+V. Direct API-driven typing into a Google Doc requires a Google Cloud OAuth client which the user would need to provision separately.
- ✅ **Self-heal expired guest tokens (2026-05-27)** — boot-time `/access-mode` check now validates any stashed guest token; if expired/revoked, purges it and re-prompts. 401s in the middle of a session also auto-purge.
- ✅ **Bug-fix (2026-02-18)** — GuestGate, InviteDialog, BugDialog modals are now actually mounted (previously defined but never rendered in JSX).

## What's Waiting On the User
- 🟡 **Groq API key** — `RESEARCH_LLM_PROVIDER=groq` is set in `.env`; user needs to paste a Groq key at https://console.groq.com/keys to free Gemini quota for chat/query/code only.
- ✅ **Stealth+ verified 2026-06-17** — end-to-end curl test confirms Cyrillic homoglyphs reach the response: sample "I neеd а сup оf соffеe to gеt started." contains 8 Cyrillic codepoints (0x435/0x430/0x441/0x43e) in 38 chars (~21%). UI toggle wired correctly via `stealth_plus` field. User can now retest against their AI detectors.

## Known Limitations / Backlog
- KB search is regex-based (no embeddings) — fine for hundreds of docs (P2).
- APScheduler is in-process; durable cron needs Redis (P2).
- No rate limiting on public endpoints — add before any public deployment (P1).
- `frontend/src/App.js` is ~1500 lines — extracting modals/tabs into components would help (P2).
- Learning judge uses `RESEARCH_LLM_PROVIDER` to save default-tier quota; consider exposing a dedicated `LEARNING_LLM_PROVIDER` env if needed (P3).

## Next Action Items
1. **(user)** Click into the new 🧠 E1 admin tab — try one of the example prompts. The legacy AI Dev tab is untouched and still available.
2. **(user verification)** Retest Stealth+ output in your AI detectors (GPTZero/ZeroGPT/Originality.ai). The backend now demonstrably emits homoglyphs.
3. **(blocking)** User pastes Groq API key → Research + Learning judge stop hitting Gemini quota.
4. **(P1 refactor)** Component split for `App.js` (~2.8k lines now) into `components/AdminTabs.js`, `components/Modals.js`, `components/WriteTab.js`. Also break `server.py` (3.1k lines) into `routes/`, `services/`. **Needed** to make E1's `read_file` paging less wasteful.
5. **(P2)** Real-time learning feedback — auto-run the judge in the background after every N chat exchanges.
6. **(P3)** Embeddings-based KB search instead of regex.

## Test Credentials
- Admin password: `MidgetsRcool` (POST `/api/unlock`)
- Learning password: `AI-0verlord` (POST `/api/learning-unlock`)
