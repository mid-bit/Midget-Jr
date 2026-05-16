---
title: Midget Jr Backend
emoji: 🧠
colorFrom: purple
colorTo: pink
sdk: docker
app_port: 8000
pinned: false
license: mit
---

# Midget jr. — Backend (Hugging Face Space)

FastAPI backend for the Midget jr. self-growing knowledge bot.

This Space hosts only the API. The React frontend lives separately (Vercel) and points at this Space's URL.

## Required secrets

Set these in **Settings → Variables and secrets** on this Space:

| Secret | Required | What it is |
|---|---|---|
| `MONGO_URL` | ✅ | MongoDB Atlas connection string |
| `DB_NAME` |  | Default `midgetjr_db` |
| `JWT_SECRET` | ✅ | Any long random string |
| `ADMIN_PASSWORD` | ✅ | The admin password (default `MidgetsRcool`) |
| `LLM_PROVIDER` |  | `gemini` (default) or `groq` |
| `GEMINI_API_KEY` | ✅ if using Gemini | Free at https://aistudio.google.com/apikey |
| `GEMINI_MODEL` |  | Default `gemini-2.5-flash` |
| `GROQ_API_KEY` |  | Free at https://console.groq.com/keys |
| `GROQ_MODEL` |  | Default `llama-3.1-8b-instant` |
| `CORS_ORIGINS` |  | Default `*` (tighten to your Vercel domain in prod) |

## Endpoints

All under `/api/...`. Visit `/api/` for a quick health check.
