package main

const htmlPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Claude Session Share</title>
  <style>
    :root {
      --bg: #0f1419; --panel: #182028; --text: #edf3f8; --muted: #95a7b8;
      --accent: #4fd1c5; --danger: #ff7a7a;
      --user: #2b6cb0; --assistant: #22543d; --thinking: #744210;
      --tool: #553c9a; --tool-result: #7b341e; --queue: #2d3748;
      --border: rgba(255,255,255,0.08);
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; background: radial-gradient(circle at top, #13202d 0%, var(--bg) 55%); color: var(--text); }
    .shell { max-width: 1100px; margin: 0 auto; padding: 24px; min-height: 100vh; }
    .topbar { display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: center; margin-bottom: 18px; }
    .title { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
    .meta, .status { padding: 14px 16px; background: rgba(24,32,40,0.82); border: 1px solid var(--border); border-radius: 14px; backdrop-filter: blur(10px); }
    .meta { margin-bottom: 16px; display: grid; gap: 8px; }
    .meta-row { color: var(--muted); word-break: break-all; }
    .meta-row strong { color: var(--text); }
    .status { color: var(--muted); margin-bottom: 16px; }
    .history { display: grid; gap: 12px; margin-bottom: 18px; }
    .entry { border: 1px solid var(--border); border-radius: 14px; overflow: hidden; background: rgba(24,32,40,0.88); }
    .entry-header { display: flex; justify-content: space-between; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--muted); }
    .entry-kind { padding: 2px 8px; border-radius: 999px; color: white; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; font-size: 11px; }
    .entry-body { padding: 14px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.45; }
    .kind-user{background:var(--user)} .kind-assistant{background:var(--assistant)} .kind-thinking{background:var(--thinking)}
    .kind-tool_use{background:var(--tool)} .kind-tool_result{background:var(--tool-result)} .kind-summary{background:#0f766e}
    .kind-system,.kind-queue{background:var(--queue)} .kind-error{background:var(--danger)}
    form { display: grid; gap: 12px; background: rgba(24,32,40,0.92); border: 1px solid var(--border); border-radius: 16px; padding: 16px; position: sticky; bottom: 18px; }
    textarea { min-height: 120px; resize: vertical; width: 100%; border-radius: 12px; border: 1px solid rgba(255,255,255,0.12); background: rgba(9,13,17,0.88); color: var(--text); padding: 14px; font: inherit; }
    .actions { display: flex; gap: 12px; align-items: center; }
    button { border: 0; border-radius: 12px; padding: 12px 18px; background: var(--accent); color: #06201f; font-weight: 800; font: inherit; cursor: pointer; }
    button[disabled] { opacity: 0.55; cursor: not-allowed; }
    .hint { color: var(--muted); font-size: 13px; }
    .hidden { display: none; }
    @media (max-width: 720px) { .shell { padding: 16px; } .topbar { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="shell">
    <div class="topbar">
      <div class="title">Claude Session Share</div>
      <div id="share-url" class="status">Loading share link...</div>
    </div>
    <div id="meta" class="meta"></div>
    <div id="status" class="status">Connecting...</div>
    <div id="history" class="history"></div>
    <form id="message-form" class="hidden">
      <textarea id="message-input" placeholder="Continue this Claude session..."></textarea>
      <div class="actions">
        <button id="send-button" type="submit">Send To Claude</button>
        <div class="hint" id="form-hint">Messages are appended to the live Claude session.</div>
      </div>
    </form>
  </div>
  <script>
    const token = location.pathname.split('/').filter(Boolean).pop();
    const historyEl = document.getElementById('history');
    const statusEl = document.getElementById('status');
    const metaEl = document.getElementById('meta');
    const shareUrlEl = document.getElementById('share-url');
    const formEl = document.getElementById('message-form');
    const inputEl = document.getElementById('message-input');
    const buttonEl = document.getElementById('send-button');
    const formHintEl = document.getElementById('form-hint');
    let busy = false;

    function setStatus(text) { statusEl.textContent = text; }
    function setBusy(b) {
      busy = b; buttonEl.disabled = b; inputEl.disabled = b;
      formHintEl.textContent = b ? 'Claude is processing...' : 'Messages are appended to the live Claude session.';
    }
    function escapeHtml(t) { return t.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'); }
    function renderMeta(session, shareUrl) {
      metaEl.innerHTML = '';
      [['Session',session.sessionId],['Project',session.projectId],['CWD',session.cwd||'(unknown)'],['File',session.filePath],['Updated',session.updatedAt||'(unknown)']].forEach(([k,v])=>{
        const d = document.createElement('div'); d.className='meta-row';
        d.innerHTML = '<strong>'+k+':</strong> '+escapeHtml(String(v)); metaEl.appendChild(d);
      });
      shareUrlEl.textContent = shareUrl;
    }
    function renderEntry(entry) {
      const w = document.createElement('div'); w.className='entry';
      const ts = entry.timestamp||'(no timestamp)';
      w.innerHTML = '<div class="entry-header"><span class="entry-kind kind-'+escapeHtml(entry.kind)+'">'+escapeHtml(entry.kind)+'</span><span>'+escapeHtml(ts)+'</span></div><div class="entry-body">'+escapeHtml(entry.text||'')+'</div>';
      historyEl.appendChild(w);
    }
    function replaceHistory(entries) { historyEl.innerHTML=''; entries.forEach(renderEntry); window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'}); }

    async function sendMessage(e) {
      e.preventDefault();
      const msg = inputEl.value.trim();
      if (!msg || busy) return;
      setBusy(true); setStatus('Sending message to Claude...');
      const r = await fetch('/api/share/'+token+'/message',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:msg})});
      if (!r.ok) { setBusy(false); setStatus(await r.text()||'Failed.'); return; }
      inputEl.value=''; setStatus('Message accepted. Waiting for Claude...');
    }

    function connectSocket() {
      const proto = location.protocol==='https:'?'wss:':'ws:';
      const ws = new WebSocket(proto+'//'+location.host+'/ws/'+token);
      ws.addEventListener('message',(e)=>{
        const p = JSON.parse(e.data);
        if (p.type==='bootstrap') { renderMeta(p.session,p.shareUrl); replaceHistory(p.session.entries); setBusy(p.busy); setStatus(p.allowInput?'Connected.':'Read-only session.'); formEl.classList.toggle('hidden',!p.allowInput); }
        else if (p.type==='append') { p.entries.forEach(renderEntry); window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'}); }
        else if (p.type==='reload') { replaceHistory(p.session.entries); setBusy(p.busy); setStatus('History refreshed.'); }
        else if (p.type==='status') { setBusy(p.busy); setStatus(p.message); }
        else if (p.type==='error') { setBusy(false); setStatus(p.message); }
      });
      ws.addEventListener('close',()=>{ setStatus('Connection lost. Retrying...'); setTimeout(connectSocket,1000); });
    }

    formEl.addEventListener('submit',e=>sendMessage(e));
    fetch('/api/share/'+token+'/history').then(r=>r.json()).then(p=>{
      renderMeta(p.session,p.shareUrl); replaceHistory(p.session.entries); setBusy(p.busy);
      setStatus(p.allowInput?'Connected.':'Read-only session.'); formEl.classList.toggle('hidden',!p.allowInput);
    }).catch(e=>setStatus(e.message||String(e))).finally(()=>connectSocket());
  </script>
</body>
</html>`
