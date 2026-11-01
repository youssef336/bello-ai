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
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

const ICONS = {
  up: '<path d="M7 10v11H4V10zM7 10l4-8a3 3 0 0 1 3 3v4h5.5a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18 21H7"/>',
  down: '<path d="M17 14V3h3v11zM17 14l-4 8a3 3 0 0 1-3-3v-4H4.5a2 2 0 0 1-2-2.3l1.4-8A2 2 0 0 1 6 3h11"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  pin: '<path d="M12 17v5M5 17h14l-2-4V5H7v8z"/>',
};
const icon = (name) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.innerHTML = ICONS[name];
  return s;
};

const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'دلوقتي';
  if (s < 3600) return `من ${Math.round(s / 60)} د`;
  if (s < 86400) return `من ${Math.round(s / 3600)} س`;
  return new Date(ms).toLocaleDateString();
};

// --- Markdown (escape first, then a small safe subset) -------------------------------------

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const inline = (s) =>
  s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

function renderBlocks(text) {
  const out = [];
  let list = null;
  const flush = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.join('<br>')}</p>`);
    para = [];
  };
  for (const raw of escapeHtml(text).split('\n')) {
    const line = raw.trimEnd();
    const ul = /^\s*[-*•] (.+)$/.exec(line);
    const ol = /^\s*\d+[.)] (.+)$/.exec(line);
    const h = /^#{1,6} (.+)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) {
        flush();
        list = { tag, items: [] };
      }
      list.items.push(inline((ul || ol)[1]));
    } else if (h) {
      flushPara();
      flush();
      out.push(`<h4>${inline(h[1])}</h4>`);
    } else if (!line.trim()) {
      flushPara();
      flush();
    } else {
      flush();
      para.push(inline(line));
    }
  }
  flushPara();
  flush();
  return out.join('');
}

function renderMarkdown(text) {
  return text
    .split(/```/)
    .map((part, i) => {
      if (i % 2 === 0) return renderBlocks(part);
      const lang = /^[\w+-]*/.exec(part)[0];
      const body = part.slice(lang.length).replace(/^\n/, '');
      return `<pre><span class="lang">${escapeHtml(lang || 'code')}</span><button class="copy-code">نسخ</button><code>${escapeHtml(body)}</code></pre>`;
    })
    .join('');
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-code');
  if (!btn) return;
  navigator.clipboard.writeText(btn.parentElement.querySelector('code').textContent);
  btn.textContent = 'اتنسخ ✓';
  setTimeout(() => (btn.textContent = 'نسخ'), 1500);
});

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
  $('input').focus();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').hidden = true;
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
    $('password').value = '';
    await showApp();
  } catch (err) {
    $('login-error').textContent = err.message === 'Wrong password' ? 'كلمة السر غلط' : err.message;
    $('login-error').hidden = false;
  }
});

$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// --- Navigation ----------------------------------------------------------------------------

const views = { chat: null, models: loadModels, memory: loadMemories, activity: loadActivity };
const TITLES = { models: 'الموديلات', memory: 'الذاكرة', activity: 'النشاط' };

function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('scrim').classList.remove('show');
}

function showView(name) {
  for (const v of Object.keys(views)) $(`view-${v}`).hidden = v !== name;
  for (const b of document.querySelectorAll('.nav button')) b.classList.toggle('active', b.dataset.view === name);
  $('conversations').hidden = name !== 'chat';
  $('history-label').hidden = name !== 'chat';
  closeSidebar();
  if (TITLES[name]) $('title').textContent = TITLES[name];
  views[name]?.();
}

for (const b of document.querySelectorAll('.nav button')) b.addEventListener('click', () => showView(b.dataset.view));
$('menu').addEventListener('click', () => {
  $('sidebar').classList.add('open');
  $('scrim').classList.add('show');
});
$('scrim').addEventListener('click', closeSidebar);

// --- Conversations -------------------------------------------------------------------------

async function loadConversations() {
  const list = await api('/api/conversations');
  $('conversations').replaceChildren(
    ...list.map((c) =>
      el('li', { class: c.id === state.conversationId ? 'active' : '' },
        el('button', { class: 'conv', dir: 'auto', title: c.title, onclick: () => openConversation(c.id, c.title) }, c.title),
        el('button', {
          class: 'icon-btn del', 'aria-label': 'حذف', onclick: async () => {
            if (!confirm('تحذف المحادثة دي؟')) return;
            await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
            if (state.conversationId === c.id) newChat();
            loadConversations();
          },
        }, icon('trash')),
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
  loadConversations();
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
  scrollDown(true);
  loadConversations();
}

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    $('input').value = chip.dataset.prompt.replace(/\\n/g, '\n');
    autosize();
    $('input').focus();
  });
}

function messageActions(m) {
  if (!m.id) return [];
  const vote = async (value, btn) => {
    await api(`/api/messages/${m.id}/feedback`, { method: 'POST', body: JSON.stringify({ value }) });
    m.feedback = value;
    for (const b of btn.parentElement.querySelectorAll('.vote')) b.classList.remove('on');
    btn.classList.add('on');
  };
  const copyBtn = el('button', {
    class: 'icon-btn', title: 'نسخ', onclick: () => {
      navigator.clipboard.writeText(m.content);
      copyBtn.replaceChildren(icon('check'));
      setTimeout(() => copyBtn.replaceChildren(icon('copy')), 1500);
    },
  }, icon('copy'));
  return [
    copyBtn,
    el('button', { class: `icon-btn vote ${m.feedback === 1 ? 'on' : ''}`, title: 'رد حلو', onclick: (e) => vote(1, e.currentTarget) }, icon('up')),
    el('button', { class: `icon-btn vote ${m.feedback === -1 ? 'on' : ''}`, title: 'رد وحش', onclick: (e) => vote(-1, e.currentTarget) }, icon('down')),
  ];
}

function messageNode(m) {
  if (m.role === 'user') {
    return el('div', { class: 'msg user' }, el('div', { class: 'bubble', dir: 'auto' }, el('div', { class: 'body' }, m.content)));
  }
  const body = m.content
    ? el('div', { class: 'body', dir: 'auto', html: renderMarkdown(m.content) })
    : el('div', { class: 'typing' }, el('i'), el('i'), el('i'));
  const meta = el('div', { class: 'meta' },
    m.model_name ? el('span', { class: `model-tag ${m.fallback ? 'fallback' : ''}`, title: m.fallback ? 'بديل بعد ما الأول وقع' : '' }, m.model_name) : null,
    ...messageActions(m),
  );
  return el('div', { class: 'msg assistant' },
    el('img', { src: '/icon.svg', alt: '', class: 'avatar' }),
    el('div', { class: 'bubble' }, body, meta),
  );
}

function scrollDown(force = false) {
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}

// --- Sending -------------------------------------------------------------------------------

async function loadModelPicker() {
  const models = await api('/api/models');
  const active = models.filter((m) => m.status === 'active');
  const resting = active.filter((m) => m.cooldown_until > Date.now()).length;
  $('model-pick').replaceChildren(
    el('option', { value: 'auto' }, 'تلقائي'),
    ...active.map((m) => el('option', { value: m.id }, m.name)),
  );
  const pill = $('status-pill');
  pill.className = `pill ${active.length - resting > 0 ? 'ok' : 'warn'}`;
  $('status-text').textContent = active.length
    ? `${active.length - resting} موديل جاهز`
    : 'مفيش موديلات لسه';
}

function autosize() {
  const t = $('input');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 220)}px`;
}
$('input').addEventListener('input', autosize);
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

$('stop').addEventListener('click', () => state.controller?.abort());

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text || state.controller) return;
  $('input').value = '';
  autosize();
  $('empty').hidden = true;
  $('messages').append(messageNode({ role: 'user', content: text }));

  const answer = { role: 'assistant', content: '', model_name: '' };
  let node = messageNode(answer);
  $('messages').append(node);
  scrollDown(true);
  const render = () => {
    const fresh = messageNode(answer);
    node.replaceWith(fresh);
    node = fresh;
    scrollDown();
  };

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
    let pending = false;
    await readEvents(res.body, (event, data) => {
      if (event === 'conversation') {
        const isNew = !state.conversationId;
        state.conversationId = data.id;
        if (isNew) {
          $('title').textContent = text.slice(0, 60);
          loadConversations();
        }
      } else if (event === 'model') {
        answer.model_name = data.name;
        answer.fallback = data.fallback;
        answer.content = '';
      } else if (event === 'token') {
        answer.content += data.t;
      } else if (event === 'done') {
        answer.id = data.messageId;
      } else if (event === 'error') {
        answer.content += `${answer.content ? '\n\n' : ''}⚠️ ${data.message}`;
      }
      // Batch token renders to one per frame.
      if (event === 'token') {
        if (!pending) {
          pending = true;
          requestAnimationFrame(() => {
            pending = false;
            render();
          });
        }
      } else {
        render();
      }
    });
    render();
  } catch (err) {
    if (err.name !== 'AbortError') {
      answer.content += `\n\n⚠️ ${err.message}`;
      render();
    }
  } finally {
    state.controller = null;
    $('send').hidden = false;
    $('stop').hidden = true;
    loadModelPicker();
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

const STATUS = {
  active: ['شغال', 'ok'], candidate: ['بيتجرّب', 'warn'], failed: ['فشل', 'bad'],
  paid: ['مدفوع', 'bad'], removed: ['اتشال', 'bad'], disabled: ['موقوف', ''],
};

function toast(text) {
  $('scan-result').textContent = text;
  $('scan-result').hidden = !text;
}

async function loadModels() {
  const [models, providers] = await Promise.all([api('/api/models'), api('/api/providers')]);
  const now = Date.now();
  $('scan-buttons').replaceChildren(
    ...providers.map((p) =>
      el('button', {
        class: 'btn-ghost',
        disabled: !p.configured,
        title: p.configured ? `دوّر على موديلات جديدة في ${p.label}` : 'مفيش API key',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          toast(`بيدوّر في ${p.label}…`);
          try {
            const r = await api(`/api/discovery/${p.id}`, { method: 'POST' });
            toast(r.error
              ? `${p.label}: ${r.error}`
              : `${p.label}: ${r.found} مجاني · اتضاف ${r.added.length} · فشل ${r.failed.length} · مدفوع ${r.paid.length} · اتشال ${r.removed.length}`);
          } catch (err) {
            toast(err.message);
          }
          btn.disabled = false;
          loadModels();
          loadModelPicker();
        },
      }, `Scan ${p.label}`),
    ),
  );

  const active = models.filter((m) => m.status === 'active');
  const arabic = active.filter((m) => m.arabic_ok === 1).length;
  const resting = active.filter((m) => m.cooldown_until > now).length;
  const stat = (n, label) => el('div', { class: 'stat glass' }, el('b', {}, String(n)), el('span', {}, label));
  $('stats').replaceChildren(
    stat(active.length, 'شغالين'),
    stat(arabic, 'بيفهموا عربي'),
    stat(resting, 'بيستريحوا'),
    stat(providers.filter((p) => p.configured).length, 'مزوّدين'),
  );

  if (!models.length) {
    $('models-grid').replaceChildren(el('div', { class: 'empty-note' }, 'لسه مفيش موديلات. اضغط Scan على أي مزوّد.'));
    return;
  }
  $('models-grid').replaceChildren(
    ...models.map((m) => {
      const [label, tone] = m.cooldown_until > now ? ['بيستريح', 'warn'] : STATUS[m.status] || [m.status, ''];
      const runs = m.ok_count + m.fail_count;
      return el('div', { class: `model-card glass ${m.status === 'active' ? '' : 'off'}` },
        el('div', { class: 'head' },
          el('div', {},
            el('div', { class: 'name', title: m.free_evidence || '' }, m.name),
            el('div', { class: 'provider' }, m.provider),
          ),
          el('span', { class: `badge ${tone}`, title: m.last_error || '' }, label),
        ),
        el('div', { class: 'badges' },
          m.arabic_ok === 1 ? el('span', { class: 'badge ok' }, 'عربي ✓') : m.arabic_ok === 0 ? el('span', { class: 'badge bad' }, 'عربي ✗') : null,
          m.latency_ms ? el('span', { class: 'badge' }, `${(m.latency_ms / 1000).toFixed(1)}s`) : null,
          m.context_length ? el('span', { class: 'badge' }, `${Math.round(m.context_length / 1000)}k`) : null,
          m.supports_vision ? el('span', { class: 'badge' }, 'صور') : null,
          runs ? el('span', { class: 'badge' }, `${Math.round((m.ok_count / runs) * 100)}% نجاح`) : null,
        ),
        el('div', { class: 'bar', title: `الجودة ${m.quality}` }, el('i', { style: false, 'data-q': m.quality })),
        el('div', { class: 'foot' },
          el('span', {}, m.verified_at ? `اتأكد ${ago(m.verified_at)}` : 'لسه ما اتجرّبش'),
          el('button', {
            class: 'btn-ghost',
            onclick: async () => {
              const status = m.status === 'disabled' ? 'enabled' : 'disabled';
              await api(`/api/models/${encodeURIComponent(m.id)}`, { method: 'PATCH', body: JSON.stringify({ status }) });
              loadModels();
              loadModelPicker();
            },
          }, m.status === 'disabled' ? 'تشغيل' : 'إيقاف'),
        ),
      );
    }),
  );
  // CSP forbids inline style attributes, so widths are set through the CSSOM.
  for (const bar of document.querySelectorAll('.bar i')) bar.style.width = `${bar.dataset.q}%`;
}

// --- Memory --------------------------------------------------------------------------------

async function loadMemories() {
  const items = await api('/api/memories');
  if (!items.length) {
    $('memory-list').replaceChildren(el('li', { class: 'empty-note' }, 'مفيش حاجة محفوظة لسه.'));
    return;
  }
  $('memory-list').replaceChildren(
    ...items.map((m) =>
      el('li', { class: m.pinned ? 'pinned' : '' },
        el('span', { dir: 'auto' }, m.content),
        el('span', { class: 'row' },
          m.pinned ? el('span', { class: 'badge ok' }, 'مثبّت') : null,
          el('button', {
            class: 'icon-btn', 'aria-label': 'حذف', onclick: async () => {
              await api(`/api/memories/${m.id}`, { method: 'DELETE' });
              loadMemories();
            },
          }, icon('trash')),
        ),
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

const KIND = { added: ['اتضاف', 'ok'], removed: ['اتشال', 'bad'], failed: ['فشل', 'bad'], paid: ['مدفوع', 'warn'], scan: ['Scan', ''] };

async function loadActivity() {
  const [usage, events] = await Promise.all([api('/api/usage'), api('/api/events')]);
  $('usage-table').replaceChildren(
    el('tr', {}, ...['اليوم', 'الموديل', 'طلبات', 'كبديل', 'فشل', 'توكنز تقريباً'].map((h) => el('th', {}, h))),
    ...(usage.length
      ? usage.map((u) =>
          el('tr', {},
            el('td', {}, u.day), el('td', { dir: 'ltr' }, u.name || u.model_id),
            el('td', {}, String(u.requests)), el('td', {}, String(u.fallbacks)),
            el('td', {}, String(u.failures)), el('td', {}, u.tokens_est.toLocaleString()),
          ))
      : [el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'مفيش استخدام لسه.'))]),
  );
  $('events').replaceChildren(
    ...events.map((ev) => {
      const [label, tone] = KIND[ev.kind] || [ev.kind, ''];
      return el('li', {},
        el('span', { class: `badge kind ${tone}` }, label),
        el('span', { class: 'when' }, ago(ev.at)),
        el('span', { class: 'what' }, [ev.model_id, ev.detail].filter(Boolean).join(' — ')),
      );
    }),
  );
}

// --- Boot ----------------------------------------------------------------------------------

api('/api/me').then(showApp).catch(() => showLogin());
