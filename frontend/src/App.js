import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import "./App.css";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;
const UNLOCK_KEY = "mj_token";
const LEARN_KEY = "mj_learning_token";
const HISTORY_KEY = "mj_chat_history";   // rolling short window for LLM context
const ARCHIVE_KEY = "mj_chat_archive";   // local-device full archive
const USERNAME_KEY = "mj_username";
const SESSION_KEY = "mj_session_id";
const GUEST_TOKEN_KEY = "mj_guest_token";
const MAX_FILE_BYTES = 1024 * 1024;

const EXT_MAP = {
  python: "py", javascript: "js", typescript: "ts", java: "java",
  "c++": "cpp", go: "go", rust: "rs", sql: "sql", bash: "sh",
  html: "html", css: "css", json: "json", markdown: "md",
};

const downloadText = (filename, text, mime = "text/plain") => {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const MODE_COLORS = {
  chat: "#f38ba8", query: "#89b4fa", research: "#a6e3a1",
  code: "#cba6f7", import: "#fab387", queue: "#f9e2af",
  visitors: "#74c7ec", manage: "#f5c2e7", learning: "#94e2d5",
  write: "#f5e0dc", self: "#eba0ac", dev: "#cba6f7",
};
const MODE_LABELS = {
  chat: "💬 Chat — ask me anything, I'll use my knowledge base + AI",
  query: "🔍 Query — search exact entries in the knowledge base",
  research: "🌐 Research — fetch info from the web (Google) and save it",
  code: "💻 Code — generate code with AI (download any file type)",
  write: "✍️ Write — let the AI type into your document right at your cursor",
  import: "📂 Import — upload files to grow Midget's brain (admin)",
  manage: "🗂 Manage — list, search, delete knowledge entries (admin)",
  queue: "📋 Queue — topics scheduled for auto-research every 6 hours",
  visitors: "👥 Visitors — see who's been asking what (admin)",
  learning: "🧪 Learning — judge past answers and save the good ones as exemplars",
};
const MODE_PLACEHOLDERS = {
  chat: "Ask me anything...",
  query: "Search the knowledge base...",
  research: "Enter a topic to research from the web...",
  code: "Describe the code you need... (try: 'an HTML page with a counter button')",
};

const MODE_INTROS = {
  chat: "Ask anything in plain English. I'll answer with my AI brain plus anything I've learned in my knowledge base. Watch for the 📚 badge — it means I used a saved entry.",
  query: "Search what's already in my brain. This doesn't use AI or hit the web — it's a fast lookup over imported files and past research. Type a keyword to find matching entries.",
  research: "Give me a topic and I'll Google it, scrape the top sources, write a summary with citations, and save it to my brain forever. Anyone using this site helps me grow.",
  code: "Describe what you want, pick a language, I'll write it. Hit ⬇ Download to save it as a real file. Try 'an HTML page with a counter' or 'a Python script that renames files'.",
  import: "Drop in text-based files (.md, .txt, .json, .py, .html …) and I'll absorb them into my brain. Use this to teach me about your projects, notes, or anything I should remember.",
  manage: "Browse, search, and delete the entries inside my brain. Each came from Research, Import, or auto-research. Removing one means I'll forget it.",
  queue: "Topics scheduled for me to research automatically every 6 hours. Auto-promoted entries (🤖) appear when 3+ visitors ask similar questions — I notice patterns and dig in on my own.",
  visitors: "See who's been chatting with me. Click any name to filter the question log. This is your audit trail of what visitors are asking.",
  access: "Generate invite codes for friends, set expirations, and revoke access. Flip 'Private mode' on to require a code before anyone can chat.",
  bugs: "Bug reports submitted by visitors via the 🐛 Bug button in the header. Includes screenshots if attached.",
  learning: "Reinforcement-by-judging. Run a pass and an LLM judge rates each past answer on whether it helps humanity and carries no health risk. Approved Q+A pairs become in-context exemplars that future replies imitate.",
  self: "⚠️ Self-edit zone. Pick a file, describe a change in plain English, preview the diff, then apply. Every edit is backed up — you can roll back one click. Push to GitHub once you've added your PAT.",
  dev: "🤖 Midget Dev. Talk to me like you talk to a real engineer — 'add a /health endpoint', 'change the chat tab color to teal', 'push to github'. I'll read files, draft changes, and apply with your approval (or auto-apply if you enable it).",
};

const WELCOME_DISMISS_KEY = "mj_welcome_dismissed";

const LANGS = ["python","javascript","typescript","java","c++","go","rust","sql","bash","html","css","json","markdown"];
const CATEGORIES = ["General","Science","Technology","History","Math","Health","Philosophy","Art"];
const CITATION_STYLES = [
  { id: "none",     label: "No citations" },
  { id: "numbered", label: "Numbered [1]" },
  { id: "mla",      label: "MLA (parenthetical + Works Cited)" },
  { id: "apa",      label: "APA (author-date + References)" },
  { id: "chicago",  label: "Chicago (author-date)" },
  { id: "ieee",     label: "IEEE [1] (numbered references)" },
];
const CITATION_KEY = "mj_citation_style";
const ACCEPT = ".txt,.md,.markdown,.json,.csv,.log,.yaml,.yml,.xml,.html,.htm,.css,.js,.mjs,.ts,.tsx,.jsx,.py,.go,.rs,.java,.cpp,.cc,.c,.h,.hpp,.sh,.bash,.sql,.toml,.ini,.conf,.rb,.php,.swift,.kt";

const uuid = () => "s" + Math.random().toString(36).slice(2) + Date.now().toString(36);
const loadJSON = (k, fallback) => {
  try { const x = JSON.parse(localStorage.getItem(k) || "null"); return x == null ? fallback : x; }
  catch { return fallback; }
};
const saveJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const getToken = () => sessionStorage.getItem(UNLOCK_KEY) || "";
const setToken = (t) => t ? sessionStorage.setItem(UNLOCK_KEY, t) : sessionStorage.removeItem(UNLOCK_KEY);
const getLearnToken = () => localStorage.getItem(LEARN_KEY) || "";
const setLearnToken = (t) => t ? localStorage.setItem(LEARN_KEY, t) : localStorage.removeItem(LEARN_KEY);
const getOrCreateSessionId = () => {
  let s = localStorage.getItem(SESSION_KEY);
  if (!s) { s = uuid(); localStorage.setItem(SESSION_KEY, s); }
  return s;
};

async function api(path, { method = "GET", body, auth = false, learn = false } = {}) {
  const methodU = String(method).toUpperCase();   // belt-and-braces against case bugs
  const headers = { "Content-Type": "application/json" };
  if (learn) {
    const t = getLearnToken() || getToken();   // admin token also works for Learning endpoints
    if (!t) throw new Error("Learning mode locked — unlock first");
    headers.Authorization = `Bearer ${t}`;
  } else if (auth) {
    const t = getToken();
    if (!t) throw new Error("Locked — unlock first");
    headers.Authorization = `Bearer ${t}`;
  } else {
    const gtok = localStorage.getItem(GUEST_TOKEN_KEY);
    const admin = getToken();
    if (admin) headers.Authorization = `Bearer ${admin}`;
    else if (gtok) headers.Authorization = `Bearer ${gtok}`;
  }
  // We use XMLHttpRequest instead of fetch because the dev preview environment
  // installs a global fetch interceptor that consumes the body stream before
  // our code gets a chance to read it. XHR isn't intercepted the same way.
  // Long timeout (3 min) — agent + LLM calls can take a while when Render's
  // free tier is cold.
  const { status, ok, text } = await new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open(methodU, `${API}${path}`, true);
    xhr.timeout = 180000;
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.onload = () => resolve({ status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, text: xhr.responseText || "" });
    xhr.onerror = () => resolve({ status: 0, ok: false, text: "", networkError: true });
    xhr.ontimeout = () => resolve({ status: 0, ok: false, text: "", networkError: true, timedOut: true });
    xhr.send(body ? JSON.stringify(body) : null);
  });
  if (status === 0) {
    throw new Error("Network error — backend took too long or is sleeping. Try again in 30s; Render free tier wakes on first request.");
  }
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { /* not JSON */ } }
  if (!ok) {
    let msg = "";
    if (data) msg = data.detail || data.error || data.message || "";
    if (!msg && text && text.length < 500) msg = text;
    if (!msg) msg = `HTTP ${status}`;
    if (status === 405) {
      msg = "Your browser is running an outdated version. Press Cmd/Ctrl+Shift+R to hard-refresh.";
    }
    // Self-heal: an old/expired guest token in localStorage causes 401 on every
    // request. Purge it so the next page load re-prompts for a fresh code.
    if (status === 401 && /guest|expired|revoked/i.test(msg)) {
      localStorage.removeItem(GUEST_TOKEN_KEY);
    }
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    err.status = status;
    throw err;
  }
  return data || {};
}

/* ──────────────────────────────────────────────────────────────────────
   Modals
   ────────────────────────────────────────────────────────────────────── */

function PasswordModal({ label, onClose, onUnlock }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const submit = async () => {
    try {
      const r = await api("/unlock", { method: "POST", body: { password: pw } });
      setToken(r.token);
      onUnlock();
    } catch (e) {
      const msg = (e && e.message) || "";
      setErr(/wrong password/i.test(msg) ? msg : "Wrong password");
      inputRef.current?.select();
    }
  };
  return (
    <div className="modal-bg" onClick={(e)=>{ if(e.target.classList.contains("modal-bg")) onClose(); }}>
      <div className="modal" role="dialog">
        <h2>🔒 Admin password</h2>
        <p>{label || "This action requires the admin password."}</p>
        <input ref={inputRef} type="password" value={pw}
          onChange={(e)=>setPw(e.target.value)}
          onKeyDown={(e)=>{ if(e.key==="Enter") submit(); if(e.key==="Escape") onClose(); }}
          placeholder="Password" autoComplete="off" data-testid="password-input"/>
        <div className="err">{err}</div>
        <div className="actions">
          <button className="btn-cancel" type="button" onClick={onClose}>Cancel</button>
          <button className="qbtn" type="button" onClick={submit} data-testid="password-submit">Unlock</button>
        </div>
      </div>
    </div>
  );
}

function LearningModal({ onClose, onUnlock }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const submit = async () => {
    try {
      const r = await api("/learning-unlock", { method: "POST", body: { password: pw } });
      setLearnToken(r.token);
      onUnlock();
    } catch (e) {
      setErr(e.message || "Wrong password");
      inputRef.current?.select();
    }
  };
  return (
    <div className="modal-bg" onClick={(e)=>{ if(e.target.classList.contains("modal-bg")) onClose(); }}>
      <div className="modal" role="dialog">
        <h2>🧪 Learning mode</h2>
        <p>Type the learning password to open the Learning tab. Behind it, an LLM judge will read past answers and save the helpful ones as exemplars that future replies imitate.</p>
        <input ref={inputRef} type="password" value={pw}
          onChange={(e)=>setPw(e.target.value)}
          onKeyDown={(e)=>{ if(e.key==="Enter") submit(); if(e.key==="Escape") onClose(); }}
          placeholder="Learning password" autoComplete="off" data-testid="learning-password-input"/>
        <div className="err">{err}</div>
        <div className="actions">
          <button className="btn-cancel" type="button" onClick={onClose}>Cancel</button>
          <button className="qbtn" type="button" onClick={submit} data-testid="learning-password-submit">Unlock</button>
        </div>
      </div>
    </div>
  );
}

function UsernameModal({ initial, onSet, sessionId }) {
  const [name, setName] = useState(initial || "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const submit = async () => {
    const n = name.trim().slice(0, 40);
    if (n.length < 2) { setErr("Pick at least 2 characters."); return; }
    if (!/^[\w \-_.]+$/.test(n)) { setErr("Letters, numbers, spaces, _ - . only."); return; }
    setBusy(true); setErr("");
    try {
      const r = await api("/username/claim", { method: "POST", body: { name: n, session_id: sessionId } });
      localStorage.setItem(USERNAME_KEY, r.name);
      onSet(r.name);
    } catch (e) {
      setErr(e.message || "Failed to claim name");
    }
    setBusy(false);
  };
  return (
    <div className="modal-bg">
      <div className="modal" role="dialog">
        <h2>👋 What should I call you?</h2>
        <p>Pick a name so the admin knows who's been chatting. Names are unique — if someone already took yours, you'll need another.</p>
        <input ref={inputRef} value={name}
          onChange={(e)=>setName(e.target.value)}
          onKeyDown={(e)=>{ if(e.key==="Enter") submit(); }}
          placeholder="e.g. Alex, midget_fan_42, …" data-testid="username-input"/>
        <div className="err">{err}</div>
        <div className="actions">
          <button className="qbtn" type="button" onClick={submit} disabled={busy} data-testid="username-submit">
            {busy ? "Checking…" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ShareDialog({ shareId, onClose }) {
  const url = `${window.location.origin}${window.location.pathname}?share=${shareId}`;
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    navigator.clipboard.writeText(url).catch(()=>{});
    setCopied(true); setTimeout(()=>setCopied(false), 2000);
  };
  return (
    <div className="modal-bg" onClick={(e)=>{ if(e.target.classList.contains("modal-bg")) onClose(); }}>
      <div className="modal" role="dialog">
        <h2>🔗 Share this answer</h2>
        <p>Anyone with this link can read this Q+A. They can't see other chats or admin stuff.</p>
        <input readOnly value={url} onFocus={(e)=>e.target.select()} data-testid="share-url"/>
        <div className="actions">
          <button className="btn-cancel" type="button" onClick={onClose}>Close</button>
          <button className="qbtn" type="button" onClick={onCopy} data-testid="share-copy">
            {copied ? "✓ Copied" : "Copy link"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
   Bubbles + code
   ────────────────────────────────────────────────────────────────────── */

function ResultCard({ r }) {
  return (
    <div className="result-card">
      <div className="r-topic">{r.topic || "(untitled)"}</div>
      <div className="r-summary">{r.summary || ""}</div>
      {r.source_url && <a className="r-source" href={r.source_url} target="_blank" rel="noreferrer">🔗 Source</a>}
      {Array.isArray(r.tags) && r.tags.length > 0 && (
        <div className="r-tags">{r.tags.map((t,i)=><span className="r-tag" key={i}>{t}</span>)}</div>
      )}
    </div>
  );
}

function CodeBlock({ code, lang }) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    navigator.clipboard.writeText(code || "").catch(()=>{});
    setCopied(true); setTimeout(()=>setCopied(false), 2000);
  };
  const onDownload = () => {
    const ext = EXT_MAP[lang] || "txt";
    const mime = lang === "html" ? "text/html" : lang === "css" ? "text/css" : lang === "json" ? "application/json" : "text/plain";
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadText(`midget-${lang}-${ts}.${ext}`, code || "", mime);
  };
  return (
    <div className="code-wrap">
      <div className="code-lang">{lang}</div>
      <pre className="code-block">{code}</pre>
      <div className="code-actions">
        <button className="copy-btn" onClick={onDownload} title="Download file">⬇ Download</button>
        <button className={"copy-btn" + (copied ? " copied" : "")} onClick={onCopy}>
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function Bubble({ msg, onShare, onTeach }) {
  if (msg.role === "user") {
    return (
      <div className="msg-row user">
        <div className="bubble user">
          {msg.image && <img src={msg.image} alt="attachment" className="bubble-img"/>}
          {msg.content}
        </div>
        <div className="bubble-avatar user">{(msg.username || "U")[0].toUpperCase()}</div>
      </div>
    );
  }
  const shareable = !!msg.lastUserQuestion && (msg.content || msg.code);
  const teachable = shareable && !msg.teachStatus;
  return (
    <div className="msg-row bot">
      <div className="bubble-avatar bot">🧠</div>
      <div className="bubble bot">
        {msg.content}
        {msg.results && msg.results.length > 0 && msg.results.map((r,i)=><ResultCard r={r} key={i}/>)}
        {msg.code && <CodeBlock code={msg.code} lang={msg.lang}/>}
        {msg.ctx > 0 && (
          <>
            <br/>
            <span className="ctx-badge">📚 Used {msg.ctx} knowledge entr{msg.ctx>1?"ies":"y"}</span>
          </>
        )}
        {msg.exemplarsUsed > 0 && (
          <>
            {" "}
            <span className="ctx-badge" style={{ background: "#94e2d522", color: "#94e2d5", borderColor: "#94e2d544" }}>
              🧪 Imitating {msg.exemplarsUsed} exemplar{msg.exemplarsUsed>1?"s":""}
            </span>
          </>
        )}
        <div className="bubble-actions">
          {shareable && (
            <button className="share-link-btn" type="button"
              onClick={()=>onShare(msg)} data-testid="bubble-share-btn">
              🔗 Share
            </button>
          )}
          {teachable && (
            <button className="share-link-btn teach" type="button"
              onClick={()=>onTeach(msg)} data-testid="bubble-teach-btn"
              title="Tell Midget this was a good answer. An LLM judge will verify truth + citations + safety, then save it as a learning exemplar.">
              👍 Teach
            </button>
          )}
          {msg.teachStatus && (
            <span className="teach-status" data-testid="bubble-teach-status"
              style={{ color: msg.teachStatus.approved ? "#a6e3a1" : "#f9e2af" }}>
              {msg.teachStatus.approved
                ? `✅ Saved as exemplar (score ${msg.teachStatus.score}/10)`
                : `📝 Saved pending review (score ${msg.teachStatus.score}/10) — ${msg.teachStatus.reason || ""}`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Typing() {
  return (
    <div className="msg-row bot">
      <div className="bubble-avatar bot">🧠</div>
      <div className="bubble bot"><div className="typing"><span></span><span></span><span></span></div></div>
    </div>
  );
}

function HistoryPanel({ onClose, sessionId }) {
  const [tab, setTab] = useState("local"); // 'local' | 'cloud'
  const [local] = useState(() => loadJSON(ARCHIVE_KEY, []));
  const [cloud, setCloud] = useState(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (tab === "cloud" && cloud === null) {
      setLoading(true);
      api(`/chat/history/${sessionId}`)
        .then(r => setCloud(r.messages || []))
        .catch(() => setCloud([]))
        .finally(() => setLoading(false));
    }
  }, [tab, cloud, sessionId]);

  const items = useMemo(() => {
    const src = tab === "local"
      ? local
      : (cloud || []).flatMap(m => ([
          { role: "user", content: m.user_message, at: m.created_at },
          { role: "bot",  content: m.bot_reply,    at: m.created_at },
        ]));
    if (!q.trim()) return src;
    const needle = q.toLowerCase();
    return src.filter(m => (m.content || "").toLowerCase().includes(needle));
  }, [q, tab, local, cloud]);

  const grouped = useMemo(() => {
    const byDay = new Map();
    items.forEach(m => {
      const d = (m.at || "").slice(0, 10) || "unknown";
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(m);
    });
    return Array.from(byDay.entries()).reverse();
  }, [items]);

  const onClearLocal = () => {
    if (window.confirm("Clear ALL local chat history on this device?")) {
      localStorage.removeItem(ARCHIVE_KEY);
      window.location.reload();
    }
  };
  const onExport = () => {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadText(`midget-chat-${tab}-${ts}.json`, JSON.stringify(items, null, 2), "application/json");
  };
  const onExportMarkdown = () => {
    if (!items.length) return;
    const lines = [`# Midget jr. chat export`, ``, `_Exported ${new Date().toLocaleString()} · ${tab === "local" ? "this device" : "all sessions"}_`, ``];
    for (const m of items) {
      const t = m.at ? new Date(m.at).toLocaleString() : "";
      if (m.role === "user") {
        lines.push(`### 🧑 ${m.username || "you"} · ${t}`);
        lines.push("");
        lines.push("> " + (m.content || "").replace(/\n/g, "\n> "));
        lines.push("");
      } else {
        lines.push(`### 🧠 Midget jr. · ${m.mode || "chat"} · ${t}`);
        lines.push("");
        lines.push(m.content || "");
        lines.push("");
      }
    }
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadText(`midget-chat-${tab}-${ts}.md`, lines.join("\n"), "text/markdown");
  };

  return (
    <div className="modal-bg" onClick={(e)=>{ if(e.target.classList.contains("modal-bg")) onClose(); }}>
      <div className="modal history-modal" role="dialog">
        <div className="history-head">
          <h2>📜 Chat history</h2>
          <span className="history-count">{items.length} item{items.length===1?"":"s"}</span>
        </div>
        <div className="history-tabs">
          <button className={"htab" + (tab==="local"?" active":"")} onClick={()=>setTab("local")}>This device</button>
          <button className={"htab" + (tab==="cloud"?" active":"")} onClick={()=>setTab("cloud")}>All my sessions</button>
        </div>
        <input className="qinput" placeholder="Search past messages..."
          value={q} onChange={(e)=>setQ(e.target.value)}
          style={{ width: "100%", marginBottom: 10 }}/>
        <div className="history-list">
          {loading && <div className="empty-state">Loading…</div>}
          {!loading && grouped.length === 0 && <div className="empty-state">Nothing here yet.</div>}
          {!loading && grouped.map(([day, msgs]) => (
            <div key={day} className="history-day">
              <div className="history-day-label">{day}</div>
              {msgs.map((m, i) => (
                <div key={i} className={"history-msg " + m.role}>
                  <span className="history-msg-who">{m.role === "user" ? "you" : "🧠 midget"}</span>
                  <span className="history-msg-text">{m.content}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="actions">
          <button className="btn-cancel" type="button" onClick={onExport}>⬇ Export JSON</button>
          <button className="btn-cancel" type="button" onClick={onExportMarkdown} data-testid="export-md-btn">📄 Export .md</button>
          {tab === "local" && <button className="btn-cancel" type="button" onClick={onClearLocal} style={{ color: "#f38ba8" }}>Clear device</button>}
          <button className="qbtn" type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
   Public Share Viewer (shown when ?share=ID is in URL)
   ────────────────────────────────────────────────────────────────────── */

function ShareViewer({ shareId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [needsGate, setNeedsGate] = useState(false);
  const [gateCode, setGateCode] = useState("");

  const load = () => api(`/share/${shareId}`).then(setData).catch(e => {
    if (e.status === 401) { setNeedsGate(true); setErr(""); }
    else setErr(e.message);
  });
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [shareId]);

  const submitCode = async () => {
    try {
      const r = await api("/guest-auth", { method: "POST", body: { code: gateCode.trim() } });
      localStorage.setItem(GUEST_TOKEN_KEY, r.token);
      setNeedsGate(false);
      load();
    } catch (e) { setErr(e.message || "Invalid code"); }
  };

  const back = () => {
    const u = new URL(window.location);
    u.searchParams.delete("share");
    window.location.href = u.pathname;
  };

  if (needsGate) return (
    <div id="app" className="share-viewer">
      <div className="share-card empty">
        <h2>🎟 Access required</h2>
        <p>This Midget jr. instance is in private mode. Enter your invite code to view the shared answer.</p>
        <input value={gateCode} onChange={(e)=>setGateCode(e.target.value)}
          onKeyDown={(e)=>{ if(e.key==="Enter") submitCode(); }}
          placeholder="Invite code" data-testid="share-gate-input" autoFocus
          style={{ marginTop: 12 }}/>
        <div className="err" style={{ marginTop: 8 }}>{err}</div>
        <button className="qbtn" onClick={submitCode} data-testid="share-gate-submit" style={{ marginTop: 12 }}>
          Unlock
        </button>
      </div>
    </div>
  );
  if (err) return (
    <div id="app" className="share-viewer">
      <div className="share-card empty"><h2>❌ Share not found</h2><p>{err}</p><button className="qbtn" onClick={back}>Open Midget jr.</button></div>
    </div>
  );
  if (!data) return <div id="app" className="share-viewer"><div className="share-card empty"><div className="typing"><span></span><span></span><span></span></div></div></div>;
  return (
    <div id="app" className="share-viewer">
      <div className="share-header">
        <div className="avatar">🧠</div>
        <div>
          <h1>Midget jr.</h1>
          <p>Shared answer · {data.username ? `asked by ${data.username}` : "guest"}</p>
        </div>
        <button className="qbtn" onClick={back} style={{ marginLeft: "auto" }}>Open Midget jr.</button>
      </div>
      <div className="share-card">
        <div className="share-q">
          <span className="share-tag">Question</span>
          <p>{data.question}</p>
        </div>
        <div className="share-a">
          <span className="share-tag">Midget's answer</span>
          <p style={{ whiteSpace: "pre-wrap" }}>{data.answer}</p>
          {data.context_used > 0 && <span className="ctx-badge">📚 Used {data.context_used} knowledge entr{data.context_used>1?"ies":"y"}</span>}
        </div>
        <div className="share-meta">Shared {new Date(data.created_at).toLocaleString()}</div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
   Main App
   ────────────────────────────────────────────────────────────────────── */

export default function App() {
  // Public share viewer mode — totally separate UI, no shared hooks.
  const shareIdFromUrl = useMemo(() => {
    const u = new URL(window.location.href);
    return u.searchParams.get("share");
  }, []);
  if (shareIdFromUrl) return <ShareViewer shareId={shareIdFromUrl}/>;
  return <MainApp/>;
}

function GuestGate({ initialCode, onAuthed }) {
  const [code, setCode] = useState(initialCode || "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErr("");
    try {
      const r = await api("/guest-auth", { method: "POST", body: { code: code.trim() } });
      localStorage.setItem(GUEST_TOKEN_KEY, r.token);
      onAuthed();
    } catch (e) { setErr(e.message || "Invalid code"); }
    setBusy(false);
  };
  useEffect(() => { if (initialCode) submit(); /* eslint-disable-next-line */ }, []);
  return (
    <div className="modal-bg">
      <div className="modal" role="dialog">
        <h2>🎟 Access required</h2>
        <p>Midget jr. is in private mode. Enter your invite code to chat.</p>
        <input value={code} onChange={(e)=>setCode(e.target.value)}
          onKeyDown={(e)=>{ if(e.key==="Enter") submit(); }}
          placeholder="Invite code" data-testid="guest-code-input" autoFocus/>
        <div className="err">{err}</div>
        <div className="actions">
          <button className="qbtn" type="button" onClick={submit} disabled={busy} data-testid="guest-code-submit">
            {busy ? "Checking…" : "Unlock"}
          </button>
        </div>
      </div>
    </div>
  );
}

function InviteDialog({ onClose }) {
  const url = window.location.origin + window.location.pathname;
  const [copied, setCopied] = useState(false);
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&bgcolor=181825&color=cdd6f4&qzone=2&data=${encodeURIComponent(url)}`;
  const onCopy = () => {
    navigator.clipboard.writeText(url).catch(()=>{});
    setCopied(true); setTimeout(()=>setCopied(false), 2000);
  };
  const onNative = async () => {
    if (navigator.share) {
      try { await navigator.share({ title: "Midget jr.", text: "Chat with my AI bot:", url }); } catch {}
    } else { onCopy(); }
  };
  return (
    <div className="modal-bg" onClick={(e)=>{ if(e.target.classList.contains("modal-bg")) onClose(); }}>
      <div className="modal" role="dialog" style={{ width: "min(420px, 92vw)" }}>
        <h2>🔗 Invite friends</h2>
        <p>Anyone with this link can chat (and help me grow). If you're in private mode, hand out an invite code from the Access tab.</p>
        <input readOnly value={url} onFocus={(e)=>e.target.select()} data-testid="invite-url"/>
        <div style={{ textAlign: "center", margin: "14px 0" }}>
          <img src={qrSrc} alt="QR code for invite link" width="180" height="180" style={{ borderRadius: 12 }}/>
        </div>
        <div className="actions">
          <button className="btn-cancel" type="button" onClick={onClose}>Close</button>
          <button className="btn-cancel" type="button" onClick={onNative}>Native share</button>
          <button className="qbtn" type="button" onClick={onCopy} data-testid="invite-copy">{copied ? "✓ Copied" : "Copy link"}</button>
        </div>
      </div>
    </div>
  );
}

function BugDialog({ onClose, username }) {
  const [desc, setDesc] = useState("");
  const [steps, setSteps] = useState("");
  const [screenshot, setScreenshot] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const fileRef = useRef(null);
  const onPick = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!/^image\//.test(f.type)) { setErr("Pick an image file"); return; }
    if (f.size > 500_000) { setErr("Screenshot too big (max ~500 KB) — try a smaller one"); return; }
    const fr = new FileReader();
    fr.onload = () => setScreenshot(String(fr.result || ""));
    fr.readAsDataURL(f);
  };
  const submit = async () => {
    setErr(""); setBusy(true);
    try {
      if (desc.trim().length < 5) throw new Error("Tell me what went wrong (5+ chars).");
      if (steps.trim().length < 5) throw new Error("Tell me the steps to reach it (5+ chars).");
      await api("/bug-reports", { method: "POST", body: { description: desc, steps, screenshot, username } });
      setDone(true);
    } catch (e) { setErr(e.message || "Failed"); }
    setBusy(false);
  };
  return (
    <div className="modal-bg" onClick={(e)=>{ if(e.target.classList.contains("modal-bg") && !busy) onClose(); }}>
      <div className="modal" role="dialog" style={{ width: "min(480px, 94vw)" }}>
        {done ? (
          <>
            <h2>🐛 Thanks!</h2>
            <p>Bug reported. The admin will see it in the 🐛 Bugs tab.</p>
            <div className="actions"><button className="qbtn" onClick={onClose}>Close</button></div>
          </>
        ) : (
          <>
            <h2>🐛 Report a bug</h2>
            <p>Tell me what broke and how to make it happen again.</p>
            <textarea className="qinput" rows={3} placeholder="What went wrong?"
              value={desc} onChange={(e)=>setDesc(e.target.value)}
              style={{ width: "100%", marginBottom: 8, resize: "vertical", minHeight: 60 }}
              data-testid="bug-desc"/>
            <textarea className="qinput" rows={3} placeholder="Steps to reach the bug (1, 2, 3...)"
              value={steps} onChange={(e)=>setSteps(e.target.value)}
              style={{ width: "100%", marginBottom: 8, resize: "vertical", minHeight: 60 }}
              data-testid="bug-steps"/>
            <button type="button" className="btn-cancel" onClick={()=>fileRef.current?.click()}
              style={{ width: "100%" }} data-testid="bug-screenshot-btn">
              {screenshot ? "✓ Screenshot attached (click to replace)" : "📷 Attach screenshot (optional)"}
            </button>
            <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onPick}/>
            {screenshot && (
              <img src={screenshot} alt="preview" style={{ width: "100%", marginTop: 8, borderRadius: 8, maxHeight: 180, objectFit: "contain", background: "#181825" }}/>
            )}
            <div className="err">{err}</div>
            <div className="actions">
              <button className="btn-cancel" type="button" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="qbtn" type="button" onClick={submit} disabled={busy} data-testid="bug-submit">
                {busy ? "Sending…" : "Send report"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MainApp() {
  const [mode, setMode] = useState("chat");
  const [lang, setLang] = useState("python");
  const [text, setText] = useState("");
  // Per-mode message streams — each tab keeps its own conversation
  const [messagesByMode, setMessagesByMode] = useState({
    chat: [], query: [], research: [], code: [],
  });
  const messages = useMemo(() => messagesByMode[mode] || [], [messagesByMode, mode]);
  const [welcomeDismissed, setWelcomeDismissed] = useState(
    () => localStorage.getItem(WELCOME_DISMISS_KEY) === "1"
  );
  const [history, setHistory] = useState(() => loadJSON(HISTORY_KEY, []));
  const [typing, setTyping] = useState(false);
  const [unlocked, setUnlocked] = useState(!!getToken());
  const [pwPrompt, setPwPrompt] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [shareDlgId, setShareDlgId] = useState(null);
  const [installEvt, setInstallEvt] = useState(null);

  // identity
  const [username, setUsername] = useState(() => localStorage.getItem(USERNAME_KEY) || "");
  const [showUsernameModal, setShowUsernameModal] = useState(!localStorage.getItem(USERNAME_KEY));
  const sessionId = useMemo(() => getOrCreateSessionId(), []);

  // queue + import + manage state
  const [queue, setQueue] = useState([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [qTopic, setQTopic] = useState("");
  const [qCat, setQCat] = useState("General");
  const [iCategory, setICategory] = useState("Imported");
  const [iTags, setITags] = useState("");
  const [importRows, setImportRows] = useState([]);
  const [dragOver, setDragOver] = useState(false);

  // KB management
  const [kbList, setKbList] = useState([]);
  const [kbLoading, setKbLoading] = useState(false);
  const [kbSearch, setKbSearch] = useState("");

  // Direct mode state (admin)
  const [directMode, setDirectMode] = useState(false);

  // Behavior + owner toggles inside Import tab
  const [iBehavior, setIBehavior] = useState(false);
  const [iOwner, setIOwner] = useState("");

  // Access / invite / bug-report state
  const [accessMode, setAccessMode] = useState(null); // null until known; true=private
  const [needsGate, setNeedsGate] = useState(false);
  const [initialGateCode, setInitialGateCode] = useState(null);
  const [showInvite, setShowInvite] = useState(false);
  const [showBug, setShowBug] = useState(false);
  const [codes, setCodes] = useState([]);
  const [codeLabel, setCodeLabel] = useState("");
  const [codeDays, setCodeDays] = useState(30);
  const [codeMax, setCodeMax] = useState("");
  const [bugList, setBugList] = useState([]);

  // Learning mode (LLM-as-judge → exemplars)
  const [learnUnlocked, setLearnUnlocked] = useState(!!getLearnToken());
  const [showLearnGate, setShowLearnGate] = useState(false);
  const [exemplarsList, setExemplarsList] = useState([]);
  const [learnApprovedOnly, setLearnApprovedOnly] = useState(false);
  const [learnRunning, setLearnRunning] = useState(false);
  const [learnLastRun, setLearnLastRun] = useState(null);
  const [learnLimit, setLearnLimit] = useState(20);
  const [learnMinScore, setLearnMinScore] = useState(7);

  // Citation style — persisted across sessions
  const [citationStyle, setCitationStyle] = useState(
    () => localStorage.getItem(CITATION_KEY) || "none"
  );
  useEffect(() => { localStorage.setItem(CITATION_KEY, citationStyle); }, [citationStyle]);

  // Ghost-typer state (Write tab)
  const [doc, setDoc] = useState(() => localStorage.getItem("mj_doc") || "");
  const [writeInstruction, setWriteInstruction] = useState("");
  const [writeTone, setWriteTone] = useState("match the surrounding voice");
  const [writeMaxChars, setWriteMaxChars] = useState(800);
  const [writeBusy, setWriteBusy] = useState(false);
  const [writeStatus, setWriteStatus] = useState("");
  const [writeSpeed, setWriteSpeed] = useState(18); // ms per character
  const writeAbortRef = useRef({ stop: false });
  const docRef = useRef(null);
  useEffect(() => { localStorage.setItem("mj_doc", doc); }, [doc]);

  // Image attach (vision)
  const [attachedImage, setAttachedImage] = useState(null); // data URL
  const [attachedImageMeta, setAttachedImageMeta] = useState(null); // {name, size}

  // Voice input (Web Speech API)
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);
  const voiceTargetRef = useRef("chat");  // "chat" or "write"

  // Access tab additions
  const [codeCustom, setCodeCustom] = useState("");
  const [codeComplexity, setCodeComplexity] = useState("weak");

  // Self-edit (admin)
  const [selfFiles, setSelfFiles] = useState([]);
  const [selfPath, setSelfPath] = useState("");
  const [selfInstruction, setSelfInstruction] = useState("");
  const [selfBusy, setSelfBusy] = useState(false);
  const [selfStatus, setSelfStatus] = useState("");
  const [selfDiff, setSelfDiff] = useState(null);    // {path, diff, new_content, old_size, new_size}
  const [selfHistory, setSelfHistory] = useState([]);
  const [ghStatus, setGhStatus] = useState(null);
  const [ghPat, setGhPat] = useState("");
  const [ghRepo, setGhRepo] = useState("");
  const [ghBranch, setGhBranch] = useState("main");
  const [ghCommit, setGhCommit] = useState("Midget jr. self-edit");
  const [ghLog, setGhLog] = useState("");

  // AI Dev (conversational agent) tab
  const [devHistory, setDevHistory] = useState([]);  // [{role, content, transcript?, pending?}]
  const [devInput, setDevInput] = useState("");
  const [devBusy, setDevBusy] = useState(false);
  const [devAutoApply, setDevAutoApply] = useState(false);
  const [devPending, setDevPending] = useState(null);
  const devScrollRef = useRef(null);

  // Humanizer + Google Doc helpers (Write tab)
  const [humanize, setHumanize] = useState(false);
  const [googleDocUrl, setGoogleDocUrl] = useState(() => localStorage.getItem("mj_gdoc_url") || "");
  useEffect(() => { localStorage.setItem("mj_gdoc_url", googleDocUrl); }, [googleDocUrl]);

  // Visitors
  const [visitors, setVisitors] = useState([]);
  const [chatLog, setChatLog] = useState([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [filterUser, setFilterUser] = useState("");

  const fileInputRef = useRef(null);
  const messagesEnd = useRef(null);
  const taRef = useRef(null);

  // Auto-scroll the active conversation when it changes
  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, typing]);

  // tab-driven loaders
  useEffect(() => {
    if (mode === "queue") loadQueue();
    if (mode === "manage" && unlocked) loadKB();
    if (mode === "visitors" && unlocked) loadVisitors();
    if (mode === "access" && unlocked) loadAccess();
    if (mode === "bugs" && unlocked) loadBugs();
    if (mode === "self" && unlocked) { wakeBackend(); loadSelfFiles(); loadSelfHistory(); loadGhStatus(); }
    if (mode === "dev" && unlocked) { wakeBackend(); }
    if (mode === "learning" && (learnUnlocked || unlocked)) loadExemplars();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, unlocked, learnUnlocked]);

  // PWA install prompt capture
  useEffect(() => {
    const h = (e) => { e.preventDefault(); setInstallEvt(e); };
    window.addEventListener("beforeinstallprompt", h);
    return () => window.removeEventListener("beforeinstallprompt", h);
  }, []);

  // Sync direct mode state on load + after unlock changes
  useEffect(() => {
    api("/direct-mode").then(r => setDirectMode(!!r.enabled)).catch(() => {});
  }, []);

  // Check access mode + decide if guest gate is needed
  useEffect(() => {
    // Pre-fill from ?code= URL param so invite links auto-fill the gate
    const u = new URL(window.location.href);
    const codeParam = u.searchParams.get("code");
    if (codeParam) setInitialGateCode(codeParam);

    api("/access-mode").then(async r => {
      setAccessMode(!!r.require_guest_pass);
      if (r.require_guest_pass) {
        const gtok = localStorage.getItem(GUEST_TOKEN_KEY);
        const admin = getToken();
        // Validate any stashed guest token by hitting a cheap gated endpoint.
        // If it's expired/revoked, nuke it and show the gate.
        let tokenValid = !!admin;
        if (!tokenValid && gtok) {
          try {
            await api("/direct-mode");   // requires guest pass when private mode on
            tokenValid = true;
          } catch (e) {
            if (e.status === 401) {
              localStorage.removeItem(GUEST_TOKEN_KEY);
              tokenValid = false;
            } else {
              tokenValid = true;  // network glitch — don't lock the user out
            }
          }
        }
        if (!tokenValid) setNeedsGate(true);
      } else {
        // Private mode OFF — any leftover guest token from a previous session
        // is useless and would only cause 401s if we keep sending it. Purge.
        localStorage.removeItem(GUEST_TOKEN_KEY);
      }
    }).catch(() => setAccessMode(false));
  }, []);

  const onGuestAuthed = () => {
    setNeedsGate(false);
    // Strip ?code= from URL after successful gate
    const u = new URL(window.location.href);
    if (u.searchParams.has("code")) {
      u.searchParams.delete("code");
      window.history.replaceState({}, "", u.toString());
    }
  };

  const toggleDirectMode = async () => {
    if (!(await requirePw("Direct Mode (drops disclaimers/refusals) requires the admin password."))) return;
    try {
      const r = await api("/admin/direct-mode", { method: "POST", auth: true, body: { enabled: !directMode } });
      setDirectMode(!!r.enabled);
    } catch (e) { alert("Failed: " + e.message); }
  };

  const requirePw = useCallback((label) => new Promise((resolve) => {
    if (getToken()) return resolve(true);
    setPwPrompt({
      label,
      onSuccess: () => { setUnlocked(true); setPwPrompt(null); resolve(true); },
      onClose: () => { setPwPrompt(null); resolve(false); },
    });
  }), []);

  const accent = MODE_COLORS[mode];

  // Push helpers that write to the *current* mode's bucket
  const pushBot = (b) => setMessagesByMode(s => ({ ...s, [mode]: [...(s[mode]||[]), { role: "bot", ...b }] }));
  const pushUser = (t, extra = {}) => setMessagesByMode(s => ({ ...s, [mode]: [...(s[mode]||[]), { role: "user", content: t, username, ...extra }] }));
  const pushBotIn = (m, b) => setMessagesByMode(s => ({ ...s, [m]: [...(s[m]||[]), { role: "bot", ...b }] }));

  const archive = (entries) => {
    const a = loadJSON(ARCHIVE_KEY, []);
    a.push(...entries);
    if (a.length > 5000) a.splice(0, a.length - 5000);
    saveJSON(ARCHIVE_KEY, a);
  };

  const send = async () => {
    const t = text.trim();
    if (!t || typing) return;
    if (!username) { setShowUsernameModal(true); return; }
    setText(""); if (taRef.current) taRef.current.style.height = "auto";
    pushUser(t, attachedImage && mode === "chat" ? { image: attachedImage } : {});
    setTyping(true);
    const now = new Date().toISOString();
    const archiveBuf = [{ role: "user", content: t, mode, username, at: now }];
    try {
      if (mode === "chat") {
        const r = await api("/chat", { method: "POST", body: {
          message: t, history, session_id: sessionId, username,
          citation_style: citationStyle,
          image: attachedImage || undefined,
        }});
        pushBotIn("chat", { content: r.reply, ctx: r.context_used, exemplarsUsed: r.exemplars_used || 0,
          lastUserQuestion: t, mode: "chat", citationStyle: r.citation_style, vision: !!r.vision });
        archiveBuf.push({ role: "bot", content: r.reply, mode, at: new Date().toISOString() });
        if (attachedImage) clearImage();   // one-shot per question
        const h2 = [...history, { role: "user", content: t }, { role: "assistant", content: r.reply }];
        while (h2.length > 12) h2.splice(0, 2);
        setHistory(h2); saveJSON(HISTORY_KEY, h2);
      } else if (mode === "query") {
        const r = await api("/query", { method: "POST", body: { query: t } });
        if (r.results?.length) {
          pushBot({ content: `Found ${r.result_count} result(s):`, results: r.results, lastUserQuestion: t, mode: "query" });
          archiveBuf.push({ role: "bot", content: `Found ${r.result_count} result(s): ${r.results.map(x=>x.topic).join(", ")}`, mode, at: new Date().toISOString() });
        } else {
          const m = `🤷 Nothing in the knowledge base about "${t}" yet.\n\nTip: switch to 🌐 Research, or 📂 Import a file.`;
          pushBot({ content: m });
          archiveBuf.push({ role: "bot", content: m, mode, at: new Date().toISOString() });
        }
      } else if (mode === "research") {
        const r = await api("/research", { method: "POST", body: { topic: t, category: "General" } });
        const m = r.sources_found > 0
          ? `✅ Researched and saved!\n\nTopic: ${r.topic}\nSources: ${r.sources_found}\n\n${r.summary || ""}`
          : `📌 Saved "${t}" — no web sources found, you may want to try a more specific query.`;
        pushBot({ content: m, lastUserQuestion: t, mode: "research" });
        archiveBuf.push({ role: "bot", content: m, mode, at: new Date().toISOString() });
      } else if (mode === "code") {
        const r = await api("/code", { method: "POST", body: { prompt: t, language: lang } });
        pushBot({ content: `Here's your ${lang} code:`, code: r.code, lang, lastUserQuestion: t, mode: "code" });
        archiveBuf.push({ role: "bot", content: `[${lang} code]\n${r.code}`, mode, at: new Date().toISOString() });
      }
    } catch (e) {
      const m = `❌ Error: ${e.message}`;
      pushBot({ content: m });
      archiveBuf.push({ role: "bot", content: m, mode, at: new Date().toISOString() });
    }
    archive(archiveBuf);
    setTyping(false);
  };

  const onShareBubble = async (msg) => {
    try {
      const answer = msg.code ? `Here's your ${msg.lang} code:\n\n${msg.code}` : (msg.content || "");
      const r = await api("/share", { method: "POST", body: {
        question: msg.lastUserQuestion || "",
        answer, mode: msg.mode || "chat",
        context_used: msg.ctx || 0, username,
      }});
      setShareDlgId(r.id);
    } catch (e) { alert("Share failed: " + e.message); }
  };

  const onTeachBubble = async (msg) => {
    // Optimistically mark the bubble as "judging…"
    setMessagesByMode(s => {
      const arr = (s[mode] || []).map(m => m === msg
        ? { ...m, teachStatus: { pending: true, score: 0, approved: false, reason: "Judging…" } }
        : m);
      return { ...s, [mode]: arr };
    });
    try {
      const answer = msg.code ? `Here's your ${msg.lang} code:\n\n${msg.code}` : (msg.content || "");
      const r = await api("/learning/teach", { method: "POST", body: {
        question: msg.lastUserQuestion || "",
        answer,
        username, session_id: sessionId,
        citation_style: msg.citationStyle || citationStyle,
      }});
      setMessagesByMode(s => {
        const arr = (s[mode] || []).map(m => m === msg
          ? { ...m, teachStatus: { score: r.score, approved: r.approved, reason: r.reason } }
          : m);
        return { ...s, [mode]: arr };
      });
    } catch (e) {
      setMessagesByMode(s => {
        const arr = (s[mode] || []).map(m => m === msg
          ? { ...m, teachStatus: { score: 0, approved: false, reason: e.message || "Failed" } }
          : m);
        return { ...s, [mode]: arr };
      });
    }
  };

  const refreshQueue = () => loadQueue();
  async function loadQueue() {
    setQueueLoading(true);
    try {
      const r = await api("/queue");
      const arr = Array.isArray(r) ? r : (r.items || []);
      setQueue(arr.sort((a,b)=> new Date(b.created_at) - new Date(a.created_at)));
    } catch { setQueue([]); }
    setQueueLoading(false);
  }
  const addToQueue = async () => {
    const topic = qTopic.trim();
    if (!topic) return;
    if (!(await requirePw("Adding to the queue requires the admin password."))) return;
    try {
      await api("/queue", { method: "POST", auth: true, body: { topic, category: qCat, priority: 2 } });
      setQTopic("");
      refreshQueue();
    } catch (e) { alert("Failed: " + e.message); }
  };
  const deleteQueueItem = async (id) => {
    if (!(await requirePw("Deleting from the queue requires the admin password."))) return;
    try { await api(`/queue/${id}`, { method: "DELETE", auth: true }); refreshQueue(); }
    catch (e) { alert("Failed: " + e.message); }
  };

  // KB Manage
  async function loadKB() {
    setKbLoading(true);
    try {
      const r = await api("/knowledge");
      setKbList(r.entries || []);
    } catch { setKbList([]); }
    setKbLoading(false);
  }
  const deleteKB = async (id) => {
    if (!(await requirePw("Deleting a knowledge entry requires the admin password."))) return;
    try { await api(`/knowledge/${id}`, { method: "DELETE", auth: true }); loadKB(); }
    catch (e) { alert("Failed: " + e.message); }
  };
  const filteredKB = useMemo(() => {
    if (!kbSearch.trim()) return kbList;
    const n = kbSearch.toLowerCase();
    return kbList.filter(e =>
      (e.topic || "").toLowerCase().includes(n) ||
      (e.summary || "").toLowerCase().includes(n) ||
      (e.tags || []).join(",").toLowerCase().includes(n));
  }, [kbList, kbSearch]);

  // Visitors
  async function loadVisitors() {
    if (!getToken()) {
      const ok = await requirePw("Viewing visitors requires the admin password.");
      if (!ok) return;
    }
    setAdminLoading(true);
    try {
      const [v, c] = await Promise.all([
        api("/admin/visitors", { auth: true }),
        api(`/admin/chat-log?limit=200${filterUser ? `&username=${encodeURIComponent(filterUser)}` : ""}`, { auth: true }),
      ]);
      setVisitors(v.visitors || []);
      setChatLog(c.messages || []);
    } catch (e) { alert("Failed: " + e.message); }
    setAdminLoading(false);
  }

  async function loadAccess() {
    try {
      const r = await api("/admin/access-codes", { auth: true });
      setCodes(r.codes || []);
    } catch (e) { alert("Failed: " + e.message); }
  }
  const createCode = async () => {
    try {
      const body = {
        code: codeCustom.trim() || undefined,
        label: codeLabel.trim(),
        expires_in_days: Number(codeDays) || null,
        max_uses: codeMax ? Number(codeMax) : null,
        complexity: codeComplexity,
      };
      await api("/admin/access-codes", { method: "POST", auth: true, body });
      setCodeLabel(""); setCodeDays(30); setCodeMax(""); setCodeCustom("");
      loadAccess();
    } catch (e) { alert("Failed: " + e.message); }
  };
  const revokeCode = async (code) => {
    if (!window.confirm(`Revoke code ${code}? Anyone using it will be locked out.`)) return;
    try { await api(`/admin/access-codes/${code}`, { method: "DELETE", auth: true }); loadAccess(); }
    catch (e) { alert("Failed: " + e.message); }
  };
  const togglePrivate = async () => {
    try {
      const r = await api("/admin/access-mode", { method: "POST", auth: true, body: { enabled: !accessMode } });
      setAccessMode(!!r.require_guest_pass);
    } catch (e) { alert("Failed: " + e.message); }
  };
  const copyCodeUrl = (code) => {
    const url = `${window.location.origin}${window.location.pathname}?code=${code}`;
    navigator.clipboard.writeText(url).catch(()=>{});
  };

  async function loadBugs() {
    try {
      const r = await api("/admin/bug-reports", { auth: true });
      setBugList(r.reports || []);
    } catch (e) { alert("Failed: " + e.message); }
  }
  const deleteBug = async (id) => {
    if (!window.confirm("Delete this bug report?")) return;
    try { await api(`/admin/bug-reports/${id}`, { method: "DELETE", auth: true }); loadBugs(); }
    catch (e) { alert("Failed: " + e.message); }
  };

  async function loadExemplars(approvedOnly = learnApprovedOnly) {
    try {
      const r = await api(`/admin/exemplars?approved_only=${approvedOnly ? "true" : "false"}&limit=200`, { learn: true });
      setExemplarsList(r.exemplars || []);
    } catch (e) {
      if (/Learning mode locked/i.test(e.message)) { setLearnUnlocked(false); setShowLearnGate(true); }
      else alert("Failed: " + e.message);
    }
  }
  const runLearningPass = async () => {
    setLearnRunning(true);
    try {
      const r = await api("/learning/run", { method: "POST", learn: true,
        body: { limit: Number(learnLimit) || 20, min_score: Number(learnMinScore) || 7 } });
      setLearnLastRun(r);
      await loadExemplars();
    } catch (e) {
      if (/Learning mode locked/i.test(e.message)) { setLearnUnlocked(false); setShowLearnGate(true); }
      else alert("Learning pass failed: " + e.message);
    }
    setLearnRunning(false);
  };
  const deleteExemplar = async (id) => {
    if (!window.confirm("Delete this exemplar? It won't be injected into future replies.")) return;
    try { await api(`/admin/exemplars/${id}`, { method: "DELETE", learn: true }); loadExemplars(); }
    catch (e) { alert("Failed: " + e.message); }
  };
  const toggleExemplar = async (id) => {
    try { await api(`/admin/exemplars/${id}/toggle`, { method: "POST", learn: true }); loadExemplars(); }
    catch (e) { alert("Failed: " + e.message); }
  };
  const openLearningTab = () => {
    if (!getLearnToken() && !getToken()) { setShowLearnGate(true); return; }
    setLearnUnlocked(true); setMode("learning");
  };
  const lockLearning = () => {
    setLearnToken(""); setLearnUnlocked(false);
    if (mode === "learning") setMode("chat");
  };

  // ── Ghost-typer ────────────────────────────────────────────────────
  const stopGhostType = () => { writeAbortRef.current.stop = true; };

  const runGhostType = async () => {
    if (!writeInstruction.trim()) {
      setWriteStatus("Tell me what to write first ✍️");
      return;
    }
    setWriteBusy(true);
    setWriteStatus("Thinking…");
    writeAbortRef.current.stop = false;
    const ta = docRef.current;
    const pos = ta ? ta.selectionStart : doc.length;
    const before = doc.slice(0, pos);
    const after = doc.slice(pos);
    try {
      const r = await api("/write", { method: "POST", body: {
        instruction: writeInstruction,
        doc_before: before,
        doc_after: after,
        tone: writeTone,
        max_chars: Number(writeMaxChars) || 800,
        humanize: humanize,
      }});
      setWriteStatus("Typing…");
      const toType = r.text || "";
      // Human typing rhythm: occasional typo + backspace + correct, longer pauses on
      // sentence starts and commas, micro "think" pauses. Only when humanize is on
      // do we do typos.
      const NEIGHBOR = {
        a:"sq", b:"vn", c:"xv", d:"sf", e:"wr", f:"dg", g:"fh", h:"gj", i:"uo",
        j:"hk", k:"jl", l:"k", m:"n", n:"bm", o:"ip", p:"o", q:"wa", r:"et",
        s:"ad", t:"ry", u:"yi", v:"cb", w:"qe", x:"zc", y:"tu", z:"x",
      };
      const baseBefore = before;
      const baseAfter = after;
      let i = 0;
      while (i < toType.length) {
        if (writeAbortRef.current.stop) break;
        const ch = toType[i];
        // Decide: should we mistype this char first?
        const mistypeChance = humanize ? 0.045 : 0;
        const willMistype = ch.match(/[a-zA-Z]/) && Math.random() < mistypeChance && NEIGHBOR[ch.toLowerCase()];
        if (willMistype) {
          const opts = NEIGHBOR[ch.toLowerCase()];
          const wrong = opts[Math.floor(Math.random()*opts.length)];
          const slice = toType.slice(0, i) + (ch === ch.toUpperCase() ? wrong.toUpperCase() : wrong);
          setDoc(baseBefore + slice + baseAfter);
          requestAnimationFrame(() => {
            if (docRef.current) {
              const cur = baseBefore.length + slice.length;
              docRef.current.setSelectionRange(cur, cur);
            }
          });
          // eslint-disable-next-line no-loop-func
          await new Promise(res => setTimeout(res, writeSpeed * (2 + Math.random()*3)));
          // notice + backspace
          // eslint-disable-next-line no-loop-func
          await new Promise(res => setTimeout(res, writeSpeed * 3));
          const fixed = toType.slice(0, i);
          setDoc(baseBefore + fixed + baseAfter);
          requestAnimationFrame(() => {
            if (docRef.current) {
              const cur = baseBefore.length + fixed.length;
              docRef.current.setSelectionRange(cur, cur);
            }
          });
          // eslint-disable-next-line no-loop-func
          await new Promise(res => setTimeout(res, writeSpeed * 1.5));
        }
        const slice = toType.slice(0, i + 1);
        const newDoc = baseBefore + slice + baseAfter;
        setDoc(newDoc);
        requestAnimationFrame(() => {
          if (docRef.current) {
            const cursor = baseBefore.length + slice.length;
            docRef.current.setSelectionRange(cursor, cursor);
          }
        });
        let delay = writeSpeed;
        if (ch === " ") delay = writeSpeed * 0.6;
        else if (",;:".includes(ch)) delay = writeSpeed * 6;
        else if (".!?".includes(ch)) delay = writeSpeed * 9;
        else if (humanize && Math.random() < 0.03) delay = writeSpeed * 25;   // think pause
        else if (Math.random() < 0.05) delay = writeSpeed * 3;
        // small jitter
        delay = delay * (0.7 + Math.random() * 0.6);
        // eslint-disable-next-line no-loop-func
        await new Promise(res => setTimeout(res, delay));
        i++;
      }
      setWriteStatus(writeAbortRef.current.stop
        ? `Stopped after ${i} chars.`
        : `✓ Inserted ${toType.length} characters.`);
    } catch (e) {
      setWriteStatus("❌ " + (e.message || "Failed"));
    }
    setWriteBusy(false);
  };

  const clearDoc = () => {
    if (!doc) return;
    if (!window.confirm("Clear the whole document? This can't be undone.")) return;
    setDoc("");
  };
  const downloadDoc = () => {
    const blob = new Blob([doc], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `midget-doc-${new Date().toISOString().slice(0,10)}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const copyDocAndOpenGoogle = async () => {
    if (!doc.trim()) { alert("Document is empty."); return; }
    try {
      await navigator.clipboard.writeText(doc);
    } catch {
      // Fallback for older browsers / non-HTTPS contexts
      const ta = document.createElement("textarea");
      ta.value = doc;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (_) {} // eslint-disable-line no-unused-vars
      ta.remove();
    }
    setWriteStatus("📋 Copied to clipboard! Paste into your Google Doc with Cmd/Ctrl+V.");
    if (googleDocUrl) {
      const url = googleDocUrl.trim();
      if (/^https?:\/\/(docs|drive)\.google\.com\//.test(url)) {
        window.open(url, "_blank", "noopener");
      } else {
        alert("That doesn't look like a Google Docs URL.");
      }
    }
  };

  // Rewrite selection (Write tab)
  const [rewriteTone, setRewriteTone] = useState("clearer and more concise");
  const rewriteSelection = async () => {
    const ta = docRef.current;
    if (!ta) return;
    const start = ta.selectionStart, end = ta.selectionEnd;
    if (start === end) { setWriteStatus("✋ Select some text first."); return; }
    const sel = doc.slice(start, end);
    const before = doc.slice(0, start);
    const after = doc.slice(end);
    setWriteBusy(true);
    setWriteStatus("Rewriting…");
    writeAbortRef.current.stop = false;
    try {
      const r = await api("/write/rewrite", { method: "POST", body: {
        selection: sel,
        tone: rewriteTone,
        instruction: writeInstruction || null,
        doc_before: before,
        doc_after: after,
        max_chars: 2000,
      }});
      // Ghost-type the rewrite over the existing selection
      setWriteStatus("Typing rewrite…");
      const newText = r.text || "";
      // First remove the old selection
      setDoc(before + after);
      let i = 0;
      while (i < newText.length) {
        if (writeAbortRef.current.stop) break;
        const slice = newText.slice(0, i + 1);
        setDoc(before + slice + after);
        requestAnimationFrame(() => {
          if (docRef.current) {
            const cursor = before.length + slice.length;
            docRef.current.setSelectionRange(cursor, cursor);
          }
        });
        const ch = newText[i];
        let delay = writeSpeed;
        if (ch === " ") delay = writeSpeed * 0.6;
        else if (",.;:!?".includes(ch)) delay = writeSpeed * 6;
        else if (Math.random() < 0.05) delay = writeSpeed * 3;
        // eslint-disable-next-line no-loop-func
        await new Promise(res => setTimeout(res, delay));
        i++;
      }
      setWriteStatus(writeAbortRef.current.stop
        ? `Stopped after ${i} chars.`
        : `✓ Rewrote ${sel.length} → ${newText.length} characters.`);
    } catch (e) {
      setWriteStatus("❌ " + (e.message || "Failed"));
    }
    setWriteBusy(false);
  };

  // Voice input — Web Speech API
  const startVoice = (target) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert("Your browser doesn't support speech recognition. Try Chrome."); return; }
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch (_) {} // eslint-disable-line no-unused-vars
    }
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    voiceTargetRef.current = target;
    rec.onresult = (evt) => {
      let transcript = "";
      for (let i = 0; i < evt.results.length; i++) transcript += evt.results[i][0].transcript;
      if (voiceTargetRef.current === "chat") {
        setText(t => (t ? t + " " : "") + transcript.replace(/^ +/, ""));
      } else if (voiceTargetRef.current === "write") {
        setWriteInstruction(t => (t ? t + " " : "") + transcript.replace(/^ +/, ""));
      }
    };
    rec.onend = () => { setListening(false); recognitionRef.current = null; };
    rec.onerror = (e) => { setListening(false); console.warn("speech rec err", e); };
    recognitionRef.current = rec;
    setListening(true);
    rec.start();
  };
  const stopVoice = () => {
    try { recognitionRef.current?.stop(); } catch (_) {} // eslint-disable-line no-unused-vars
    setListening(false);
  };

  // Image attach (vision)
  const attachImage = (file) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { alert("Pick an image file."); return; }
    if (file.size > 4 * 1024 * 1024) { alert("Image too big (4 MB max)."); return; }
    const fr = new FileReader();
    fr.onload = () => {
      setAttachedImage(fr.result);
      setAttachedImageMeta({ name: file.name, size: file.size });
    };
    fr.readAsDataURL(file);
  };
  const clearImage = () => { setAttachedImage(null); setAttachedImageMeta(null); };

  // Export chat as Markdown
  const exportChatMarkdown = () => {
    const raw = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || "[]");
    if (!raw.length) { alert("No chat history to export yet."); return; }
    const lines = [`# Midget jr. chat export`, ``, `_Exported ${new Date().toLocaleString()}_`, ``];
    for (const m of raw) {
      const t = m.at ? new Date(m.at).toLocaleString() : "";
      if (m.role === "user") {
        lines.push(`### 🧑 ${m.username || "User"} · ${t}`);
        lines.push("");
        lines.push("> " + (m.content || "").replace(/\n/g, "\n> "));
        lines.push("");
      } else {
        lines.push(`### 🧠 Midget jr. · ${m.mode || "chat"} · ${t}`);
        lines.push("");
        lines.push(m.content || "");
        if (m.code) {
          lines.push("```" + (m.lang || ""));
          lines.push(m.code);
          lines.push("```");
        }
        lines.push("");
      }
    }
    const md = lines.join("\n");
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `midget-chat-${new Date().toISOString().slice(0,10)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ── Self-edit helpers ─────────────────────────────────────────────
  const loadSelfFiles = async () => {
    try {
      const r = await api("/admin/self/files", { auth: true });
      setSelfFiles(r.files || []);
      if (!selfPath && r.files?.length) setSelfPath(r.files[0].path);
    } catch (e) { alert("Failed: " + e.message); }
  };
  const loadSelfHistory = async () => {
    try {
      const r = await api("/admin/self/history", { auth: true });
      setSelfHistory(r.edits || []);
    } catch (e) { console.warn(e); }
  };
  const loadGhStatus = async () => {
    try {
      const r = await api("/admin/github/status", { auth: true });
      setGhStatus(r);
      if (r.repo) setGhRepo(r.repo);
      if (r.branch) setGhBranch(r.branch);
    } catch (e) { console.warn(e); }
  };
  const proposeSelfEdit = async () => {
    if (!selfPath) { setSelfStatus("Pick a file first."); return; }
    if (!selfInstruction.trim()) { setSelfStatus("Describe what to change first."); return; }
    setSelfBusy(true); setSelfStatus("✍️ Drafting…"); setSelfDiff(null);
    try {
      const r = await api("/admin/self/propose", { method: "POST", auth: true,
        body: { path: selfPath, instruction: selfInstruction } });
      setSelfDiff(r);
      setSelfStatus(`Drafted: ${r.old_size} → ${r.new_size} chars. Review the diff and click Apply if it looks right.`);
    } catch (e) {
      setSelfStatus("❌ " + (e.message || "Failed"));
    }
    setSelfBusy(false);
  };
  const applySelfEdit = async () => {
    if (!selfDiff) return;
    if (!window.confirm(
      `Apply this edit to ${selfDiff.path}?\n\n` +
      `(${selfDiff.old_size} → ${selfDiff.new_size} chars. Old version is backed up — you can roll back.)`
    )) return;
    setSelfBusy(true); setSelfStatus("⏳ Applying…");
    try {
      const r = await api("/admin/self/apply", { method: "POST", auth: true,
        body: { path: selfDiff.path, new_content: selfDiff.new_content, summary: selfInstruction } });
      if (r.applied) {
        setSelfStatus(`✅ Applied to ${r.path}. Hot reload should pick it up in a moment.`);
        setSelfDiff(null);
        loadSelfFiles();
        loadSelfHistory();
      } else {
        setSelfStatus("ℹ️ " + (r.reason || "No change."));
      }
    } catch (e) {
      setSelfStatus("❌ " + (e.message || "Failed"));
    }
    setSelfBusy(false);
  };
  const rollbackSelfEdit = async (id) => {
    if (!window.confirm("Roll back this edit?")) return;
    setSelfBusy(true);
    try {
      await api(`/admin/self/rollback/${id}`, { method: "POST", auth: true });
      setSelfStatus("⏪ Rolled back.");
      loadSelfHistory();
    } catch (e) {
      setSelfStatus("❌ " + e.message);
    }
    setSelfBusy(false);
  };
  const setupGithub = async () => {
    if (!ghPat || !ghRepo) { setSelfStatus("Need both a PAT and a repo (owner/repo)."); return; }
    try {
      await api("/admin/github/setup", { method: "POST", auth: true,
        body: { pat: ghPat, repo: ghRepo, branch: ghBranch || "main" } });
      setSelfStatus("✅ GitHub saved.");
      setGhPat("");
      loadGhStatus();
    } catch (e) { setSelfStatus("❌ " + e.message); }
  };
  const pushGithub = async () => {
    if (!window.confirm(`Push current code to GitHub (${ghRepo}@${ghBranch})?`)) return;
    setSelfBusy(true); setSelfStatus("⤴ Pushing…"); setGhLog("");
    try {
      const r = await api("/admin/github/push", { method: "POST", auth: true,
        body: { message: ghCommit } });
      setGhLog(r.log || "");
      setSelfStatus(r.pushed ? "✅ Pushed!" : "❌ " + (r.reason || "Push failed"));
      loadGhStatus();
    } catch (e) { setSelfStatus("❌ " + e.message); }
    setSelfBusy(false);
  };

  // Wake the backend (Render free tier sleeps after 15min). Fire-and-forget.
  const wakeBackend = () => { api("/").catch(() => {}); };

  // ── AI Dev (conversational agent) ─────────────────────────────────
  const sendDev = async () => {
    const msg = devInput.trim();
    if (!msg) return;
    setDevInput("");
    const userMsg = { role: "user", content: msg, at: new Date().toISOString() };
    setDevHistory(h => [...h, userMsg]);
    setDevBusy(true);
    const hintTimer = setTimeout(() => {
      setDevHistory(h => [...h, { role: "assistant", content: "⏳ Still working — agent loops can take 20-60s on Render free tier when first awakening. Hang tight…", at: new Date().toISOString(), ephemeral: true }]);
    }, 8000);
    try {
      const histForApi = devHistory.map(m => ({ role: m.role, content: m.content }));
      const r = await api("/admin/agent/chat", { method: "POST", auth: true, body: {
        message: msg, history: histForApi, auto_apply: devAutoApply,
      }});
      clearTimeout(hintTimer);
      setDevHistory(h => [...h.filter(m => !m.ephemeral), {
        role: "assistant",
        content: r.reply || "(no reply)",
        transcript: r.transcript || [],
        at: new Date().toISOString(),
      }]);
      setDevPending(r.pending_draft || null);
    } catch (e) {
      clearTimeout(hintTimer);
      setDevHistory(h => [...h.filter(m => !m.ephemeral), { role: "assistant", content: "❌ " + e.message, at: new Date().toISOString() }]);
    }
    setDevBusy(false);
    requestAnimationFrame(() => {
      if (devScrollRef.current) devScrollRef.current.scrollTop = devScrollRef.current.scrollHeight;
    });
  };
  const devApply = async () => {
    if (!devPending) return;
    if (!window.confirm(`Apply ${devPending.path} (${devPending.old_size} → ${devPending.new_size} chars)?`)) return;
    try {
      const r = await api("/admin/agent/apply", { method: "POST", auth: true });
      setDevHistory(h => [...h, { role: "assistant",
        content: r.applied ? `✅ Wrote ${r.path}.` : `ℹ️ ${r.reason || "No change."}`,
        at: new Date().toISOString() }]);
      setDevPending(null);
    } catch (e) { alert(e.message); }
  };
  const devDiscard = async () => {
    try {
      await api("/admin/agent/discard", { method: "POST", auth: true });
      setDevPending(null);
    } catch (e) { console.warn(e); }
  };
  const devClearChat = () => {
    if (!window.confirm("Clear the AI Dev chat?")) return;
    setDevHistory([]);
    setDevPending(null);
    devDiscard();
  };
  useEffect(() => {
    // eslint-disable-next-line react-hooks/exhaustive-deps
    if (mode === "visitors" && unlocked) loadVisitors();
  }, [filterUser]); // eslint-disable-line react-hooks/exhaustive-deps

  // Import
  const readFileText = (file) => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result || ""));
    fr.onerror = () => rej(fr.error || new Error("read failed"));
    fr.readAsText(file);
  });
  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (!(await requirePw("Importing files requires the admin password."))) return;
    const userTags = (iTags || "").split(",").map(s=>s.trim()).filter(Boolean);
    const items = [];
    const initRows = files.map(f => ({ name: f.name, status: "queued…", cls: "pending" }));
    setImportRows(prev => [...initRows, ...prev]);
    for (const f of files) {
      try {
        if (f.size > MAX_FILE_BYTES) throw new Error(`too big (${(f.size/1024).toFixed(0)}KB > 1024KB)`);
        const content = await readFileText(f);
        if (!content.trim()) throw new Error("file is empty");
        items.push({
          name: f.name,
          content,
          category: iBehavior ? "Behavior" : (iCategory || "Imported"),
          tags: userTags,
          behavior: iBehavior,
          owner: (iOwner || "").trim() || null,
        });
        setImportRows(prev => {
          const copy = [...prev]; const idx = copy.findIndex(x => x.name === f.name && x.status === "queued…");
          if (idx >= 0) copy[idx] = { ...copy[idx], status: "reading…" };
          return copy;
        });
      } catch (e) {
        setImportRows(prev => {
          const copy = [...prev]; const idx = copy.findIndex(x => x.name === f.name && x.status === "queued…");
          if (idx >= 0) copy[idx] = { ...copy[idx], status: "✗ " + e.message, cls: "err" };
          return copy;
        });
      }
    }
    if (!items.length) return;
    try {
      const r = await api("/knowledge/import", { method: "POST", auth: true, body: { files: items } });
      const okNames = new Set((r.saved || []).map(x => x.name));
      const errMap = Object.fromEntries((r.errors || []).map(x => [x.name, x.error]));
      setImportRows(prev => prev.map(row => {
        if (okNames.has(row.name)) return { ...row, status: "✓ imported", cls: "ok" };
        if (errMap[row.name]) return { ...row, status: "✗ " + errMap[row.name], cls: "err" };
        return row;
      }));
    } catch (e) {
      setImportRows(prev => prev.map(row => row.cls === "pending" ? { ...row, status: "✗ " + e.message, cls: "err" } : row));
    }
  };

  const toggleLock = async () => {
    if (getToken()) { setToken(""); setUnlocked(false); }
    else { await requirePw("Unlock admin actions (import, manage, queue, visitors)."); }
  };

  const installApp = async () => {
    if (!installEvt) return;
    installEvt.prompt();
    try { await installEvt.userChoice; } catch {}
    setInstallEvt(null);
  };

  const inputBarVisible = ["chat","query","research","code"].includes(mode);
  const adminTabs = ["import", "manage", "queue", "visitors", "access", "bugs", "self", "dev"];
  const visibleAdmin = unlocked ? adminTabs : [];
  const showLearningTab = learnUnlocked || unlocked;

  return (
    <div id="app">
      <div id="header">
        <div className="avatar">🧠</div>
        <div className="brand">
          <h1>Midget jr.</h1>
          <p>Self-growing · Research · Chat · Code</p>
        </div>
        <button className="hbtn is-invite" onClick={()=>setShowInvite(true)} title="Invite friends with a link / QR code" data-testid="invite-btn">
          <span className="hbtn-icon">🔗</span><span className="hbtn-label">Invite</span>
        </button>
        <button className="hbtn is-bug" onClick={()=>setShowBug(true)} title="Report a bug" data-testid="bug-btn">
          <span className="hbtn-icon">🐛</span><span className="hbtn-label">Bug</span>
        </button>
        {installEvt && (
          <button className="hbtn is-install" onClick={installApp} title="Install as app" data-testid="install-btn">
            <span className="hbtn-icon">📲</span><span className="hbtn-label">Install</span>
          </button>
        )}
        <button className="hbtn is-user" onClick={()=>setShowUsernameModal(true)} title="Change your name" data-testid="username-btn">
          <span className="hbtn-icon">👤</span><span className="hbtn-label">{username || "Set name"}</span>
        </button>
        <button className="hbtn is-history" onClick={()=>setShowHistory(true)} title="Chat history" data-testid="history-btn">
          <span className="hbtn-icon">📜</span><span className="hbtn-label">History</span>
        </button>
        <button className={"hbtn is-lock" + (unlocked ? " unlocked" : "")} onClick={toggleLock} title={unlocked ? "Admin unlocked" : "Unlock admin actions"} data-testid="lock-toggle">
          <span className="hbtn-icon">{unlocked ? "🔓" : "🔒"}</span>
          <span className="hbtn-label">{unlocked ? "Unlocked" : "Locked"}</span>
        </button>
        {unlocked && (
          <button className={"hbtn is-direct" + (directMode ? " on" : "")} onClick={toggleDirectMode} title="Direct Mode: drops disclaimers on edgy-but-legitimate topics" data-testid="direct-toggle">
            <span className="hbtn-icon">{directMode ? "⚡" : "🛡"}</span>
            <span className="hbtn-label">{directMode ? "Direct ON" : "Direct OFF"}</span>
          </button>
        )}
        <button className={"hbtn is-learn" + (learnUnlocked ? " on" : "")}
          onClick={learnUnlocked ? openLearningTab : ()=>setShowLearnGate(true)}
          title="Learning mode — judge past answers, save the good ones as exemplars"
          data-testid="learning-btn">
          <span className="hbtn-icon">🧪</span><span className="hbtn-label">{learnUnlocked ? "Learning" : "Learn"}</span>
        </button>
        {learnUnlocked && (
          <button className="hbtn icon-only" onClick={lockLearning} title="Lock learning mode" data-testid="learning-lock-btn">
            <span className="hbtn-icon">🔒</span><span className="hbtn-label">Lock learn</span>
          </button>
        )}
      </div>

      {!welcomeDismissed && (
        <div className="welcome-banner" data-testid="welcome-banner">
          <div className="welcome-body">
            <div className="welcome-title">Hey! I'm Midget jr. 🧠</div>
            <div className="welcome-text">
              I'm a self-growing knowledge bot. Use the tabs below to switch what I do — chat, query, research the web, or generate code. The more people use me, the more I learn.<br/>
              <span className="welcome-sub">🔗 Share this link with anyone — they can chat and help me grow. Only the admin can import files or manage my brain.</span>
            </div>
          </div>
          <button className="welcome-close"
            onClick={() => { localStorage.setItem(WELCOME_DISMISS_KEY, "1"); setWelcomeDismissed(true); }}
            data-testid="welcome-dismiss"
            title="Dismiss">✕</button>
        </div>
      )}

      <div id="tabs">
        {["chat","query","research","code","write"].map(m => (
          <button key={m} className={"tab" + (mode === m ? ` active-${m}` : "")} onClick={()=>setMode(m)} data-testid={`tab-${m}`}>
            {{chat:"💬 Chat",query:"🔍 Query",research:"🌐 Research",code:"💻 Code",write:"✍️ Write"}[m]}
          </button>
        ))}
        {visibleAdmin.map(m => (
          <button key={m} className={"tab admin-tab" + (mode === m ? ` active-${m}` : "")} onClick={()=>setMode(m)} data-testid={`tab-${m}`}>
            {{import:"📂 Import",manage:"🗂 Manage",queue:"📋 Queue",visitors:"👥 Visitors",access:"🎟 Access",bugs:"🐛 Bugs",self:"🛠 Self",dev:"🤖 AI Dev"}[m]}
          </button>
        ))}
        {showLearningTab && (
          <button className={"tab admin-tab" + (mode === "learning" ? " active-learning" : "")}
            onClick={()=>setMode("learning")} data-testid="tab-learning">
            🧪 Learning
          </button>
        )}
        {mode === "code" && (
          <select className="tab-pill-select" value={lang} onChange={(e)=>setLang(e.target.value)} data-testid="lang-select">
            {LANGS.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        )}
        {mode === "chat" && (
          <select className="tab-pill-select" value={citationStyle}
            onChange={(e)=>setCitationStyle(e.target.value)} data-testid="citation-select"
            title="Pick a citation style. Midget will quote sources and cite in this format.">
            {CITATION_STYLES.map(c => <option key={c.id} value={c.id}>📑 {c.label}</option>)}
          </select>
        )}
      </div>

      <div id="mode-label">{MODE_LABELS[mode]}</div>

      {!["queue","import","manage","visitors","access","bugs","learning","write","self","dev"].includes(mode) && (
        <div id="messages" data-testid="messages">
          <div className="tab-intro" data-testid={`intro-${mode}`}>
            <span className="tab-intro-pill">{ {chat:"💬",query:"🔍",research:"🌐",code:"💻"}[mode] }</span>
            <span>{MODE_INTROS[mode]}</span>
          </div>
          {messages.length === 0 && (
            <div className="empty-conversation">No {mode} messages yet — go ahead and try one 👇</div>
          )}
          {messages.map((m, i) => <Bubble key={i} msg={m} onShare={onShareBubble} onTeach={onTeachBubble}/>)}
          {typing && <Typing/>}
          <div ref={messagesEnd}/>
        </div>
      )}

      {mode === "dev" && (
        <div className="side-panel dev-tab" data-testid="dev-tab">
          <div className="tab-intro" data-testid="intro-dev">
            <span className="tab-intro-pill" style={{ background: "var(--purple)" }}>🤖</span>
            <span>{MODE_INTROS.dev}</span>
          </div>

          <div className="panel-card" style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <label className="check-row" style={{ marginBottom: 0 }}>
              <input type="checkbox" checked={devAutoApply}
                onChange={(e)=>setDevAutoApply(e.target.checked)}
                data-testid="dev-auto-apply"/>
              <span>⚡ Auto-apply edits <span className="hint" style={{ display:"inline" }}>— skip the approval click. ⚠️ Don't use for big files.</span></span>
            </label>
            <button className="copy-btn" onClick={devClearChat} style={{ marginLeft: "auto" }}
              data-testid="dev-clear-btn">🧹 Clear chat</button>
          </div>

          <div className="dev-chat" ref={devScrollRef} data-testid="dev-chat-pane">
            {devHistory.length === 0 && (
              <div className="empty-state">
                <p>💡 Try saying:</p>
                <ul style={{ textAlign: "left", maxWidth: 460, margin: "8px auto" }}>
                  <li>"Read backend/server.py and tell me what /api/chat does"</li>
                  <li>"In App.css, change the .midget-pulse animation to teal instead of pink"</li>
                  <li>"Add a /api/version endpoint that returns the package version"</li>
                  <li>"Push the current code to GitHub with message 'tweak chat color'"</li>
                </ul>
              </div>
            )}
            {devHistory.map((m, i) => (
              <div key={i} className={"dev-msg " + m.role}>
                <div className="dev-msg-avatar">{m.role === "user" ? "👤" : "🤖"}</div>
                <div className="dev-msg-body">
                  <div className="dev-msg-text">{m.content}</div>
                  {m.transcript && m.transcript.length > 1 && (
                    <details className="dev-msg-trace">
                      <summary>🔧 {m.transcript.filter(t=>t.type==="action").length} tool call(s)</summary>
                      <ol style={{ margin: "6px 0 0 18px", padding: 0 }}>
                        {m.transcript.filter(t => t.type === "action" || t.type === "result").map((t, j) => (
                          <li key={j} style={{ fontSize: 11, marginBottom: 4 }}>
                            {t.type === "action"
                              ? <><b>→ {t.action.tool}</b>{t.action.path ? ` · ${t.action.path}` : ""}{t.action.instruction ? ` · "${t.action.instruction.slice(0,80)}"` : ""}</>
                              : <span style={{ color: t.result?.ok === false ? "var(--pink)" : "var(--green)" }}>
                                  {t.result?.ok === false ? "✗" : "✓"} {(t.result?.error || (t.result?.applied ? "wrote " + t.result.applied : "")) || "ok"}
                                </span>}
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </div>
              </div>
            ))}
            {devBusy && (
              <div className="dev-msg assistant">
                <div className="dev-msg-avatar">🤖</div>
                <div className="dev-msg-body">
                  <div className="typing"><span></span><span></span><span></span></div>
                </div>
              </div>
            )}
          </div>

          {devPending && (
            <div className="panel-card" style={{ borderColor: "var(--green)" }}>
              <h3 style={{ color: "var(--green)" }}>📝 Pending draft: {devPending.path}</h3>
              <div className="hint">{devPending.old_size} → {devPending.new_size} chars. Apply to write it to disk.</div>
              <div className="row-flex" style={{ marginTop: 8 }}>
                <button className="qbtn" onClick={devApply}
                  style={{ background: "var(--green)", color: "var(--panel)" }}
                  data-testid="dev-apply-btn">✅ Apply</button>
                <button className="copy-btn" onClick={devDiscard} data-testid="dev-discard-btn">✗ Discard</button>
              </div>
            </div>
          )}

          <div className="dev-input-bar">
            <textarea
              value={devInput}
              onChange={(e)=>setDevInput(e.target.value)}
              onKeyDown={(e)=>{ if(e.key==="Enter" && !e.shiftKey) { e.preventDefault(); sendDev(); } }}
              placeholder="Tell Midget Dev what to do…"
              data-testid="dev-input"
              rows={2}/>
            <button className="qbtn" onClick={sendDev} disabled={devBusy || !devInput.trim()}
              data-testid="dev-send-btn"
              style={{ background: "var(--purple)" }}>
              {devBusy ? "…" : "↑ Send"}
            </button>
          </div>
        </div>
      )}

      {mode === "self" && (
        <div className="side-panel" data-testid="self-tab">
          <div className="tab-intro" data-testid="intro-self">
            <span className="tab-intro-pill">🛠</span>
            <span>{MODE_INTROS.self}</span>
          </div>

          <div className="panel-card">
            <h3>📁 Pick a file to edit</h3>
            <select className="qselect" value={selfPath}
              onChange={(e)=>{ setSelfPath(e.target.value); setSelfDiff(null); }}
              data-testid="self-file-select"
              style={{ width: "100%" }}>
              {selfFiles.map(f => (
                <option key={f.path} value={f.path}>{f.path} — {f.lines} lines · {(f.size/1024).toFixed(1)} KB</option>
              ))}
            </select>
            {selfPath && (
              <div className="hint" style={{ marginTop: 6 }}>
                {selfFiles.find(f => f.path === selfPath)?.description}
              </div>
            )}
          </div>

          <div className="panel-card">
            <h3>📝 Describe the change in plain English</h3>
            <textarea className="qinput"
              value={selfInstruction}
              onChange={(e)=>setSelfInstruction(e.target.value)}
              placeholder="e.g. 'Add a /api/health endpoint that returns {ok: true, uptime: process.uptime()}' or 'In App.css, change the chat tab pill color from pink to teal'"
              data-testid="self-instruction"
              rows={3}
              style={{ width: "100%", resize: "vertical" }}/>
            <div className="row-flex" style={{ marginTop: 8 }}>
              <button className="qbtn" onClick={proposeSelfEdit} disabled={selfBusy} data-testid="self-propose-btn">
                {selfBusy ? "…" : "✍️ Draft change"}
              </button>
              {selfDiff && (
                <button className="qbtn" onClick={applySelfEdit} disabled={selfBusy}
                  style={{ background: "var(--green)", color: "var(--panel)" }}
                  data-testid="self-apply-btn">
                  ✅ Apply edit
                </button>
              )}
            </div>
            {selfStatus && (
              <div className="hint" style={{ marginTop: 8,
                color: selfStatus.startsWith("❌") ? "var(--pink)"
                     : selfStatus.startsWith("✅") ? "var(--green)"
                     : "var(--sub)" }}>
                {selfStatus}
              </div>
            )}
          </div>

          {selfDiff && (
            <div className="panel-card">
              <h3>👀 Diff preview <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 11 }}>{selfDiff.path}</span></h3>
              <pre className="diff-pre" data-testid="self-diff-view">
                {selfDiff.diff || "(no textual diff produced)"}
              </pre>
            </div>
          )}

          <div className="panel-card">
            <h3>⤴ Push to GitHub</h3>
            {ghStatus && ghStatus.configured && (
              <div className="hint" style={{ marginBottom: 8 }}>
                Configured: <b>{ghStatus.repo}</b>@{ghStatus.branch}
                {ghStatus.dirty ? " · 🟡 uncommitted changes" : " · ✓ clean"}
              </div>
            )}
            <div className="row-flex">
              <input className="qinput" placeholder="owner/repo"
                value={ghRepo} onChange={(e)=>setGhRepo(e.target.value)}
                data-testid="gh-repo-input"/>
              <input className="qinput" placeholder="branch (main)"
                value={ghBranch} onChange={(e)=>setGhBranch(e.target.value)}
                data-testid="gh-branch-input" style={{ maxWidth: 140 }}/>
            </div>
            <div className="row-flex" style={{ marginTop: 8 }}>
              <input className="qinput" type="password"
                placeholder="GitHub PAT (ghp_... or fine-grained)"
                value={ghPat} onChange={(e)=>setGhPat(e.target.value)}
                data-testid="gh-pat-input" autoComplete="off"/>
              <button className="qbtn" onClick={setupGithub} data-testid="gh-setup-btn">💾 Save PAT</button>
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              Get a PAT at <code>github.com/settings/tokens</code>. Needs <code>repo</code> scope (or <code>contents:write</code> for fine-grained). The token is stored only in your MongoDB.
            </div>
            <div className="row-flex" style={{ marginTop: 12 }}>
              <input className="qinput" placeholder="Commit message"
                value={ghCommit} onChange={(e)=>setGhCommit(e.target.value)}
                data-testid="gh-commit-input"/>
              <button className="qbtn" onClick={pushGithub} disabled={selfBusy || !ghStatus?.configured}
                style={{ background: "var(--purple)" }} data-testid="gh-push-btn">
                ⤴ Push now
              </button>
            </div>
            {ghLog && <pre className="diff-pre" style={{ marginTop: 8, maxHeight: 220 }}>{ghLog}</pre>}
          </div>

          <div className="panel-card">
            <h3>⏪ Edit history ({selfHistory.length})</h3>
            {selfHistory.length === 0
              ? <div className="empty-state">No self-edits yet.</div>
              : selfHistory.map(h => (
                <div key={h.id} className="kb-item">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="kb-topic">{h.path}</div>
                    <div className="kb-summary">{h.summary || "(no summary)"}</div>
                    <div className="qi-meta">
                      <span className="qi-tag" style={{ color: "#6c7086" }}>{new Date(h.created_at).toLocaleString()}</span>
                    </div>
                  </div>
                  <button className="copy-btn" onClick={()=>rollbackSelfEdit(h.id)} data-testid={`self-rollback-${h.id}`}>⏪ Rollback</button>
                </div>
              ))}
          </div>
        </div>
      )}

      {mode === "write" && (
        <div className="side-panel write-tab" data-testid="write-tab">
          <div className="tab-intro" data-testid="intro-write">
            <span className="tab-intro-pill">✍️</span>
            <span>Open document. Click where you want the AI to type, describe what to write, hit <b>Type here</b>. It writes character-by-character at your cursor — and you can keep editing around it.</span>
          </div>

          <div className="write-controls">
            <textarea className="qinput write-instruction"
              value={writeInstruction}
              onChange={(e)=>setWriteInstruction(e.target.value)}
              placeholder="What should I write? e.g. 'a short polite cancellation email' or 'continue this story for a paragraph'"
              data-testid="write-instruction"
              rows={2}/>
            <div className="row-flex" style={{ marginTop: 8, gap: 8 }}>
              <input className="qinput" value={writeTone}
                onChange={(e)=>setWriteTone(e.target.value)}
                placeholder="Tone (e.g. professional, casual, witty)"
                data-testid="write-tone"
                style={{ flex: 2 }}/>
              <input className="qinput" type="number" min={80} max={4000}
                value={writeMaxChars}
                onChange={(e)=>setWriteMaxChars(e.target.value)}
                title="Max characters to insert"
                data-testid="write-max-chars"
                style={{ flex: 1, maxWidth: 110 }}/>
              <input className="qinput" type="number" min={1} max={200}
                value={writeSpeed}
                onChange={(e)=>setWriteSpeed(Number(e.target.value) || 18)}
                title="Typing speed (ms per character — lower is faster)"
                data-testid="write-speed"
                style={{ flex: 1, maxWidth: 110 }}/>
              <button
                className={"input-icon-btn" + (listening ? " is-listening" : "")}
                onClick={()=> listening ? stopVoice() : startVoice("write")}
                title={listening ? "Stop listening" : "Dictate instruction"}
                data-testid="write-voice-btn">
                {listening ? "🔴" : "🎤"}
              </button>
              {writeBusy
                ? <button className="qbtn" onClick={stopGhostType} data-testid="write-stop-btn"
                    style={{ background: "var(--orange)" }}>⏹ Stop</button>
                : <button className="qbtn" onClick={runGhostType} data-testid="write-type-btn">▶ Type here</button>}
            </div>
            <div className="row-flex" style={{ marginTop: 8, gap: 8 }}>
              <input className="qinput" value={rewriteTone}
                onChange={(e)=>setRewriteTone(e.target.value)}
                placeholder="Rewrite tone (e.g. punchier, formal, simpler)"
                data-testid="rewrite-tone"
                style={{ flex: 2 }}/>
              <button className="qbtn" onClick={rewriteSelection} disabled={writeBusy} data-testid="rewrite-btn"
                title="Highlight text in the document below, then click to rewrite it in this tone"
                style={{ background: "var(--purple)" }}>
                ✨ Rewrite selection
              </button>
            </div>
            <div className="row-flex" style={{ marginTop: 8, alignItems: "center", gap: 12 }}>
              <label className="check-row" style={{ marginBottom: 0 }}>
                <input type="checkbox" checked={humanize}
                  onChange={(e)=>setHumanize(e.target.checked)}
                  data-testid="humanize-toggle"/>
                <span>🧑 Humanize <span className="hint" style={{ display:"inline" }}>— casual voice + occasional realistic typos that self-correct</span></span>
              </label>
            </div>
            {writeStatus && (
              <div className="hint" style={{ marginTop: 8, color: writeStatus.startsWith("❌") ? "var(--pink)" : "var(--green)" }}>
                {writeStatus}
              </div>
            )}
          </div>

          <textarea ref={docRef}
            className="ghost-doc"
            value={doc}
            onChange={(e)=>setDoc(e.target.value)}
            placeholder="Your document starts blank. Type or paste anything here. Click where you want the AI to write next, then hit 'Type here' above."
            data-testid="write-doc"/>

          <div className="row-flex" style={{ marginTop: 8, gap: 8 }}>
            <input className="qinput" value={googleDocUrl}
              onChange={(e)=>setGoogleDocUrl(e.target.value)}
              placeholder="Paste a Google Doc URL (optional) to copy + open"
              data-testid="gdoc-url"
              style={{ flex: 1 }}/>
            <button className="qbtn" onClick={copyDocAndOpenGoogle} data-testid="gdoc-copy-open"
              style={{ background: "var(--blue)" }}>
              📋 Copy {googleDocUrl ? "+ open Doc" : "to clipboard"}
            </button>
          </div>

          <div className="row-flex" style={{ marginTop: 8, justifyContent: "flex-end" }}>
            <span className="hint" style={{ marginRight: "auto" }}>
              {doc.length.toLocaleString()} chars · ~{Math.max(1, Math.round(doc.split(/\s+/).filter(Boolean).length))} words
            </span>
            <button className="copy-btn" onClick={downloadDoc} data-testid="write-download">⬇ Download .txt</button>
            <button className="qi-del" onClick={clearDoc} data-testid="write-clear">🗑 Clear</button>
          </div>
        </div>
      )}

      {mode === "queue" && (
        <div className="side-panel">
          <div className="tab-intro" data-testid="intro-queue">
            <span className="tab-intro-pill">📋</span>
            <span>{MODE_INTROS.queue}</span>
          </div>
          <div className="panel-card">
            <h3>➕ Add topic to auto-research queue</h3>
            <div className="row-flex">
              <input className="qinput" value={qTopic} onChange={(e)=>setQTopic(e.target.value)}
                onKeyDown={(e)=>{ if(e.key==="Enter") addToQueue(); }}
                placeholder="Topic to research..." data-testid="queue-topic-input"/>
              <select className="qselect" value={qCat} onChange={(e)=>setQCat(e.target.value)}>
                {CATEGORIES.map(c => <option key={c}>{c}</option>)}
              </select>
              <button className="qbtn" onClick={addToQueue} data-testid="queue-add-btn">Add</button>
            </div>
            <div className="hint">🔒 Adding/deleting requires admin password. Auto-promoted topics appear here automatically when 3+ visitors ask similar questions.</div>
          </div>
          <div id="queue-list">
            {queueLoading ? <div className="empty-state">Loading queue...</div>
              : queue.length === 0 ? <div className="empty-state">Queue is empty — add a topic above 👆</div>
              : queue.map(item => (
                  <div key={item.id} className="queue-item">
                    <span className="qi-icon">{ {pending:"⏳",done:"✅",failed:"❌",running:"🔄"}[item.status] || "⏳" }</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="qi-topic">{item.topic}</div>
                      <div className="qi-meta">
                        <span className="qi-tag" style={{ color: "#89b4fa" }}>{item.category || "General"}</span>
                        <span className="qi-tag" style={{ color: {pending:"#f9e2af",done:"#a6e3a1",failed:"#f38ba8",running:"#74c7ec"}[item.status] || "#f9e2af" }}>{item.status}</span>
                        <span className="qi-tag" style={{ color: "#6c7086" }}>{item.added_by === "auto" ? "🤖 auto-promoted" : "👤 you"}</span>
                      </div>
                      {item.error && <div style={{ color:"#f38ba8", fontSize:11, marginTop:4 }}>{item.error}</div>}
                    </div>
                    {item.status === "pending" && (
                      <button className="qi-del" onClick={()=>deleteQueueItem(item.id)} data-testid={`queue-delete-${item.id}`}>✕</button>
                    )}
                  </div>
                ))
            }
          </div>
        </div>
      )}

      {mode === "import" && (
        <div className="side-panel">
          <div className="tab-intro" data-testid="intro-import">
            <span className="tab-intro-pill">📂</span>
            <span>{MODE_INTROS.import}</span>
          </div>
          <div className="panel-card">
            <h3>📂 Import files into Midget's brain</h3>
            <label className={"dropzone" + (dragOver ? " drag" : "")}
              onClick={()=>fileInputRef.current?.click()}
              onDragEnter={(e)=>{ e.preventDefault(); setDragOver(true); }}
              onDragOver={(e)=>{ e.preventDefault(); setDragOver(true); }}
              onDragLeave={(e)=>{ e.preventDefault(); setDragOver(false); }}
              onDrop={(e)=>{ e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
              data-testid="dropzone">
              <div className="big">⬆️</div>
              <div><strong>Drop files here</strong> or click to choose</div>
              <div className="types">.txt .md .json .csv .log .yaml .xml .html .css .js .ts .py .go .rs .java .cpp .c .h .sh .sql</div>
              <input ref={fileInputRef} type="file" multiple accept={ACCEPT}
                style={{ display: "none" }}
                onChange={(e)=>{ handleFiles(e.target.files); e.target.value = ""; }}
                data-testid="file-input"/>
            </label>
            <div className="row-flex" style={{ marginTop: 12 }}>
              <input className="qinput" placeholder="Category (optional)" value={iCategory} onChange={(e)=>setICategory(e.target.value)} disabled={iBehavior}/>
              <input className="qinput" placeholder="Tags, comma-separated (optional)" value={iTags} onChange={(e)=>setITags(e.target.value)}/>
            </div>
            <div className="row-flex" style={{ marginTop: 10 }}>
              <label className="check-row" style={{ flex: 1 }}>
                <input type="checkbox" checked={iBehavior} onChange={(e)=>setIBehavior(e.target.checked)} data-testid="behavior-toggle"/>
                <span>🎨 <b>Behavior file</b> — change how Midget acts (prepended to every chat's system prompt)</span>
              </label>
            </div>
            <div className="row-flex" style={{ marginTop: 8 }}>
              <input className="qinput" placeholder="Owner username (for style-mimicry, leave blank for shared)" value={iOwner} onChange={(e)=>setIOwner(e.target.value)} data-testid="owner-input"/>
            </div>
            <div className="hint">🔒 Importing requires the admin password. Files are read in-browser and saved as knowledge entries (text only, max 1&nbsp;MB each).{" "}
              <strong>Behavior</strong> files alter the bot's voice for everyone. Files with an <strong>Owner</strong> get used as writing-style samples when that user chats.</div>
          </div>
          <div id="import-list">
            {importRows.map((row, i) => (
              <div className="import-row" key={i}>
                <span>📄</span><span className="name">{row.name}</span>
                <span className={"status " + row.cls}>{row.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {mode === "manage" && (
        <div className="side-panel">
          <div className="tab-intro" data-testid="intro-manage">
            <span className="tab-intro-pill">🗂</span>
            <span>{MODE_INTROS.manage}</span>
          </div>
          <div className="panel-card">
            <h3>🗂 Knowledge entries ({kbList.length})</h3>
            <input className="qinput" placeholder="Search by topic / summary / tag..."
              value={kbSearch} onChange={(e)=>setKbSearch(e.target.value)}
              style={{ width: "100%" }} data-testid="manage-search"/>
            <div className="hint">🔒 Deleting requires the admin password. Entries are also auto-saved by the Research and Import tools.</div>
          </div>
          <div>
            {kbLoading ? <div className="empty-state">Loading entries…</div>
             : filteredKB.length === 0 ? <div className="empty-state">{kbList.length === 0 ? "No knowledge yet — try Research or Import." : "No matches."}</div>
             : filteredKB.map(e => (
                <div key={e.id} className="kb-item">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="kb-topic">{e.topic}</div>
                    <div className="kb-summary">{(e.summary || "").slice(0, 200)}{(e.summary || "").length > 200 ? "…" : ""}</div>
                    <div className="qi-meta">
                      <span className="qi-tag" style={{ color: "#89b4fa" }}>{e.category || "General"}</span>
                      <span className="qi-tag" style={{ color: "#6c7086" }}>👤 {e.added_by || "?"}</span>
                      {(e.tags || []).slice(0, 5).map((t, i) => <span key={i} className="qi-tag" style={{ color: "#cba6f7" }}>{t}</span>)}
                      {e.source_url && <a className="qi-tag" style={{ color: "#74c7ec", textDecoration: "none" }} href={e.source_url} target="_blank" rel="noreferrer">🔗 source</a>}
                    </div>
                  </div>
                  <button className="qi-del" onClick={()=>deleteKB(e.id)} title="Delete entry" data-testid={`kb-delete-${e.id}`}>✕</button>
                </div>
              ))}
          </div>
        </div>
      )}

      {mode === "visitors" && (
        <div className="side-panel">
          <div className="tab-intro" data-testid="intro-visitors">
            <span className="tab-intro-pill">👥</span>
            <span>{MODE_INTROS.visitors}</span>
          </div>
          <div className="panel-card">
            <h3>👥 Visitors {visitors.length > 0 && `(${visitors.length})`}</h3>
            <div className="visitor-grid">
              {adminLoading && <div className="empty-state">Loading…</div>}
              {!adminLoading && visitors.length === 0 && <div className="empty-state">No chats logged yet.</div>}
              {!adminLoading && visitors.map(v => (
                <button key={v.username} type="button"
                  className={"visitor-pill" + (filterUser === v.username ? " active" : "")}
                  onClick={()=>setFilterUser(filterUser === v.username ? "" : v.username)}
                  data-testid={`visitor-${v.username}`}>
                  <span className="vp-name">👤 {v.username}</span>
                  <span className="vp-count">{v.count}</span>
                </button>
              ))}
              {!adminLoading && filterUser && (
                <button type="button" className="visitor-pill clear" onClick={()=>setFilterUser("")}>✕ Clear filter</button>
              )}
            </div>
            <div className="hint">Click a name to filter the question log below. Click again to clear.</div>
          </div>
          <div className="panel-card">
            <h3>💬 Question log {filterUser && `— filtered: ${filterUser}`}</h3>
            <div>
              {chatLog.length === 0 ? <div className="empty-state">No messages.</div>
                : chatLog.map(m => (
                    <div key={m.id} className="chatlog-item">
                      <div className="chatlog-head">
                        <span className="chatlog-user">👤 {m.username || "guest"}</span>
                        <span className="chatlog-time">{new Date(m.created_at).toLocaleString()}</span>
                      </div>
                      <div className="chatlog-q">{m.user_message}</div>
                      <div className="chatlog-a">🧠 {m.bot_reply}</div>
                    </div>
                  ))}
            </div>
          </div>
        </div>
      )}

      {mode === "access" && (
        <div className="side-panel">
          <div className="tab-intro" data-testid="intro-access">
            <span className="tab-intro-pill">🎟</span>
            <span>{MODE_INTROS.access}</span>
          </div>
          <div className="panel-card">
            <h3>🔐 Private mode {accessMode ? "ON" : "OFF"}</h3>
            <p className="hint" style={{ marginTop: 0 }}>When ON, everyone (except admins) needs an invite code to chat.</p>
            <button className={"qbtn" + (accessMode ? "" : "")}
              onClick={togglePrivate}
              style={{ background: accessMode ? "var(--pink)" : "linear-gradient(135deg, var(--blue), var(--purple))" }}
              data-testid="toggle-private">
              {accessMode ? "Turn OFF private mode" : "Turn ON private mode"}
            </button>
          </div>
          <div className="panel-card">
            <h3>➕ Generate invite code</h3>
            <div className="row-flex" style={{ alignItems: "stretch" }}>
              <input className="qinput"
                placeholder="Custom code (leave blank to auto-generate)"
                value={codeCustom}
                onChange={(e)=>setCodeCustom(e.target.value)}
                data-testid="code-custom-input"
                style={{ flex: 2, minWidth: 220 }}/>
              <select className="qselect" value={codeComplexity}
                onChange={(e)=>setCodeComplexity(e.target.value)}
                data-testid="code-complexity-select"
                style={{ maxWidth: 200 }}
                title="Strong = 12+ chars with upper, lower, digit, symbol">
                <option value="weak">🔓 Weak (≥ 4 chars)</option>
                <option value="strong">🔐 Strong (12+, mixed case + digit + symbol)</option>
              </select>
            </div>
            <div className="row-flex" style={{ marginTop: 8 }}>
              <input className="qinput" placeholder="Label (e.g. 'Alex')" value={codeLabel} onChange={(e)=>setCodeLabel(e.target.value)}/>
              <input className="qinput" type="number" placeholder="Expires in days" value={codeDays} onChange={(e)=>setCodeDays(e.target.value)} style={{ maxWidth: 140 }}/>
              <input className="qinput" type="number" placeholder="Max uses (blank = ∞)" value={codeMax} onChange={(e)=>setCodeMax(e.target.value)} style={{ maxWidth: 160 }}/>
              <button className="qbtn" onClick={createCode} data-testid="create-code-btn">Create</button>
            </div>
            {codeComplexity === "strong" && (
              <div className="hint" style={{ marginTop: 6 }}>
                🔐 Strong codes need 12+ characters with a mix of UPPERCASE, lowercase, a digit, and a symbol like <code>!@#$</code>.
                Examples: <code>Th!s_Is_S@fe2026</code>, <code>Br0wn-F0x_Jumps!</code>. Leave the field blank to auto-generate one.
              </div>
            )}
          </div>
          <div>
            {codes.length === 0 ? <div className="empty-state">No codes yet. Create one above 👆</div>
              : codes.map(c => (
                <div key={c.code} className={"code-row" + (c.active ? "" : " inactive")}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="code-line">
                      <span className="code-text">{c.code}</span>
                      {c.label && <span className="code-label">{c.label}</span>}
                      <span className={"code-status " + (c.active ? "ok" : "off")}>{c.active ? "active" : (c.revoked ? "revoked" : c.expired ? "expired" : c.maxed ? "used up" : "off")}</span>
                    </div>
                    <div className="qi-meta">
                      <span className="qi-tag" style={{ color: "#a6adc8" }}>uses: {c.uses}{c.max_uses ? "/"+c.max_uses : ""}</span>
                      {c.complexity === "strong" && <span className="qi-tag" style={{ color: "#94e2d5" }}>🔐 strong</span>}
                      {c.expires_at && <span className="qi-tag" style={{ color: "#a6e3a1" }}>expires {new Date(c.expires_at).toLocaleDateString()}</span>}
                      <span className="qi-tag" style={{ color: "#6c7086" }}>made {new Date(c.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="copy-btn" onClick={()=>copyCodeUrl(c.code)} title="Copy invite URL">🔗 Link</button>
                    {!c.revoked && c.active && (
                      <button className="qi-del" onClick={()=>revokeCode(c.code)} title="Revoke">✕</button>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {mode === "bugs" && (
        <div className="side-panel">
          <div className="tab-intro" data-testid="intro-bugs">
            <span className="tab-intro-pill">🐛</span>
            <span>{MODE_INTROS.bugs}</span>
          </div>
          <div className="panel-card">
            <h3>🐛 Bug reports ({bugList.length})</h3>
            <div className="hint" style={{ marginTop: 0 }}>Newest first. Click delete to clear once handled.</div>
          </div>
          <div>
            {bugList.length === 0 ? <div className="empty-state">No bugs reported yet 🎉</div>
              : bugList.map(b => (
                <div key={b.id} className="bug-item">
                  <div className="bug-head">
                    <span className="bug-user">👤 {b.username || "guest"}</span>
                    <span className="bug-time">{new Date(b.created_at).toLocaleString()}</span>
                    <button className="qi-del" onClick={()=>deleteBug(b.id)} title="Delete">✕</button>
                  </div>
                  <div className="bug-section"><span className="bug-label">What broke:</span> {b.description}</div>
                  <div className="bug-section"><span className="bug-label">Steps:</span> {b.steps}</div>
                  {b.screenshot && (
                    <img src={b.screenshot} alt="screenshot" style={{ marginTop: 10, maxWidth: "100%", borderRadius: 8, background: "#181825", display: "block" }}/>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}

      {mode === "learning" && (
        <div className="side-panel">
          <div className="tab-intro" data-testid="intro-learning">
            <span className="tab-intro-pill">🧪</span>
            <span>{MODE_INTROS.learning}</span>
          </div>
          <div className="panel-card">
            <h3>🧪 Run a learning pass</h3>
            <div className="row-flex">
              <input className="qinput" type="number" placeholder="How many recent messages"
                value={learnLimit} onChange={(e)=>setLearnLimit(e.target.value)}
                style={{ maxWidth: 200 }} data-testid="learning-limit"/>
              <input className="qinput" type="number" placeholder="Min approval score (0-10)"
                value={learnMinScore} onChange={(e)=>setLearnMinScore(e.target.value)}
                style={{ maxWidth: 200 }} data-testid="learning-min-score"/>
              <button className="qbtn" onClick={runLearningPass} disabled={learnRunning} data-testid="learning-run-btn">
                {learnRunning ? "Judging…" : "▶ Run pass"}
              </button>
            </div>
            <div className="hint">An LLM judge reads each Q+A from chat history and rates it 0–10 on helpfulness + safety. Scores ≥ {learnMinScore} are saved as approved exemplars and injected into future replies.</div>
            {learnLastRun && (
              <div className="hint" style={{ marginTop: 8, color: "#a6e3a1" }}>
                Last pass: judged <b>{learnLastRun.judged}</b> · approved <b>{learnLastRun.approved}</b>
              </div>
            )}
          </div>
          <div className="panel-card">
            <h3>📚 Saved exemplars ({exemplarsList.length})</h3>
            <label className="check-row">
              <input type="checkbox" checked={learnApprovedOnly}
                onChange={(e)=>{ setLearnApprovedOnly(e.target.checked); loadExemplars(e.target.checked); }}
                data-testid="learning-approved-only"/>
              <span>Show only approved</span>
            </label>
            <div className="hint" style={{ marginTop: 0 }}>Only ✓ approved exemplars are injected into future chats (top 4 by score).</div>
          </div>
          <div>
            {exemplarsList.length === 0
              ? <div className="empty-state">No exemplars yet. Run a pass above 👆</div>
              : exemplarsList.map(ex => (
                <div key={ex.id} className={"kb-item" + (ex.approved ? "" : " inactive")}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="kb-topic">
                      {ex.approved ? "✅" : "⚪"} Score {ex.score}/10 — {ex.username || "guest"}
                    </div>
                    <div className="kb-summary" style={{ marginTop: 4 }}>
                      <b>Q:</b> {ex.question}
                    </div>
                    <div className="kb-summary" style={{ marginTop: 4 }}>
                      <b>A:</b> {(ex.answer || "").slice(0, 280)}{(ex.answer || "").length > 280 ? "…" : ""}
                    </div>
                    {ex.reason && <div className="qi-meta" style={{ marginTop: 4 }}><span className="qi-tag" style={{ color: "#94e2d5" }}>judge: {ex.reason}</span></div>}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <button className="copy-btn" onClick={()=>toggleExemplar(ex.id)} data-testid={`exemplar-toggle-${ex.id}`}>
                      {ex.approved ? "Reject" : "Approve"}
                    </button>
                    <button className="qi-del" onClick={()=>deleteExemplar(ex.id)} data-testid={`exemplar-delete-${ex.id}`}>✕</button>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {inputBarVisible && (
        <div id="input-bar">
          {attachedImage && mode === "chat" && (
            <div className="img-preview" data-testid="img-preview">
              <img src={attachedImage} alt="attached"/>
              <div className="img-preview-info">
                <span>📎 {attachedImageMeta?.name || "image"}</span>
                <button className="img-preview-x" onClick={clearImage} data-testid="img-preview-remove">✕</button>
              </div>
            </div>
          )}
          <div id="input-wrap" style={{ borderColor: accent + "44", boxShadow: `0 0 18px ${accent}11` }}>
            <textarea ref={taRef} id="chat-input" rows={1} value={text}
              onChange={(e)=>{
                setText(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 110) + "px";
              }}
              onPaste={(e)=>{
                if (mode !== "chat") return;
                const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith("image/"));
                if (item) { e.preventDefault(); attachImage(item.getAsFile()); }
              }}
              onKeyDown={(e)=>{ if(e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={username ? MODE_PLACEHOLDERS[mode] : "Set a name first 👆"}
              data-testid="chat-input"/>
            {mode === "chat" && (
              <>
                <label className="input-icon-btn" title="Attach an image (vision)" data-testid="attach-img-btn">
                  📎
                  <input type="file" accept="image/*" style={{ display: "none" }}
                    onChange={(e)=>{ attachImage(e.target.files?.[0]); e.target.value = ""; }}/>
                </label>
              </>
            )}
            <button
              className={"input-icon-btn" + (listening ? " is-listening" : "")}
              onClick={()=> listening ? stopVoice() : startVoice("chat")}
              title={listening ? "Stop listening" : "Speak"}
              data-testid="voice-btn">
              {listening ? "🔴" : "🎤"}
            </button>
            <button id="send-btn" onClick={send} disabled={typing || (!text.trim() && !attachedImage)} data-testid="send-btn">↑</button>
          </div>
          <div id="input-hint">
            {username ? <>Asking as <b>{username}</b> · Enter to send · Shift+Enter for new line {mode === "chat" && "· Paste/drop images · 🎤 to speak"}</>
                      : <>👆 Click "Set name" to start chatting</>}
          </div>
        </div>
      )}

      {pwPrompt && (
        <PasswordModal label={pwPrompt.label} onClose={pwPrompt.onClose} onUnlock={pwPrompt.onSuccess}/>
      )}
      {showLearnGate && (
        <LearningModal onClose={()=>setShowLearnGate(false)}
          onUnlock={()=>{ setLearnUnlocked(true); setShowLearnGate(false); setMode("learning"); }}/>
      )}
      {needsGate && <GuestGate initialCode={initialGateCode} onAuthed={onGuestAuthed}/>}
      {showInvite && <InviteDialog onClose={()=>setShowInvite(false)}/>}
      {showBug && <BugDialog onClose={()=>setShowBug(false)} username={username}/>}
      {showHistory && <HistoryPanel onClose={()=>setShowHistory(false)} sessionId={sessionId}/>}
      {shareDlgId && <ShareDialog shareId={shareDlgId} onClose={()=>setShareDlgId(null)}/>}
      {showUsernameModal && (
        <UsernameModal initial={username} sessionId={sessionId}
          onSet={(n)=>{ setUsername(n); setShowUsernameModal(false); }}/>
      )}
    </div>
  );
}
