import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;
const UNLOCK_KEY = "mj_token";
const HISTORY_KEY = "mj_chat_history";
const MAX_FILE_BYTES = 1024 * 1024;

const MODE_COLORS = {
  chat: "#f38ba8", query: "#89b4fa", research: "#a6e3a1",
  code: "#cba6f7", import: "#fab387", queue: "#f9e2af",
};
const MODE_LABELS = {
  chat: "💬 Chat — ask me anything, I'll use my knowledge base + AI",
  query: "🔍 Query — search exact entries in the knowledge base",
  research: "🌐 Research — fetch info from the web (Google) and save it",
  code: "💻 Code — generate code with AI",
  import: "📂 Import — upload files to grow Midget's brain (admin)",
  queue: "📋 Queue — topics scheduled for auto-research every 6 hours",
};
const MODE_PLACEHOLDERS = {
  chat: "Ask me anything...",
  query: "Search the knowledge base...",
  research: "Enter a topic to research from the web...",
  code: "Describe the code you need...",
};

const LANGS = ["python","javascript","typescript","java","c++","go","rust","sql","bash"];
const CATEGORIES = ["General","Science","Technology","History","Math","Health","Philosophy","Art"];
const ACCEPT = ".txt,.md,.markdown,.json,.csv,.log,.yaml,.yml,.xml,.html,.htm,.css,.js,.mjs,.ts,.tsx,.jsx,.py,.go,.rs,.java,.cpp,.cc,.c,.h,.hpp,.sh,.bash,.sql,.toml,.ini,.conf,.rb,.php,.swift,.kt";

const loadHistory = () => {
  try { const x = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); return Array.isArray(x) ? x : []; }
  catch { return []; }
};
const saveHistory = (h) => { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch {} };
const getToken = () => sessionStorage.getItem(UNLOCK_KEY) || "";
const setToken = (t) => t ? sessionStorage.setItem(UNLOCK_KEY, t) : sessionStorage.removeItem(UNLOCK_KEY);

async function api(path, { method = "GET", body, auth = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth) {
    const t = getToken();
    if (!t) throw new Error("Locked — unlock first");
    headers.Authorization = `Bearer ${t}`;
  }
  const res = await fetch(`${API}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error((data && data.detail) || `HTTP ${res.status}`);
  return data || {};
}

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
      setErr(e.message || "Wrong password");
      inputRef.current?.select();
    }
  };
  return (
    <div className="modal-bg" data-testid="password-modal" onClick={(e)=>{ if(e.target.classList.contains("modal-bg")) onClose(); }}>
      <div className="modal" role="dialog">
        <h2>🔒 Admin password</h2>
        <p>{label || "This action requires the admin password."}</p>
        <input
          ref={inputRef}
          data-testid="password-input"
          type="password"
          value={pw}
          onChange={(e)=>setPw(e.target.value)}
          onKeyDown={(e)=>{ if(e.key==="Enter") submit(); if(e.key==="Escape") onClose(); }}
          placeholder="Password"
          autoComplete="off"
        />
        <div className="err">{err}</div>
        <div className="actions">
          <button className="btn-cancel" type="button" onClick={onClose}>Cancel</button>
          <button className="qbtn" type="button" data-testid="password-submit" onClick={submit}>Unlock</button>
        </div>
      </div>
    </div>
  );
}

function ResultCard({ r }) {
  return (
    <div className="result-card">
      <div className="r-topic">{r.topic || "(untitled)"}</div>
      <div className="r-summary">{r.summary || ""}</div>
      {r.source_url && (
        <a className="r-source" href={r.source_url} target="_blank" rel="noreferrer">🔗 Source</a>
      )}
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
  return (
    <div className="code-wrap">
      <div className="code-lang">{lang}</div>
      <pre className="code-block">{code}</pre>
      <button className={"copy-btn" + (copied ? " copied" : "")} onClick={onCopy} data-testid="copy-code-btn">
        {copied ? "✓ Copied" : "Copy"}
      </button>
    </div>
  );
}

function Bubble({ msg }) {
  if (msg.role === "user") {
    return (
      <div className="msg-row user">
        <div className="bubble user">{msg.content}</div>
        <div className="bubble-avatar user">M</div>
      </div>
    );
  }
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

export default function App() {
  const [mode, setMode] = useState("chat");
  const [lang, setLang] = useState("python");
  const [text, setText] = useState("");
  const [messages, setMessages] = useState([]);
  const [history, setHistory] = useState(loadHistory());
  const [typing, setTyping] = useState(false);
  const [unlocked, setUnlocked] = useState(!!getToken());
  const [pwPrompt, setPwPrompt] = useState(null); // {label, onSuccess}
  const [queue, setQueue] = useState([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [qTopic, setQTopic] = useState("");
  const [qCat, setQCat] = useState("General");
  const [iCategory, setICategory] = useState("Imported");
  const [iTags, setITags] = useState("");
  const [importRows, setImportRows] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const messagesEnd = useRef(null);
  const taRef = useRef(null);

  // Seed greeting from history or default
  useEffect(() => {
    if (messages.length === 0) {
      if (history.length === 0) {
        setMessages([{
          role: "bot",
          content: "Hey! I'm Midget jr. 🧠\n\nUse the tabs above to switch modes:\n• 💬 Chat — talk to me, I answer using AI + my knowledge base\n• 🔍 Query — search raw entries in the knowledge base\n• 🌐 Research — fetch & save new info from Google\n• 💻 Code — generate code in any language\n• 📂 Import — upload files to grow my brain (admin)\n• 📋 Queue — topics scheduled for auto-research every 6 hours"
        }]);
      } else {
        setMessages(history.slice(-6).map(m => ({ role: m.role === "user" ? "user" : "bot", content: m.content })));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, typing]);

  useEffect(() => {
    if (mode === "queue") refreshQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const accent = MODE_COLORS[mode];

  const requirePw = (label) => new Promise((resolve) => {
    if (getToken()) return resolve(true);
    setPwPrompt({
      label,
      onSuccess: () => { setUnlocked(true); setPwPrompt(null); resolve(true); },
      onClose: () => { setPwPrompt(null); resolve(false); },
    });
  });

  const pushBot = (b) => setMessages(m => [...m, { role: "bot", ...b }]);
  const pushUser = (t) => setMessages(m => [...m, { role: "user", content: t }]);

  const send = async () => {
    const t = text.trim();
    if (!t || typing) return;
    setText(""); if (taRef.current) taRef.current.style.height = "auto";
    pushUser(t);
    setTyping(true);
    try {
      if (mode === "chat") {
        const r = await api("/chat", { method: "POST", body: { message: t, history } });
        pushBot({ content: r.reply, ctx: r.context_used });
        const h2 = [...history, { role: "user", content: t }, { role: "assistant", content: r.reply }];
        while (h2.length > 12) h2.splice(0, 2);
        setHistory(h2); saveHistory(h2);
      } else if (mode === "query") {
        const r = await api("/query", { method: "POST", body: { query: t } });
        if (r.results?.length) pushBot({ content: `Found ${r.result_count} result(s):`, results: r.results });
        else pushBot({ content: `🤷 Nothing in the knowledge base about "${t}" yet.\n\nTip: switch to 🌐 Research, or 📂 Import a file.` });
      } else if (mode === "research") {
        const r = await api("/research", { method: "POST", body: { topic: t, category: "General" } });
        pushBot({ content: r.sources_found > 0
          ? `✅ Researched and saved!\n\nTopic: ${r.topic}\nSources: ${r.sources_found}\n\n${r.summary || ""}`
          : `📌 Saved "${t}" — no web sources found, you may want to try a more specific query.` });
      } else if (mode === "code") {
        const r = await api("/code", { method: "POST", body: { prompt: t, language: lang } });
        pushBot({ content: `Here's your ${lang} code:`, code: r.code, lang });
      }
    } catch (e) {
      pushBot({ content: `❌ Error: ${e.message}` });
    }
    setTyping(false);
  };

  const refreshQueue = async () => {
    setQueueLoading(true);
    try {
      const r = await api("/queue");
      const arr = Array.isArray(r) ? r : (r.items || []);
      setQueue(arr.sort((a,b)=> new Date(b.created_at) - new Date(a.created_at)));
    } catch (e) {
      setQueue([]);
    }
    setQueueLoading(false);
  };

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
    try {
      await api(`/queue/${id}`, { method: "DELETE", auth: true });
      refreshQueue();
    } catch (e) { alert("Failed: " + e.message); }
  };

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
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
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
    else { await requirePw("Unlock admin actions (import, queue add/delete)."); }
  };

  const inputBarVisible = ["chat","query","research","code"].includes(mode);

  return (
    <div id="app">
      <div id="header">
        <div className="avatar">🧠</div>
        <div>
          <h1>Midget jr.</h1>
          <p>Self-growing · Research · Chat · Code</p>
        </div>
        <button id="lock-toggle" className={unlocked ? "unlocked" : ""} onClick={toggleLock} data-testid="lock-toggle">
          <span>{unlocked ? "🔓" : "🔒"}</span>
          <span>{unlocked ? "Unlocked" : "Locked"}</span>
        </button>
      </div>

      <div id="tabs">
        {["chat","query","research","code","import","queue"].map(m => (
          <button
            key={m}
            className={"tab" + (mode === m ? ` active-${m}` : "")}
            onClick={()=>setMode(m)}
            data-testid={`tab-${m}`}
          >
            {{chat:"💬 Chat",query:"🔍 Query",research:"🌐 Research",code:"💻 Code",import:"📂 Import",queue:"📋 Queue"}[m]}
          </button>
        ))}
        {mode === "code" && (
          <select id="lang-select" value={lang} onChange={(e)=>setLang(e.target.value)} data-testid="lang-select">
            {LANGS.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        )}
      </div>

      <div id="mode-label">{MODE_LABELS[mode]}</div>

      {!["queue","import"].includes(mode) && (
        <div id="messages" data-testid="messages">
          {messages.map((m, i) => <Bubble key={i} msg={m}/>)}
          {typing && <Typing/>}
          <div ref={messagesEnd}/>
        </div>
      )}

      {mode === "queue" && (
        <div className="side-panel">
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
            <div className="hint">🔒 Adding and deleting items requires the admin password. Queue auto-processes every 6 hours.</div>
          </div>
          <div id="queue-list">
            {queueLoading
              ? <div className="empty-state">Loading queue...</div>
              : queue.length === 0
                ? <div className="empty-state">Queue is empty — add a topic above 👆</div>
                : queue.map(item => (
                    <div key={item.id} className="queue-item">
                      <span className="qi-icon">{ {pending:"⏳", done:"✅", failed:"❌", running:"🔄"}[item.status] || "⏳" }</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="qi-topic">{item.topic}</div>
                        <div className="qi-meta">
                          <span className="qi-tag" style={{ color: "#89b4fa" }}>{item.category || "General"}</span>
                          <span className="qi-tag" style={{ color: {pending:"#f9e2af",done:"#a6e3a1",failed:"#f38ba8",running:"#74c7ec"}[item.status] || "#f9e2af" }}>{item.status}</span>
                          <span className="qi-tag" style={{ color: "#6c7086" }}>{item.added_by === "auto" ? "🤖 auto" : "👤 you"}</span>
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
          <div className="panel-card">
            <h3>📂 Import files into Midget's brain</h3>
            <label
              className={"dropzone" + (dragOver ? " drag" : "")}
              onClick={()=>fileInputRef.current?.click()}
              onDragEnter={(e)=>{ e.preventDefault(); setDragOver(true); }}
              onDragOver={(e)=>{ e.preventDefault(); setDragOver(true); }}
              onDragLeave={(e)=>{ e.preventDefault(); setDragOver(false); }}
              onDrop={(e)=>{ e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
              data-testid="dropzone"
            >
              <div className="big">⬆️</div>
              <div><strong>Drop files here</strong> or click to choose</div>
              <div className="types">.txt .md .json .csv .log .yaml .xml .html .css .js .ts .py .go .rs .java .cpp .c .h .sh .sql</div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPT}
                style={{ display: "none" }}
                onChange={(e)=>{ handleFiles(e.target.files); e.target.value = ""; }}
                data-testid="file-input"
              />
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
                <span>📄</span>
                <span className="name">{row.name}</span>
                <span className={"status " + row.cls}>{row.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {inputBarVisible && (
        <div id="input-bar">
          <div id="input-wrap" style={{ borderColor: accent + "44", boxShadow: `0 0 18px ${accent}11` }}>
            <textarea
              ref={taRef}
              id="chat-input"
              rows={1}
              value={text}
              onChange={(e)=>{
                setText(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 110) + "px";
              }}
              onKeyDown={(e)=>{ if(e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={MODE_PLACEHOLDERS[mode] || ""}
              data-testid="chat-input"
            />
            <button id="send-btn" onClick={send} disabled={typing || !text.trim()} data-testid="send-btn">↑</button>
          </div>
          <div id="input-hint">Enter to send · Shift+Enter for new line</div>
        </div>
      )}

      {pwPrompt && (
        <PasswordModal
          label={pwPrompt.label}
          onClose={pwPrompt.onClose}
          onUnlock={pwPrompt.onSuccess}
        />
      )}
    </div>
  );
}
