import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import "./App.css";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;
const UNLOCK_KEY = "mj_token";
const HISTORY_KEY = "mj_chat_history";   // rolling short window for LLM context
const ARCHIVE_KEY = "mj_chat_archive";   // local-device full archive
const USERNAME_KEY = "mj_username";
const SESSION_KEY = "mj_session_id";
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
  visitors: "#74c7ec", manage: "#f5c2e7",
};
const MODE_LABELS = {
  chat: "💬 Chat — ask me anything, I'll use my knowledge base + AI",
  query: "🔍 Query — search exact entries in the knowledge base",
  research: "🌐 Research — fetch info from the web (Google) and save it",
  code: "💻 Code — generate code with AI (download any file type)",
  import: "📂 Import — upload files to grow Midget's brain (admin)",
  manage: "🗂 Manage — list, search, delete knowledge entries (admin)",
  queue: "📋 Queue — topics scheduled for auto-research every 6 hours",
  visitors: "👥 Visitors — see who's been asking what (admin)",
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
};

const WELCOME_DISMISS_KEY = "mj_welcome_dismissed";

const LANGS = ["python","javascript","typescript","java","c++","go","rust","sql","bash","html","css","json","markdown"];
const CATEGORIES = ["General","Science","Technology","History","Math","Health","Philosophy","Art"];
const ACCEPT = ".txt,.md,.markdown,.json,.csv,.log,.yaml,.yml,.xml,.html,.htm,.css,.js,.mjs,.ts,.tsx,.jsx,.py,.go,.rs,.java,.cpp,.cc,.c,.h,.hpp,.sh,.bash,.sql,.toml,.ini,.conf,.rb,.php,.swift,.kt";

const uuid = () => "s" + Math.random().toString(36).slice(2) + Date.now().toString(36);
const loadJSON = (k, fallback) => {
  try { const x = JSON.parse(localStorage.getItem(k) || "null"); return x == null ? fallback : x; }
  catch { return fallback; }
};
const saveJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const getToken = () => sessionStorage.getItem(UNLOCK_KEY) || "";
const setToken = (t) => t ? sessionStorage.setItem(UNLOCK_KEY, t) : sessionStorage.removeItem(UNLOCK_KEY);
const getOrCreateSessionId = () => {
  let s = localStorage.getItem(SESSION_KEY);
  if (!s) { s = uuid(); localStorage.setItem(SESSION_KEY, s); }
  return s;
};

async function api(path, { method = "GET", body, auth = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth) {
    const t = getToken();
    if (!t) throw new Error("Locked — unlock first");
    headers.Authorization = `Bearer ${t}`;
  }
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
  } catch (netErr) {
    throw new Error("Network error — is the backend awake? (Render free tier sleeps after 15min; first request takes ~30s.)");
  }
  // Read body exactly once, swallow errors so we never throw "body stream already read"
  let text = "";
  try { text = await res.text(); } catch { /* body unavailable */ }
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { /* not JSON */ } }
  if (!res.ok) {
    const msg = (data && (data.detail || data.error)) || `HTTP ${res.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
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

function UsernameModal({ initial, onSet }) {
  const [name, setName] = useState(initial || "");
  const [err, setErr] = useState("");
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const submit = () => {
    const n = name.trim().slice(0, 40);
    if (n.length < 2) { setErr("Pick at least 2 characters."); return; }
    if (!/^[\w \-_.]+$/.test(n)) { setErr("Letters, numbers, spaces, _ - . only."); return; }
    localStorage.setItem(USERNAME_KEY, n);
    onSet(n);
  };
  return (
    <div className="modal-bg">
      <div className="modal" role="dialog">
        <h2>👋 What should I call you?</h2>
        <p>Pick a name so the admin knows who's been chatting. You can change it later from the 👤 button.</p>
        <input ref={inputRef} value={name}
          onChange={(e)=>setName(e.target.value)}
          onKeyDown={(e)=>{ if(e.key==="Enter") submit(); }}
          placeholder="e.g. Alex, midget_fan_42, …" data-testid="username-input"/>
        <div className="err">{err}</div>
        <div className="actions">
          <button className="qbtn" type="button" onClick={submit} data-testid="username-submit">Continue</button>
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

function Bubble({ msg, onShare }) {
  if (msg.role === "user") {
    return (
      <div className="msg-row user">
        <div className="bubble user">{msg.content}</div>
        <div className="bubble-avatar user">{(msg.username || "U")[0].toUpperCase()}</div>
      </div>
    );
  }
  const shareable = !!msg.lastUserQuestion && (msg.content || msg.code);
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
        {shareable && (
          <button className="share-link-btn" type="button"
            onClick={()=>onShare(msg)} data-testid="bubble-share-btn">
            🔗 Share
          </button>
        )}
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
  useEffect(() => {
    api(`/share/${shareId}`).then(setData).catch(e => setErr(e.message));
  }, [shareId]);
  const back = () => {
    const u = new URL(window.location);
    u.searchParams.delete("share");
    window.location.href = u.pathname;
  };
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, unlocked]);

  // PWA install prompt capture
  useEffect(() => {
    const h = (e) => { e.preventDefault(); setInstallEvt(e); };
    window.addEventListener("beforeinstallprompt", h);
    return () => window.removeEventListener("beforeinstallprompt", h);
  }, []);

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
  const pushUser = (t) => setMessagesByMode(s => ({ ...s, [mode]: [...(s[mode]||[]), { role: "user", content: t, username }] }));
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
    pushUser(t);
    setTyping(true);
    const now = new Date().toISOString();
    const archiveBuf = [{ role: "user", content: t, mode, username, at: now }];
    try {
      if (mode === "chat") {
        const r = await api("/chat", { method: "POST", body: { message: t, history, session_id: sessionId, username } });
        pushBotIn("chat", { content: r.reply, ctx: r.context_used, lastUserQuestion: t, mode: "chat" });
        archiveBuf.push({ role: "bot", content: r.reply, mode, at: new Date().toISOString() });
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
        items.push({ name: f.name, content, category: iCategory || "Imported", tags: userTags });
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
  const adminTabs = ["import", "manage", "queue", "visitors"];
  const visibleAdmin = unlocked ? adminTabs : [];

  return (
    <div id="app">
      <div id="header">
        <div className="avatar">🧠</div>
        <div>
          <h1>Midget jr.</h1>
          <p>Self-growing · Research · Chat · Code</p>
        </div>
        {installEvt && (
          <button id="install-btn" onClick={installApp} title="Install as app" data-testid="install-btn">
            <span>📲</span><span>Install</span>
          </button>
        )}
        <button id="username-btn" onClick={()=>setShowUsernameModal(true)} title="Change name" data-testid="username-btn">
          <span>👤</span><span>{username || "Set name"}</span>
        </button>
        <button id="history-btn" onClick={()=>setShowHistory(true)} data-testid="history-btn">
          <span>📜</span><span>History</span>
        </button>
        <button id="lock-toggle" className={unlocked ? "unlocked" : ""} onClick={toggleLock} data-testid="lock-toggle">
          <span>{unlocked ? "🔓" : "🔒"}</span>
          <span>{unlocked ? "Unlocked" : "Locked"}</span>
        </button>
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
        {["chat","query","research","code"].map(m => (
          <button key={m} className={"tab" + (mode === m ? ` active-${m}` : "")} onClick={()=>setMode(m)} data-testid={`tab-${m}`}>
            {{chat:"💬 Chat",query:"🔍 Query",research:"🌐 Research",code:"💻 Code"}[m]}
          </button>
        ))}
        {visibleAdmin.map(m => (
          <button key={m} className={"tab admin-tab" + (mode === m ? ` active-${m}` : "")} onClick={()=>setMode(m)} data-testid={`tab-${m}`}>
            {{import:"📂 Import",manage:"🗂 Manage",queue:"📋 Queue",visitors:"👥 Visitors"}[m]}
          </button>
        ))}
        {mode === "code" && (
          <select id="lang-select" value={lang} onChange={(e)=>setLang(e.target.value)} data-testid="lang-select">
            {LANGS.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        )}
      </div>

      <div id="mode-label">{MODE_LABELS[mode]}</div>

      {!["queue","import","manage","visitors"].includes(mode) && (
        <div id="messages" data-testid="messages">
          <div className="tab-intro" data-testid={`intro-${mode}`}>
            <span className="tab-intro-pill">{ {chat:"💬",query:"🔍",research:"🌐",code:"💻"}[mode] }</span>
            <span>{MODE_INTROS[mode]}</span>
          </div>
          {messages.length === 0 && (
            <div className="empty-conversation">No {mode} messages yet — go ahead and try one 👇</div>
          )}
          {messages.map((m, i) => <Bubble key={i} msg={m} onShare={onShareBubble}/>)}
          {typing && <Typing/>}
          <div ref={messagesEnd}/>
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
              <input className="qinput" placeholder="Category (optional)" value={iCategory} onChange={(e)=>setICategory(e.target.value)}/>
              <input className="qinput" placeholder="Tags, comma-separated (optional)" value={iTags} onChange={(e)=>setITags(e.target.value)}/>
            </div>
            <div className="hint">🔒 Importing requires the admin password. Files are read in-browser and saved as knowledge entries (text only, max 1&nbsp;MB each).</div>
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

      {inputBarVisible && (
        <div id="input-bar">
          <div id="input-wrap" style={{ borderColor: accent + "44", boxShadow: `0 0 18px ${accent}11` }}>
            <textarea ref={taRef} id="chat-input" rows={1} value={text}
              onChange={(e)=>{
                setText(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 110) + "px";
              }}
              onKeyDown={(e)=>{ if(e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={username ? MODE_PLACEHOLDERS[mode] : "Set a name first 👆"}
              data-testid="chat-input"/>
            <button id="send-btn" onClick={send} disabled={typing || !text.trim()} data-testid="send-btn">↑</button>
          </div>
          <div id="input-hint">
            {username ? <>Asking as <b>{username}</b> · Enter to send · Shift+Enter for new line</>
                      : <>👆 Click "Set name" to start chatting</>}
          </div>
        </div>
      )}

      {pwPrompt && (
        <PasswordModal label={pwPrompt.label} onClose={pwPrompt.onClose} onUnlock={pwPrompt.onSuccess}/>
      )}
      {showHistory && <HistoryPanel onClose={()=>setShowHistory(false)} sessionId={sessionId}/>}
      {shareDlgId && <ShareDialog shareId={shareDlgId} onClose={()=>setShareDlgId(null)}/>}
      {showUsernameModal && (
        <UsernameModal initial={username}
          onSet={(n)=>{ setUsername(n); setShowUsernameModal(false); }}/>
      )}
    </div>
  );
}
