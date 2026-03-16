export function renderHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Claude Session Share</title>
  <style>
    :root {
      --bg: #0f1419;
      --panel: #182028;
      --panel-2: #1e2a35;
      --text: #edf3f8;
      --muted: #95a7b8;
      --accent: #4fd1c5;
      --danger: #ff7a7a;
      --user: #2b6cb0;
      --assistant: #22543d;
      --thinking: #744210;
      --tool: #553c9a;
      --tool-result: #7b341e;
      --queue: #2d3748;
      --border: rgba(255,255,255,0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      background: radial-gradient(circle at top, #13202d 0%, var(--bg) 55%);
      color: var(--text);
    }
    .shell {
      max-width: 1100px;
      margin: 0 auto;
      padding: 24px;
      min-height: 100vh;
    }
    .topbar {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 16px;
      align-items: center;
      margin-bottom: 18px;
    }
    .title { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
    .meta, .status {
      padding: 14px 16px;
      background: rgba(24, 32, 40, 0.82);
      border: 1px solid var(--border);
      border-radius: 14px;
      backdrop-filter: blur(10px);
    }
    .meta { margin-bottom: 16px; display: grid; gap: 8px; }
    .meta-row { color: var(--muted); word-break: break-all; }
    .meta-row strong { color: var(--text); }
    .status { color: var(--muted); margin-bottom: 16px; }
    .history {
      display: grid;
      gap: 12px;
      margin-bottom: 18px;
    }
    .entry {
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
      background: rgba(24, 32, 40, 0.88);
    }
    .entry-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      font-size: 12px;
      color: var(--muted);
    }
    .entry-kind {
      padding: 2px 8px;
      border-radius: 999px;
      color: white;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 11px;
    }
    .entry-body {
      padding: 14px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.45;
    }
    .kind-user { background: var(--user); }
    .kind-assistant { background: var(--assistant); }
    .kind-thinking { background: var(--thinking); }
    .kind-tool_use { background: var(--tool); }
    .kind-tool_result { background: var(--tool-result); }
    .kind-summary { background: #0f766e; }
    .kind-system, .kind-queue { background: var(--queue); }
    .kind-error { background: var(--danger); }
    form {
      display: grid;
      gap: 12px;
      background: rgba(24, 32, 40, 0.92);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 16px;
      position: sticky;
      bottom: 18px;
    }
    textarea {
      min-height: 120px;
      resize: vertical;
      width: 100%;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(9, 13, 17, 0.88);
      color: var(--text);
      padding: 14px;
      font: inherit;
    }
    .actions { display: flex; gap: 12px; align-items: center; }
    button {
      border: 0;
      border-radius: 12px;
      padding: 12px 18px;
      background: var(--accent);
      color: #06201f;
      font-weight: 800;
      font: inherit;
      cursor: pointer;
    }
    button[disabled] { opacity: 0.55; cursor: not-allowed; }
    .hint { color: var(--muted); font-size: 13px; }
    .hidden { display: none; }
    @media (max-width: 720px) {
      .shell { padding: 16px; }
      .topbar { grid-template-columns: 1fr; }
    }
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

    function setStatus(text) {
      statusEl.textContent = text;
    }

    function setBusy(nextBusy) {
      busy = nextBusy;
      buttonEl.disabled = busy;
      inputEl.disabled = busy;
      formHintEl.textContent = busy
        ? 'Claude is processing the current message...'
        : 'Messages are appended to the live Claude session.';
    }

    function renderMeta(session, shareUrl) {
      metaEl.innerHTML = '';
      const rows = [
        ['Session', session.sessionId],
        ['Project', session.projectId],
        ['CWD', session.cwd || '(unknown)'],
        ['File', session.filePath],
        ['Updated', session.updatedAt || '(unknown)']
      ];
      for (const [label, value] of rows) {
        const div = document.createElement('div');
        div.className = 'meta-row';
        div.innerHTML = '<strong>' + label + ':</strong> ' + escapeHtml(String(value));
        metaEl.appendChild(div);
      }
      shareUrlEl.textContent = shareUrl;
    }

    function escapeHtml(text) {
      return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    }

    function renderEntry(entry) {
      const wrapper = document.createElement('div');
      wrapper.className = 'entry';
      const ts = entry.timestamp || '(no timestamp)';
      wrapper.innerHTML =
        '<div class=\"entry-header\">' +
        '<span class=\"entry-kind kind-' + escapeHtml(entry.kind) + '\">' + escapeHtml(entry.kind) + '</span>' +
        '<span>' + escapeHtml(ts) + '</span>' +
        '</div>' +
        '<div class=\"entry-body\">' + escapeHtml(entry.text || '') + '</div>';
      historyEl.appendChild(wrapper);
    }

    function replaceHistory(entries) {
      historyEl.innerHTML = '';
      entries.forEach(renderEntry);
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }

    async function loadBootstrap() {
      const response = await fetch('/api/share/' + token + '/history');
      if (!response.ok) {
        throw new Error(await response.text());
      }
      return response.json();
    }

    async function sendMessage(event) {
      event.preventDefault();
      const message = inputEl.value.trim();
      if (!message || busy) return;
      setBusy(true);
      setStatus('Sending message to Claude...');
      const response = await fetch('/api/share/' + token + '/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message })
      });
      if (!response.ok) {
        const text = await response.text();
        setBusy(false);
        setStatus(text || 'Failed to send message.');
        return;
      }
      inputEl.value = '';
      setStatus('Message accepted. Waiting for Claude...');
    }

    function connectSocket() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(protocol + '//' + location.host + '/ws/' + token);
      ws.addEventListener('message', (event) => {
        const payload = JSON.parse(event.data);
        switch (payload.type) {
          case 'bootstrap':
            renderMeta(payload.session, payload.shareUrl);
            replaceHistory(payload.session.entries);
            setBusy(payload.busy);
            setStatus(payload.allowInput ? 'Connected.' : 'Read-only session.');
            formEl.classList.toggle('hidden', !payload.allowInput);
            break;
          case 'append':
            payload.entries.forEach(renderEntry);
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
            break;
          case 'reload':
            replaceHistory(payload.session.entries);
            setBusy(payload.busy);
            setStatus('History refreshed.');
            break;
          case 'status':
            setBusy(payload.busy);
            setStatus(payload.message);
            break;
          case 'error':
            setBusy(false);
            setStatus(payload.message);
            break;
        }
      });
      ws.addEventListener('close', () => {
        setStatus('Connection lost. Retrying...');
        setTimeout(connectSocket, 1000);
      });
    }

    formEl.addEventListener('submit', (event) => {
      void sendMessage(event);
    });

    loadBootstrap()
      .then((payload) => {
        renderMeta(payload.session, payload.shareUrl);
        replaceHistory(payload.session.entries);
        setBusy(payload.busy);
        setStatus(payload.allowInput ? 'Connected.' : 'Read-only session.');
        formEl.classList.toggle('hidden', !payload.allowInput);
      })
      .catch((error) => {
        setStatus(error.message || String(error));
      })
      .finally(() => {
        connectSocket();
      });
  </script>
</body>
</html>`;
}
