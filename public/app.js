const $ = (id) => document.getElementById(id);

const state = { conversationId: null, controller: null };

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error('login required');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

const time = (ms) => new Date(ms).toLocaleString();

// --- Markdown (small and safe: everything is escaped first) ---------------------------------

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderMarkdown(text) {
  const parts = text.split(/```/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        const body = part.replace(/^[\w+-]*\n/, '');
        return `<pre dir="ltr"><code>${escapeHtml(body)}</code></pre>`;
      }
      return escapeHtml(part)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/^#{1,6} (.+)$/gm, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');
    })
    .join('');
}

// --- Auth ----------------------------------------------------------------------------------

function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
  $('password').focus();
}

async function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
  await Promise.all([loadConversations(), loadModelPicker()]);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').hidden = true;
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
    $('password').value = '';
    await showApp();
  } catch (err) {
    $('login-error').textContent = err.message;
    $('login-error').hidden = false;
  }
});

$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// --- Navigation ----------------------------------------------------------------------------

const views = { chat: null, models: loadModels, memory: loadMemories, activity: loadActivity };

function showView(name) {
  for (const v of Object.keys(views)) $(`view-${v}`).hidden = v !== name;
  for (const b of document.querySelectorAll('.tabs button')) {
    b.classList.toggle('active', b.dataset.view === name);
  }
  $('conversations').hidden = name !== 'chat';
  $('sidebar').classList.remove('open');
  const titles = { models: 'الموديلات', memory: 'الذاكرة', activity: 'النشاط' };
  if (titles[name]) $('title').textContent = titles[name];
  views[name]?.();
}

for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => showView(b.dataset.view));
}
$('menu').addEventListener('click', () => $('sidebar').classList.toggle('open'));

// --- Conversations -------------------------------------------------------------------------

async function loadConversations() {
  const list = await api('/api/conversations');
  $('conversations').replaceChildren(
    ...list.map((c) =>
      el('li', { class: c.id === state.conversationId ? 'active' : '' },
        el('button', { class: 'conv', dir: 'auto', onclick: () => openConversation(c.id, c.title) }, c.title),
        el('button', {
          class: 'icon danger', 'aria-label': 'حذف', onclick: async () => {
            if (!confirm('تحذف المحادثة دي؟')) return;
            await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
            if (state.conversationId === c.id) newChat();
            loadConversations();
          },
        }, '×'),
      ),
    ),
  );
}

function newChat() {
  state.conversationId = null;
  $('title').textContent = 'محادثة جديدة';
  $('messages').replaceChildren($('empty'));
  $('empty').hidden = false;
  showView('chat');
  $('input').focus();
}
$('new-chat').addEventListener('click', newChat);

async function openConversation(id, title) {
  state.conversationId = id;
  $('title').textContent = title;
  showView('chat');
  const messages = await api(`/api/conversations/${id}`);
  $('empty').hidden = true;
  $('messages').replaceChildren($('empty'), ...messages.map((m) => messageNode(m)));
  scrollDown();
  loadConversations();
}

function feedbackButtons(m) {
  if (m.role !== 'assistant' || !m.id) return null;
  const vote = async (value, btn) => {
    await api(`/api/messages/${m.id}/feedback`, { method: 'POST', body: JSON.stringify({ value }) });
    for (const b of btn.parentElement.querySelectorAll('.vote')) b.classList.remove('on');
    btn.classList.add('on');
  };
  return el('span', { class: 'actions' },
    el('button', { class: `icon vote ${m.feedback === 1 ? 'on' : ''}`, onclick: (e) => vote(1, e.currentTarget) }, '👍'),
    el('button', { class: `icon vote ${m.feedback === -1 ? 'on' : ''}`, onclick: (e) => vote(-1, e.currentTarget) }, '👎'),
    el('button', { class: 'icon', onclick: () => navigator.clipboard.writeText(m.content) }, 'نسخ'),
  );
}

function messageNode(m) {
  const body = el('div', { class: 'body', dir: 'auto' });
  body.innerHTML = renderMarkdown(m.content || '');
  const meta = el('div', { class: 'meta' }, m.model_name || '', feedbackButtons(m));
  return el('div', { class: `msg ${m.role}` }, body, m.role === 'assistant' ? meta : null);
}

const scrollDown = () => ($('messages').scrollTop = $('messages').scrollHeight);

// --- Sending -------------------------------------------------------------------------------

async function loadModelPicker() {
  const models = await api('/api/models');
  const active = models.filter((m) => m.status === 'active');
  $('model-pick').replaceChildren(
    el('option', { value: 'auto' }, 'تلقائي'),
    ...active.map((m) => el('option', { value: m.id }, `${m.name} · ${m.provider}`)),
  );
}

$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});
$('input').addEventListener('input', () => {
  $('input').style.height = 'auto';
  $('input').style.height = `${Math.min($('input').scrollHeight, 200)}px`;
});

$('stop').addEventListener('click', () => state.controller?.abort());

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text || state.controller) return;
  $('input').value = '';
  $('input').style.height = 'auto';
  $('empty').hidden = true;
  $('messages').append(messageNode({ role: 'user', content: text }));

  const answer = { role: 'assistant', content: '', model_name: '…' };
  let node = messageNode(answer);
  $('messages').append(node);
  const render = () => {
    const fresh = messageNode(answer);
    node.replaceWith(fresh);
    node = fresh;
    scrollDown();
  };
  scrollDown();

  state.controller = new AbortController();
  $('send').hidden = true;
  $('stop').hidden = false;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: state.conversationId, message: text, model: $('model-pick').value }),
      signal: state.controller.signal,
    });
    if (res.status === 401) return showLogin();
    if (!res.ok) throw new Error(await res.text());
    await readEvents(res.body, (event, data) => {
      if (event === 'conversation') {
        const isNew = !state.conversationId;
        state.conversationId = data.id;
        if (isNew) {
          $('title').textContent = text.slice(0, 60);
          loadConversations();
        }
      } else if (event === 'model') {
        answer.model_name = data.fallback ? `${data.name} (بديل)` : data.name;
        answer.content = '';
      } else if (event === 'token') {
        answer.content += data.t;
      } else if (event === 'done') {
        answer.id = data.messageId;
      } else if (event === 'error') {
        answer.content += `\n\n⚠️ ${data.message}`;
      }
      render();
    });
  } catch (err) {
    if (err.name !== 'AbortError') {
      answer.content += `\n\n⚠️ ${err.message}`;
      render();
    }
  } finally {
    state.controller = null;
    $('send').hidden = false;
    $('stop').hidden = true;
  }
});

async function readEvents(stream, onEvent) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += value;
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop();
    for (const block of blocks) {
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (event && data) onEvent(event, JSON.parse(data));
    }
  }
}

// --- Models --------------------------------------------------------------------------------

const STATUS = { active: 'شغال', candidate: 'بيتجرّب', failed: 'فشل', paid: 'مدفوع', removed: 'اتشال', disabled: 'موقوف' };

async function loadModels() {
  const [models, providers] = await Promise.all([api('/api/models'), api('/api/providers')]);
  $('scan-buttons').replaceChildren(
    ...providers.map((p) =>
      el('button', {
        disabled: !p.configured,
        title: p.configured ? '' : 'مفيش API key',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          $('scan-result').textContent = `بيعمل scan على ${p.label}…`;
          try {
            const r = await api(`/api/discovery/${p.id}`, { method: 'POST' });
            $('scan-result').textContent = r.error
              ? `${p.label}: ${r.error}`
              : `${p.label}: ${r.found} مجاني · اتضاف ${r.added.length} · فشل ${r.failed.length} · مدفوع ${r.paid.length} · اتشال ${r.removed.length}`;
          } catch (err) {
            $('scan-result').textContent = err.message;
          }
          btn.disabled = false;
          loadModels();
          loadModelPicker();
        },
      }, `Scan ${p.label}`),
    ),
  );
  const now = Date.now();
  $('models-table').replaceChildren(
    el('tr', {}, ...['الموديل', 'المزود', 'الحالة', 'عربي', 'الجودة', 'نجاح/فشل', 'السرعة', 'آخر تأكيد', ''].map((h) => el('th', {}, h))),
    ...models.map((m) =>
      el('tr', { class: m.status },
        el('td', { dir: 'ltr', title: m.free_evidence || '' }, m.name),
        el('td', {}, m.provider),
        el('td', { title: m.last_error || '' },
          m.cooldown_until > now ? `راحة لحد ${new Date(m.cooldown_until).toLocaleTimeString()}` : STATUS[m.status] || m.status),
        el('td', {}, m.arabic_ok == null ? '—' : m.arabic_ok ? '✓' : '✗'),
        el('td', {}, String(m.quality)),
        el('td', {}, `${m.ok_count}/${m.fail_count}`),
        el('td', {}, m.latency_ms ? `${(m.latency_ms / 1000).toFixed(1)}s` : '—'),
        el('td', {}, m.verified_at ? time(m.verified_at) : '—'),
        el('td', {},
          el('button', {
            class: 'small',
            onclick: async () => {
              const status = m.status === 'disabled' ? 'enabled' : 'disabled';
              await api(`/api/models/${encodeURIComponent(m.id)}`, { method: 'PATCH', body: JSON.stringify({ status }) });
              loadModels();
              loadModelPicker();
            },
          }, m.status === 'disabled' ? 'تشغيل' : 'إيقاف'),
        ),
      ),
    ),
  );
}

// --- Memory --------------------------------------------------------------------------------

async function loadMemories() {
  const items = await api('/api/memories');
  $('memory-list').replaceChildren(
    ...items.map((m) =>
      el('li', {},
        el('span', { dir: 'auto' }, m.pinned ? `📌 ${m.content}` : m.content),
        el('button', {
          class: 'icon danger', 'aria-label': 'حذف', onclick: async () => {
            await api(`/api/memories/${m.id}`, { method: 'DELETE' });
            loadMemories();
          },
        }, '×'),
      ),
    ),
  );
}

$('memory-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/memories', {
    method: 'POST',
    body: JSON.stringify({ content: $('memory-input').value, pinned: $('memory-pinned').checked }),
  });
  $('memory-input').value = '';
  $('memory-pinned').checked = false;
  loadMemories();
});

// --- Activity ------------------------------------------------------------------------------

async function loadActivity() {
  const [usage, events] = await Promise.all([api('/api/usage'), api('/api/events')]);
  $('usage-table').replaceChildren(
    el('tr', {}, ...['اليوم', 'الموديل', 'طلبات', 'كبديل', 'فشل', 'توكنز (تقريبي)'].map((h) => el('th', {}, h))),
    ...usage.map((u) =>
      el('tr', {},
        el('td', {}, u.day), el('td', { dir: 'ltr' }, u.name || u.model_id),
        el('td', {}, String(u.requests)), el('td', {}, String(u.fallbacks)),
        el('td', {}, String(u.failures)), el('td', {}, String(u.tokens_est)),
      ),
    ),
  );
  $('events').replaceChildren(
    ...events.map((ev) =>
      el('li', { class: `event ${ev.kind}` },
        el('span', { class: 'muted' }, time(ev.at)), ' ',
        el('strong', {}, ev.kind), ' ',
        el('span', { dir: 'ltr' }, [ev.model_id, ev.detail].filter(Boolean).join(' — ')),
      ),
    ),
  );
}

// --- Boot ----------------------------------------------------------------------------------

api('/api/me').then(showApp).catch(() => showLogin());
