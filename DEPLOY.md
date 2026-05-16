# Deploy Midget jr. for $0/month forever

This is the click-by-click guide to put your Midget jr. on the cloud with **zero recurring cost** and **no credit card** required (anywhere in the stack).

The free stack:

| Piece | Provider | Free tier | Account needed |
|---|---|---|---|
| Backend (FastAPI) | **Koyeb** | Always-on free web service | Yes, no card |
| Database | **MongoDB Atlas** | 512 MB cluster (M0) forever | Yes, no card |
| Frontend | **Vercel** | Generous free static hosting | Yes, no card |
| LLM | **Google Gemini** (or Groq) | 1,500 free requests/day | Yes, no card |
| Background research cron | Built into the backend | — | — |

**Total monthly cost: $0.** Total accounts you create: 4. All free, all no-card.

---

## Step 1 — Get a free LLM API key (60 seconds)

### Option A: Google Gemini (recommended — most generous free tier)
1. Go to <https://aistudio.google.com/apikey>
2. Sign in with any Google account
3. Click **"Create API key"** → **"Create API key in new project"**
4. Copy the key (starts with `AIza...`)
5. Save it somewhere safe — you'll paste it into Koyeb in Step 4

### Option B: Groq (faster, free, lower daily limit)
1. Go to <https://console.groq.com/keys>
2. Sign up with Google/GitHub (no card needed)
3. Click **"Create API Key"**, give it a name
4. Copy the key (starts with `gsk_...`)

You can configure **both** keys and toggle by setting `LLM_PROVIDER=gemini` or `LLM_PROVIDER=groq` in env vars.

---

## Step 2 — Create a free MongoDB cluster (5 minutes)

1. Go to <https://www.mongodb.com/cloud/atlas/register>
2. Sign up (Google sign-in works fine, no card)
3. After signup, on the deployment screen:
   - Pick **"M0"** (FREE — labeled clearly)
   - Provider: any (AWS is the safe default)
   - Region: closest to you
   - Cluster name: `midgetjr` (or whatever)
   - Click **"Create Deployment"**
4. Atlas will ask you to create a **database user**:
   - Username: `midget`
   - Password: click "Autogenerate Secure Password", **copy it now** (you can't see it later)
   - Click "Create Database User"
5. It will ask for **Network Access** → click **"Add IP: 0.0.0.0/0"** (allow from anywhere — Koyeb needs this)
6. Once the cluster is green, click **"Connect"** → **"Drivers"** → copy the connection string. It looks like:
   ```
   mongodb+srv://midget:<password>@midgetjr.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
7. **Replace `<password>` with the actual password** you saved in step 4. Save the full string.

---

## Step 3 — Push your code to GitHub

If your repo isn't on GitHub yet, in the Emergent chat input, hit **"Save to GitHub"**. That gives you a repo URL like `https://github.com/<you>/<midgetjr>`.

---

## Step 4 — Deploy the backend on Koyeb (5 minutes)

1. Go to <https://www.koyeb.com> → **Sign up** (Google/GitHub, no card)
2. Once in the dashboard → **"Create Web Service"**
3. Pick **"GitHub"** as the source → authorize Koyeb → pick your repo
4. **Build settings:**
   - Builder: **Dockerfile**
   - Dockerfile location: `backend/Dockerfile`
   - Work directory: `backend`
5. **Instance type:** Free (eco)
6. **Ports:** Koyeb auto-detects `8000` from the Dockerfile. Leave defaults.
7. **Environment variables** — add these one by one:

   | Key | Value |
   |---|---|
   | `MONGO_URL` | (paste the Atlas string from Step 2) |
   | `DB_NAME` | `midgetjr_db` |
   | `JWT_SECRET` | (any random string, e.g. `openssl rand -hex 32` output) |
   | `ADMIN_PASSWORD` | `MidgetsRcool` |
   | `LLM_PROVIDER` | `gemini` |
   | `GEMINI_API_KEY` | (your Gemini key from Step 1) |
   | `GEMINI_MODEL` | `gemini-2.0-flash` |
   | `GROQ_API_KEY` | (your Groq key, optional) |
   | `GROQ_MODEL` | `llama-3.1-8b-instant` |
   | `CORS_ORIGINS` | `*` (tighten later to your Vercel domain) |

8. Service name: `midgetjr-backend` → **Deploy**
9. Wait ~3 minutes for the build. When you see ✅, copy the public URL — something like:
   ```
   https://midgetjr-backend-<user>.koyeb.app
   ```
10. Test it: open `<that-url>/api/` in your browser. You should see:
    ```json
    {"app":"Midget jr.","ok":true,"provider":"gemini","model":"gemini-2.0-flash","key_configured":true}
    ```

---

## Step 5 — Deploy the frontend on Vercel (3 minutes)

1. Go to <https://vercel.com/signup> (use GitHub sign-in, no card)
2. **"Add New… → Project"** → pick your GitHub repo
3. Vercel auto-detects React. Set:
   - **Root directory:** `frontend`
   - **Framework Preset:** Create React App (auto)
4. **Environment Variables** — add one:

   | Key | Value |
   |---|---|
   | `REACT_APP_BACKEND_URL` | (the Koyeb URL from Step 4, e.g. `https://midgetjr-backend-xxx.koyeb.app`) |

5. Click **"Deploy"**. Wait ~2 minutes.
6. Vercel gives you a URL like `https://midgetjr-<user>.vercel.app`. Open it.
7. You should see the Midget jr. UI. Click the 🔒 → password `MidgetsRcool` → unlocked.

---

## Step 6 — Tighten CORS (optional but recommended)

Go back to Koyeb → your service → **Environment** → edit `CORS_ORIGINS` to:
```
https://midgetjr-<user>.vercel.app
```
Save → service auto-redeploys.

---

## You're done. $0/month forever.

What you have:
- ✅ Your own bot, your data, your keys
- ✅ Free LLM (Gemini 2.0 Flash — 1,500 calls/day = plenty)
- ✅ Auto-research every 6 hours, only fires on pending queue items
- ✅ Password-protected admin actions
- ✅ Always-on (Koyeb free tier doesn't sleep)

## Switching providers later

To switch from Gemini → Groq, just change `LLM_PROVIDER=groq` in Koyeb env vars. Done. No code changes.

To swap to a different Gemini model (e.g., `gemini-2.5-flash` for better reasoning, smaller free quota), edit `GEMINI_MODEL`.

## Going local-only (zero cloud at all)

If you'd rather run it on your own computer with Ollama (no API key, no cloud, no rate limit):
1. Install Ollama: <https://ollama.com>
2. Pull a model: `ollama pull llama3.2`
3. Ollama exposes an OpenAI-compatible endpoint at `http://localhost:11434/v1`
4. In `/app/backend/.env`, override:
   ```
   LLM_PROVIDER=groq                # we reuse the groq codepath for any OpenAI-compat endpoint
   GROQ_API_KEY=ollama              # Ollama ignores the key but the field must be non-empty
   GROQ_MODEL=llama3.2
   ```
   …then change the `GROQ_BASE` constant in `server.py` to `http://localhost:11434/v1`. (Easier to add an OLLAMA option — ask me to wire it in if you want.)

## Costs to keep an eye on

- **Gemini quota:** 1,500 req/day. The auto-research scheduler will use at most ~5–20 calls per 6h. Chat is on you.
- **Koyeb free:** 1 service, always-on. Don't sleep.
- **Atlas free:** 512 MB. ~5,000 typical knowledge entries fit easily.
- **Vercel free:** 100 GB bandwidth/mo — way more than a personal bot will use.

If you ever bump against a free limit, the upgrade is opt-in. No surprise charges.
