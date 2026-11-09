const $ = (id) => document.getElementById(id);

const state = { conversationId: null, controller: null, web: false, compare: false, draw: false, keepCompared: null };

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
  if (!res.ok) throw Object.assign(new Error(errorText(data, res.status)), { data });
  return data;
}

/** Local clock time, e.g. "2:00 ص". */
const clock = (ms) => new Date(ms).toLocaleTimeString('ar-EG-u-nu-latn', { hour: 'numeric', minute: '2-digit' });

/** "بعد 3 ساعات" / "بعد 20 دقيقة" until a moment. */
function untilText(ms) {
  const min = Math.max(1, Math.round((ms - Date.now()) / 60_000));
  if (min < 60) return `بعد ${min} ${min >= 3 && min <= 10 ? 'دقايق' : 'دقيقة'}`;
  const h = Math.round(min / 60);
  return h === 1 ? 'بعد ساعة' : h === 2 ? 'بعد ساعتين' : `بعد ${h} ${h <= 10 ? 'ساعات' : 'ساعة'}`;
}

/** A server error as text; a daily limit also says when it comes back, like Claude and ChatGPT do. */
function errorText(data, status) {
  const base = data?.error || `HTTP ${status}`;
  return data?.resetAt ? `${base} بيتجدد الساعة ${clock(data.resetAt)} (${untilText(data.resetAt)}).` : base;
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
  redo: '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/>',
  speak: '<path d="M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
  hush: '<path d="M11 5 6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6"/>',
  share: '<path d="M12 3v13M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>',
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
  const d = new Date(ms);
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
};

// --- Dialog and toasts --------------------------------------------------------------------

function confirmDialog(title, text, ok = 'امسح') {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = ok;
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

function notify(text) {
  const t = el('div', { class: 'toast-msg' }, text);
  $('toasts').append(t);
  setTimeout(() => t.classList.add('out'), 2200);
  setTimeout(() => t.remove(), 2600);
}

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
  const lines = escapeHtml(text).split('\n');
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l ?? '');
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    // A Markdown table: header row, a |---| row, then body rows.
    if (isRow(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? '') && lines[i + 1].includes('-')) {
      flushPara();
      flush();
      const head = cells(line);
      const body = [];
      i += 2;
      while (i < lines.length && isRow(lines[i])) body.push(cells(lines[i++]));
      i--;
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${
        body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
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
  notify('اتنسخ الكود');
});

// --- Auth ----------------------------------------------------------------------------------

const LOGIN_ERRORS = {
  not_invited: 'الإيميل ده مش متدعي لسه — اطلب من صاحب الموقع يضيفك.',
  email: 'حساب Google ده من غير إيميل متأكد منه.',
  expired: 'الطلب خلص وقته، جرّب تاني.',
  google: 'حصلت مشكلة مع Google، جرّب تاني.',
};

async function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
  const cfg = await fetch('/api/auth/config').then((r) => r.json()).catch(() => ({ google: false }));
  $('google-login').hidden = !cfg.google;
  // No Google yet: the password form is the way in, so open it.
  $('password-login').open = !cfg.google;
  const err = new URLSearchParams(location.search).get('login_error');
  if (err) {
    $('login-error').textContent = LOGIN_ERRORS[err] || 'ماقدرناش ندخلك، جرّب تاني.';
    $('login-error').hidden = false;
    history.replaceState(null, '', '/');
  }
}

const session = { me: null };
const isOwner = () => session.me?.role === 'owner';

function renderMe() {
  const me = session.me;
  for (const n of document.querySelectorAll('[data-owner]')) n.hidden = !isOwner();
  // Pictures and video subtitles need the owner's Workers AI.
  for (const n of document.querySelectorAll('[data-media]')) n.hidden = !me.media;
  const name = me.name || me.email || 'أنا';
  $('me').replaceChildren(
    me.picture
      ? el('img', { src: me.picture, alt: '', class: 'me-avatar', referrerpolicy: 'no-referrer' })
      : el('span', { class: 'me-avatar letter' }, name.trim()[0]?.toUpperCase() || '?'),
    el('span', { class: 'me-text' },
      el('b', { dir: 'auto' }, name),
      el('span', { class: 'muted small' }, isOwner() ? 'المالك' : 'عضو'),
    ),
  );
  const noKeys = me.providers.length === 0;
  $('no-keys').hidden = !noKeys;
  $('keys-dot').hidden = !noKeys;
}

async function showApp(me) {
  session.me = me;
  $('login').hidden = true;
  $('app').hidden = false;
  renderMe();
  await Promise.all([loadConversations(), loadModelPicker(), loadQuota(), loadBell()]);
  watchBell();
  if (!matchMedia('(pointer: coarse)').matches) $('input').focus();
}

async function refreshMe() {
  session.me = await api('/api/me');
  renderMe();
}

for (const b of document.querySelectorAll('[data-go]')) b.addEventListener('click', () => showView(b.dataset.go));

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').hidden = true;
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
    $('password').value = '';
    await showApp(await api('/api/me'));
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

const views = { chat: null, video: loadVideo, models: loadModels, memory: loadMemories, activity: loadActivity, keys: loadKeys, members: loadMembers, settings: loadSettings };
const TITLES = { video: 'الفيديو', models: 'الموديلات', memory: 'الذاكرة', activity: 'النشاط', keys: 'مفاتيحي', members: 'الأعضاء', settings: 'المظهر' };

function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('scrim').classList.remove('show');
}

function showView(name) {
  for (const v of Object.keys(views)) $(`view-${v}`).hidden = v !== name;
  for (const b of document.querySelectorAll('.nav button')) b.classList.toggle('active', b.dataset.view === name);
  $('history').hidden = name !== 'chat';
  closeSidebar();
  if (TITLES[name]) $('title').textContent = TITLES[name];
  $('delete-chat').hidden = name !== 'chat' || !state.conversationId;
  views[name]?.();
}

for (const b of document.querySelectorAll('.nav button')) b.addEventListener('click', () => showView(b.dataset.view));
$('menu').addEventListener('click', () => {
  $('sidebar').classList.add('open');
  $('scrim').classList.add('show');
});
$('scrim').addEventListener('click', closeSidebar);

// --- Conversations -------------------------------------------------------------------------

const convs = { list: [] };

function groupOf(ms) {
  const day = 86400_000;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (ms >= start.getTime()) return 'النهارده';
  if (ms >= start.getTime() - day) return 'امبارح';
  if (ms >= start.getTime() - 7 * day) return 'آخر 7 أيام';
  if (ms >= start.getTime() - 30 * day) return 'آخر 30 يوم';
  return 'أقدم';
}

function renderConversations() {
  const q = $('conv-search').value.trim().toLowerCase();
  const items = convs.list.filter((c) => !q || c.title.toLowerCase().includes(q));
  const out = [];
  let group = null;
  for (const c of items) {
    const g = groupOf(c.updated_at);
    if (g !== group) {
      group = g;
      out.push(el('li', { class: 'section-label' }, g));
    }
    out.push(
      el('li', { class: c.id === state.conversationId ? 'active' : '' },
        el('button', { class: 'conv', dir: 'auto', title: c.title, onclick: () => openConversation(c.id, c.title) }, c.title),
        el('button', { class: 'icon-btn del', 'aria-label': 'امسح', title: 'امسح', onclick: () => deleteConversation(c.id) }, icon('trash')),
      ),
    );
  }
  if (!out.length) out.push(el('li', { class: 'muted small empty-conv' }, q ? 'مفيش نتايج' : 'لسه مفيش محادثات'));
  $('conversations').replaceChildren(...out);
}

async function loadConversations() {
  convs.list = await api('/api/conversations');
  renderConversations();
}
$('conv-search').addEventListener('input', renderConversations);

async function deleteConversation(id) {
  const title = convs.list.find((c) => c.id === id)?.title ?? '';
  if (!(await confirmDialog('تمسح المحادثة دي؟', `«${title}» هتتمسح نهائي ومش هتعرف ترجّعها.`))) return;
  await api(`/api/conversations/${id}`, { method: 'DELETE' });
  notify('اتمسحت المحادثة');
  if (state.conversationId === id) newChat();
  else loadConversations();
}

$('delete-chat').addEventListener('click', () => state.conversationId && deleteConversation(state.conversationId));

function newChat() {
  state.keepCompared?.();
  state.conversationId = null;
  $('delete-chat').hidden = true;
  $('title').textContent = 'محادثة جديدة';
  $('messages').replaceChildren($('empty'));
  $('empty').hidden = false;
  showView('chat');
  loadConversations();
  $('input').focus();
}
$('new-chat').addEventListener('click', newChat);

async function openConversation(id, title) {
  await state.keepCompared?.();
  state.conversationId = id;
  $('delete-chat').hidden = false;
  $('title').textContent = title;
  showView('chat');
  const messages = await api(`/api/conversations/${id}`);
  $('empty').hidden = true;
  $('messages').replaceChildren($('empty'), ...messages.map((m) => messageNode(m)));
  scrollDown(true);
  scrollWhenLoaded($('messages'));
  loadConversations();
}

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    $('input').value = chip.dataset.prompt.replace(/\\n/g, '\n');
    if ('draw' in chip.dataset) setDraw(true);
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
      notify('اتنسخ الرد');
      setTimeout(() => copyBtn.replaceChildren(icon('copy')), 1500);
    },
  }, icon('copy'));
  const speakBtn = el('button', { class: 'icon-btn', title: 'اقرالي', onclick: () => speak(m.content, speakBtn) }, icon('speak'));
  const extras = [speakBtn];
  if (navigator.share) {
    extras.push(el('button', {
      class: 'icon-btn', title: 'شارك', onclick: () => navigator.share({ text: m.content }).catch(() => {}),
    }, icon('share')));
  }
  // A drawn picture is not re-asked through chat.
  const drawn = list(m.attachments).length > 0;
  return [
    ...extras,
    // CSS shows this only on the last answer.
    drawn ? null : el('button', { class: 'icon-btn regen', title: 'رد تاني', onclick: () => send('', { regenerate: true }) }, icon('redo')),
    copyBtn,
    el('button', { class: `icon-btn vote ${m.feedback === 1 ? 'on' : ''}`, title: 'رد حلو', onclick: (e) => vote(1, e.currentTarget) }, icon('up')),
    el('button', { class: `icon-btn vote ${m.feedback === -1 ? 'on' : ''}`, title: 'رد وحش', onclick: (e) => vote(-1, e.currentTarget) }, icon('down')),
  ];
}

/** Stored as JSON text by the server, kept as arrays while streaming. */
const list = (v) => {
  if (Array.isArray(v)) return v;
  try {
    return v ? JSON.parse(v) : [];
  } catch {
    return [];
  }
};

function viewImage(src) {
  const d = el('dialog', { class: 'viewer', onclick: () => d.close() }, el('img', { src, alt: '' }));
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
}

function attachmentsNode(atts) {
  if (!atts.length) return null;
  return el('div', { class: 'msg-atts' }, ...atts.map((a) => (a.type === 'image'
    ? el('img', { src: a.data, alt: a.name, title: a.name, onclick: () => viewImage(a.data) })
    : el('span', { class: 'file-chip', title: a.name }, '📄', el('span', { dir: 'auto' }, a.name)))));
}

/** Pictures Bello drew: big, with download and "edit this" under each. */
function drawnNode(atts) {
  const pictures = atts.filter((a) => a.type === 'image');
  if (!pictures.length) return null;
  return el('div', { class: 'drawn' }, ...pictures.map((a) => el('figure', {},
    el('img', { src: a.data, alt: a.name, onclick: () => viewImage(a.data) }),
    el('figcaption', {},
      el('a', { class: 'btn-ghost', href: a.data, download: a.name }, '⬇️ نزّلها'),
      el('button', { type: 'button', class: 'btn-ghost', onclick: () => editPicture(a.data, a.name) }, '✏️ عدّلها'),
    ),
    el('div', { class: 'edit-presets' }, ...EDIT_PRESETS.map(([label, prompt]) =>
      el('button', { type: 'button', class: 'quick-chip', onclick: () => sendImage(prompt, [{ type: 'image', name: a.name, data: a.data }]) }, label))),
  )));
}

/** Put a picture in the tray with drawing on, so the next message edits it. */
function editPicture(data, name = 'صورة') {
  if (count('image') >= MAX_IMAGES) return notify(`أقصى حاجة ${MAX_IMAGES} صور`);
  pending.push({ type: 'image', name, data });
  renderTray();
  setDraw(true);
  showView('chat');
  $('input').placeholder = 'اكتب التعديل: مثلاً خلّي الخلفية بحر، أو شيل الشخص اللي ورا';
  $('input').focus();
}

function sourcesNode(sources) {
  const safe = list(sources).filter((s) => /^https?:\/\//.test(s.url));
  if (!safe.length) return null;
  return el('div', { class: 'sources' }, ...safe.map((s) =>
    el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', title: s.title }, '🔗', el('span', { dir: 'auto' }, s.title))));
}

function answerParts(m) {
  const notice = m.notice ? el('div', { class: 'notice' }, m.notice.startsWith('بدوّر') ? `🌐 ${m.notice}` : `ℹ️ ${m.notice}`) : null;
  const body = m.content
    ? el('div', { class: 'body', dir: 'auto', html: renderMarkdown(m.content) })
    : el('div', { class: 'typing' }, el('i'), el('i'), el('i'));
  const searched = m.web || list(m.sources).length > 0;
  const meta = el('div', { class: 'meta' },
    m.model_name
      ? el('span', { class: `model-tag ${m.fallback ? 'fallback' : ''}`, title: searched ? 'رد من بحث على النت' : m.fallback ? 'بديل بعد ما الأول وقع' : '' },
        searched ? el('span', { class: 'web-dot' }, '🌐') : null, m.model_name)
      : null,
    ...messageActions(m),
  );
  return [notice, body, sourcesNode(m.sources), meta];
}

function messageNode(m) {
  if (m.role === 'user') {
    return el('div', { class: 'msg user' }, el('div', { class: 'bubble', dir: 'auto' },
      attachmentsNode(list(m.attachments)),
      m.content ? el('div', { class: 'body' }, m.content) : null,
    ));
  }
  const parts = answerParts(m);
  parts.splice(2, 0, drawnNode(list(m.attachments)));
  return el('div', { class: 'msg assistant' },
    el('img', { src: '/icon.svg', alt: '', class: 'avatar' }),
    el('div', { class: 'bubble' }, ...parts),
  );
}

/** Update a streaming answer in place: same node, so nothing re-animates or flickers. */
function fillAnswer(node, m) {
  const bubble = node.querySelector('.bubble');
  const [notice, body, sources, meta] = answerParts(m);
  const current = bubble.querySelector(':scope > .body, :scope > .typing');
  if (m.content && current.classList.contains('body')) current.innerHTML = body.innerHTML;
  else current.replaceWith(body);
  bubble.querySelector(':scope > .notice')?.remove();
  if (notice) bubble.prepend(notice);
  bubble.querySelector(':scope > .sources')?.remove();
  bubble.querySelector(':scope > .meta').replaceWith(meta);
  if (sources) meta.before(sources);
}

function scrollDown(force = false) {
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}

/** Pictures grow the page as they load: scroll again once they have. */
function scrollWhenLoaded(node) {
  const pending = [...node.querySelectorAll('img')].filter((img) => !img.complete);
  if (pending.length) Promise.allSettled(pending.map((img) => img.decode())).then(() => scrollDown(true));
}

// --- Attachments ---------------------------------------------------------------------------

const MAX_IMAGES = 4;
const MAX_FILES = 3;
const MAX_FILE_CHARS = 120_000;
const pending = [];

function renderTray() {
  $('tray').hidden = pending.length === 0;
  $('tray').replaceChildren(...pending.map((a) => {
    const remove = el('button', {
      type: 'button', class: 'x', 'aria-label': 'شيل', onclick: () => {
        pending.splice(pending.indexOf(a), 1);
        renderTray();
      },
    }, icon('x'));
    if (a.type === 'image') {
      return el('div', { class: `att image ${a.busy ? 'busy' : ''}`, title: a.name },
        a.data ? el('img', { src: a.data, alt: a.name }) : el('div', { class: 'typing' }, el('i'), el('i'), el('i')), remove);
    }
    return el('div', { class: `att ${a.busy ? 'busy' : ''}`, title: a.name },
      a.busy ? '⏳' : '📄', el('span', { class: 'name', dir: 'auto' }, a.name), remove);
  }));
  // A picture in the tray: the shortcuts become one-tap edits, and the hint says it can edit.
  renderQuick();
  if (!state.draw) {
    $('input').placeholder = count('image') && session.me?.media
      ? 'اسأل عن الصورة، أو قول تعمل فيها إيه: شيل الخلفية، خليها كرتون…'
      : 'اكتب رسالتك…';
  }
}

/** Pictures go up as JPEG, at most 1280 px on the long side: small enough for every provider. */
async function shrinkImage(source, max = 1280, startQuality = 0.82, maxChars = 1_300_000) {
  const bmp = await createImageBitmap(source);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = el('canvas', { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  let quality = startQuality;
  let url = canvas.toDataURL('image/jpeg', quality);
  while (url.length > maxChars && quality > 0.4) {
    quality -= 0.15;
    url = canvas.toDataURL('image/jpeg', quality);
  }
  return url;
}

/** A data URL as an image element (fetching data: URLs is outside the page's CSP). */
function loadImage(src) {
  const img = new Image();
  img.src = src;
  return img.decode().then(() => img);
}

let pdfjs = null;
/** Text of a PDF. A scanned PDF has none: its first pages come back as pictures instead. */
async function readPdf(file) {
  if (!pdfjs) {
    pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  }
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false, disableFontFace: true }).promise;
  const pages = [];
  let total = 0;
  for (let i = 1; i <= doc.numPages && total < MAX_FILE_CHARS; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    const text = content.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('').trim();
    if (text) pages.push(`[صفحة ${i}]\n${text}`);
    total += text.length;
  }
  if (total > 40) return { text: pages.join('\n\n') };
  const images = [];
  for (let i = 1; i <= Math.min(doc.numPages, MAX_IMAGES); i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, 1280 / Math.max(base.width, base.height)) });
    const canvas = el('canvas', { width: Math.floor(viewport.width), height: Math.floor(viewport.height) });
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
    images.push(await shrinkImage(canvas));
  }
  return { images };
}

const count = (type) => pending.filter((a) => a.type === type).length;

async function addFiles(files) {
  for (const file of files) {
    const isImage = file.type.startsWith('image/');
    if (isImage ? count('image') >= MAX_IMAGES : count('file') >= MAX_FILES) {
      notify(isImage ? `أقصى حاجة ${MAX_IMAGES} صور في الرسالة` : `أقصى حاجة ${MAX_FILES} ملفات في الرسالة`);
      continue;
    }
    const item = { type: isImage ? 'image' : 'file', name: file.name || 'صورة', busy: true };
    pending.push(item);
    renderTray();
    try {
      if (isImage) {
        item.data = await shrinkImage(file);
      } else if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
        const pdf = await readPdf(file);
        if (pdf.text) {
          item.text = pdf.text.slice(0, MAX_FILE_CHARS);
        } else {
          // A scan: send its pages as pictures so a model that reads images can still read it.
          pending.splice(pending.indexOf(item), 1);
          for (const [i, data] of pdf.images.slice(0, MAX_IMAGES - count('image')).entries()) {
            pending.push({ type: 'image', name: `${file.name} · ${i + 1}`, data });
          }
          notify('الـ PDF ده صور من غير نص، هبعته كصور');
        }
      } else {
        if (file.size > 2_000_000) throw new Error('big');
        item.text = (await file.text()).slice(0, MAX_FILE_CHARS);
      }
      item.busy = false;
    } catch {
      const at = pending.indexOf(item);
      if (at >= 0) pending.splice(at, 1);
      notify(`ماقدرتش أقرا ${file.name}`);
    }
    renderTray();
  }
}

$('attach').addEventListener('click', () => $('file-pick').click());
$('file-pick').addEventListener('change', (e) => {
  addFiles([...e.target.files]);
  e.target.value = '';
});
$('input').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
});
let dropHint = null;
$('view-chat').addEventListener('dragover', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  dropHint ??= document.body.appendChild(el('div', { class: 'drop-hint' }, 'سيب الملف هنا 📎'));
});
const hideDrop = () => {
  dropHint?.remove();
  dropHint = null;
};
$('view-chat').addEventListener('dragleave', (e) => { if (!e.relatedTarget || !$('view-chat').contains(e.relatedTarget)) hideDrop(); });
$('view-chat').addEventListener('drop', (e) => {
  hideDrop();
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  addFiles([...e.dataTransfer.files]);
});

// --- Web search and compare toggles --------------------------------------------------------

function toggle(id, on) {
  $(id).setAttribute('aria-pressed', String(on));
  state[id] = on;
}
/** Web search, compare and drawing are one mode at a time. */
function only(id) {
  for (const other of ['web', 'compare', 'draw']) if (other !== id) toggle(other, false);
  $('draw-size-wrap').hidden = !state.draw;
  // The chat model picker does nothing while drawing: CSS hides it there on phones.
  $('composer').classList.toggle('drawing', state.draw);
  if (!state.draw) $('input').placeholder = 'اكتب رسالتك…';
  if (quota.data) renderQuota();
}
function setDraw(on) {
  toggle('draw', on);
  if (on) $('input').placeholder = count('image') ? 'اكتب التعديل اللي عايزه على الصورة' : 'وصف الصورة اللي عايزها';
  only('draw');
}
$('web').addEventListener('click', () => {
  toggle('web', !state.web);
  only('web');
  notify(state.web ? '🌐 هيدوّر على النت قبل ما يرد' : 'البحث على النت اتقفل');
});
$('compare').addEventListener('click', () => {
  toggle('compare', !state.compare);
  only('compare');
  notify(state.compare ? '⚖️ 3 موديلات هيردّوا وانت تختار' : 'المقارنة اتقفلت');
});
$('draw').addEventListener('click', () => {
  setDraw(!state.draw);
  notify(state.draw ? '🎨 اكتب وصف الصورة — أو ارفع صورة واكتب التعديل' : 'الرسم اتقفل');
});

// --- Sending -------------------------------------------------------------------------------

async function loadModelPicker() {
  const models = await api('/api/models');
  const active = models.filter((m) => m.status === 'active');
  const resting = active.filter((m) => m.cooldown_until > Date.now()).length;
  const current = $('model-pick').value;
  $('model-pick').replaceChildren(
    el('option', { value: 'auto' }, 'تلقائي'),
    ...active.map((m) => el('option', { value: m.id }, m.paid ? `💎 ${m.name}` : m.name)),
  );
  if (active.some((m) => m.id === current)) $('model-pick').value = current;
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

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if ((!text && !pending.length) || state.controller) return;
  if (pending.some((a) => a.busy)) return notify('استنى الملفات تخلص قراية');
  // Like ChatGPT: "ارسم…" draws; a picture plus "شيل الخلفية" edits it; "خليها ليل" right after
  // a picture edits that one. A question about a picture still goes to chat.
  const files = pending.some((a) => a.type === 'file');
  const media = session.me?.media && !state.compare && !state.web && !files;
  const newDrawing = DRAW_REQUEST.test(text);
  const editing = media && text && !newDrawing && wantsEdit(text);
  const recent = count('image') ? null : recentPicture();
  if (state.draw || (media && newDrawing) || (editing && (count('image') || recent))) {
    if (!text) return notify(count('image') ? 'اكتب التعديل اللي عايزه' : 'اكتب وصف الصورة');
    if (files) return notify('الرسم والتعديل بياخدوا صور بس، من غير ملفات');
    // With an empty tray, an edit applies to the picture just above; a description draws anew.
    const images = count('image') ? pending.splice(0) : editing && recent ? [recent] : [];
    renderTray();
    $('input').value = '';
    autosize();
    return sendImage(text, images, { onRecent: Boolean(images.length && images[0] === recent) });
  }
  const attachments = pending.splice(0).map(({ type, name, data, text: t }) => (type === 'image' ? { type, name, data } : { type, name, text: t }));
  renderTray();
  $('input').value = '';
  autosize();
  send(text, { attachments });
});

/** POST to /api/chat and hand every SSE event to onEvent; owns the send/stop buttons. */
async function stream(body, onEvent) {
  state.controller = new AbortController();
  $('send').hidden = true;
  $('stop').hidden = false;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: state.controller.signal,
    });
    if (res.status === 401) {
      showLogin();
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(errorText(data, res.status));
    }
    await readEvents(res.body, onEvent);
  } finally {
    state.controller = null;
    $('send').hidden = false;
    $('stop').hidden = true;
    loadModelPicker();
    loadQuota();
  }
}

// --- Pictures: draw or edit --------------------------------------------------------------

const DRAW_REQUEST = /^\s*(ارسم|ارسملي|إرسم|اعمل(لي| لي)? صور[ةه]|اعمللي صور[ةه]|صمم(لي| لي)? صور[ةه]|ولّ?د صور[ةه]|(please )?(draw|paint)\b|(generate|create|make) (me )?an? (image|picture|photo|drawing))/i;
/**
 * Pictures to edit go up at 1024 px, which FLUX accepts today and which keeps faces and text
 * sharper. Its documented limit is under 512 px: if it ever refuses, they go again at 511.
 */
const EDIT_INPUT_PX = 1024;
const SAFE_INPUT_PX = 511;

/** Ready-made edits: under every drawn picture, and as shortcuts when a picture is attached. */
const EDIT_PRESETS = [
  ['🧹 شيل الخلفية', 'شيل الخلفية وخليها أبيض سادة، وسيب الشخص أو الحاجة اللي في النص زي ما هي'],
  ['✨ حسّنها', 'حسّن الإضاءة والألوان والوضوح من غير ما تغيّر أي حاجة في الصورة'],
  ['🎨 كرتون', 'حوّل الصورة لرسمة كرتون بألوان زاهية، بنفس الأشخاص والتكوين'],
  ['🖤 أبيض وأسود', 'خلّي الصورة أبيض وأسود بشكل سينمائي'],
  ['🌙 ليل', 'خلّي الجو ليل والقمر طالع، وسيب كل حاجة تانية زي ما هي'],
];

/** Polite openings that come before the actual request. */
const POLITE = /^(ممكن|لو سمحت|من فضلك|please|can you|could you|عايز(ك|ه)?|عاوز(ك|ه)?|محتاج(ك)?|نفسي|يا ريت)\s+/i;
/** Arabic letters are not \w, so word ends are spelled out. */
const END = '(?=$|[\\s،,.!؟?])';
const ASKING = new RegExp(`[؟?]\\s*$|^(ايه|إيه|ليه|مين|فين|امتى|إمتى|كام|هل|ازاي|إزاي|what|why|who|where|when|how|which|is|are|does|do|can)${END}|اشرح|وصف|اوصف|ترجم|لخ[ّ]?ص|ملخص|اقر[اأ]|\\b(explain|describe|translate|summari[sz]e|summary|read)\\b`, 'i');
const EDIT_VERB = new RegExp(`^(خل[ّ]?ي\\S*|غي[ّ]?ر\\S*|شيل\\S*|امسح\\S*|ا?ضيف\\S*|أضف|زو[ّ]?د\\S*|حط\\S*|حو[ّ]?ل\\S*|لو[ّ]?ن\\S*|بد[ّ]?ل\\S*|رك[ّ]?ب\\S*|صل[ّ]?ح\\S*|حس[ّ]?ن\\S*|نض[ّ]?ف\\S*|قص(ها|ه|يها)?|كب[ّ]?ر\\S*|صغ[ّ]?ر\\S*|عد[ّ]?ل\\S*|اجعل\\S*|[أا]زل\\S*|لب[ّ]?س\\S*|make|change|remove|add|replace|turn|put|edit|fix|enhance|convert|erase|swap|give|transform|colou?r)${END}`, 'i');

/** "Do something to the picture" rather than "tell me about it". */
function wantsEdit(text) {
  const t = text.trim().replace(POLITE, '').replace(POLITE, '');
  if (!t || ASKING.test(t)) return false;
  // "اعمل فيها…" / "اعمل عليها…" is an edit; "اعملي خطة" is not.
  if (/^اعمل\S*\s/.test(t) && /\s(فيها|فيه|عليها|عليه|ليها|منها)(\s|$)|الصور[ةه]/.test(t)) return true;
  // "تشيل" / "تخلي" after "ممكن" or "عايزك" are the same verbs.
  return t.split(/\s+/).slice(0, 3).some((w) => EDIT_VERB.test(w) || EDIT_VERB.test(w.replace(/^ت/, '')));
}

/** The newest picture in the last few messages (drawn or sent), for "now make it…" follow-ups. */
function recentPicture() {
  for (const node of [...$('messages').children].slice(-4).reverse()) {
    const img = [...node.querySelectorAll('.drawn img, .msg-atts img')].pop();
    if (img) return { type: 'image', name: img.alt || 'صورة', data: img.src };
  }
  return null;
}

async function sendImage(text, images, { onRecent = false } = {}) {
  if (state.controller) return;
  await state.keepCompared?.();
  $('empty').hidden = true;
  // Fewer JPEG artefacts going in means fewer coming out; the limit is the server's (1,000,000).
  const shrink = (px) => Promise.all(images.map(async (a) => shrinkImage(await loadImage(a.data), px, 0.92, 950_000)));
  let inputs = await shrink(EDIT_INPUT_PX);
  const first = images.length ? await loadImage(inputs[0]) : null;
  const aspect = first ? first.naturalWidth / first.naturalHeight : Number($('draw-size').value);
  // Editing the picture just above: it is already on screen, so only the words go in the bubble.
  $('messages').append(messageNode({
    role: 'user',
    content: text,
    attachments: onRecent ? [] : inputs.map((data, i) => ({ type: 'image', name: images[i].name, data })),
  }));
  const answer = {
    role: 'assistant',
    content: '',
    notice: !images.length ? 'برسم الصورة… (حوالي 10 ثواني)' : onRecent ? 'بعدّل الصورة اللي فوق… (حوالي 10 ثواني)' : 'بعدّل الصورة… (حوالي 10 ثواني)',
  };
  const node = messageNode(answer);
  $('messages').append(node);
  scrollDown(true);

  state.controller = new AbortController();
  $('send').hidden = true;
  $('stop').hidden = false;
  try {
    const request = () => api('/api/images', {
      method: 'POST',
      body: JSON.stringify({ prompt: text, images: inputs, aspect, conversationId: state.conversationId }),
      signal: state.controller.signal,
    });
    const out = await request().catch(async (err) => {
      if (!err.data?.smaller) throw err;
      inputs = await shrink(SAFE_INPUT_PX);
      return request();
    });
    conversationEvent('conversation', { id: out.conversationId }, `🎨 ${text}`);
    const done = messageNode(out.message);
    node.replaceWith(done);
    scrollDown(true);
    scrollWhenLoaded(done);
    navigator.vibrate?.(12);
  } catch (err) {
    if (err.name === 'AbortError') {
      node.remove();
    } else {
      answer.notice = null;
      answer.content = `⚠️ ${err.message}`;
      fillAnswer(node, answer);
    }
  } finally {
    state.controller = null;
    $('send').hidden = false;
    $('stop').hidden = true;
    // The tray is empty again: the hint goes back to describing a new picture.
    if (state.draw) setDraw(true);
    loadQuota();
  }
}

// --- Daily limits ------------------------------------------------------------------------

const quota = { data: null };
const KIND_NAMES = { messages: 'رسايل', images: 'صور', video: 'دقايق فيديو' };

async function loadQuota() {
  try {
    quota.data = await api('/api/limits');
    renderQuota();
  } catch {
    // The meter is a nicety; the server enforces the limits anyway.
  }
}

/** Sidebar meter (like Claude's usage bars) and a line over the composer when little is left. */
function renderQuota() {
  const { kinds, resetAt } = quota.data;
  const shown = kinds.filter((k) => k.limit !== null && (k.kind === 'messages' || session.me?.media));
  $('quota').hidden = !shown.length;
  $('quota').replaceChildren(
    el('div', { class: 'quota-head' }, el('b', {}, 'استخدامك النهارده'), el('span', { class: 'muted small' }, `بيتجدد ${clock(resetAt)}`)),
    ...shown.map((k) => {
      const share = k.limit ? Math.min(100, (k.used / k.limit) * 100) : 100;
      const tone = k.used >= k.limit ? 'out' : share >= 80 ? 'low' : '';
      return el('div', { class: `quota-row ${tone}` },
        el('span', {}, KIND_NAMES[k.kind]),
        el('span', { class: 'muted small' }, `${k.used} / ${k.limit}`),
        el('div', { class: 'quota-bar' }, el('i', { 'data-p': share })),
      );
    }),
  );
  // CSP forbids inline style attributes, so widths are set through the CSSOM.
  for (const bar of $('quota').querySelectorAll('.quota-bar i')) bar.style.width = `${bar.dataset.p}%`;

  const k = kinds.find((x) => x.kind === (state.draw ? 'images' : 'messages'));
  const left = k.limit === null ? Infinity : k.limit - k.used;
  const what = KIND_NAMES[k.kind];
  $('quota-note').hidden = left > 5;
  $('quota-note').classList.toggle('out', left <= 0);
  $('quota-note').textContent = left <= 0
    ? `⏳ خلّصت ${what} النهارده — بيتجدد الساعة ${clock(resetAt)} (${untilText(resetAt)})`
    : `فاضل لك ${left} ${what} النهارده`;
}

/** One line over the composer: what is left on the model that just answered. */
function renderRemaining(r) {
  const node = $('model-left');
  const number = (n) => n.toLocaleString('en-US');
  const out = r.left === 0;
  const low = r.left !== null && !out && (r.left <= 10 || (r.limit !== null && r.left / r.limit <= 0.1));
  const parts = [];
  if (r.fallback) parts.push('الموديل الأول ماردّش، فكمّلت على ده');
  if (r.paid) parts.push('موديل مدفوع، من رصيدك');
  else if (out) parts.push('خلص');
  else if (r.left !== null) parts.push(`فاضل ${number(r.left)}${r.limit ? ` من ${number(r.limit)}` : ''} طلب النهارده`);
  else parts.push(`المزود مش بيقول فاضل قد إيه · استخدامك النهارده ${number(r.used)}`);
  if (r.shared) parts.push('مشترك بين موديلات OpenRouter المجانية');
  if (r.resetAt) parts.push(`بيرجع كامل ${untilText(r.resetAt)}`);
  node.classList.toggle('low', low);
  node.classList.toggle('out', out);
  node.replaceChildren(el('b', { dir: 'ltr' }, r.model), ` · ${parts.join(' · ')}`);
  node.hidden = false;
}

/** Shared by both modes: a new conversation's id and, later, its generated title. */
function conversationEvent(event, data, firstText) {
  if (event === 'conversation') {
    const isNew = !state.conversationId;
    state.conversationId = data.id;
    $('delete-chat').hidden = false;
    if (isNew) {
      $('title').textContent = firstText.slice(0, 60);
      loadConversations();
    }
  } else if (event === 'title') {
    $('title').textContent = data.title;
    loadConversations();
  }
}

/** Calls fn at most once per animation frame. */
function perFrame(fn) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn();
    });
  };
}

async function send(text, { regenerate = false, attachments = [] } = {}) {
  if (state.controller) return;
  await state.keepCompared?.();
  if (state.compare && !regenerate) return sendCompare(text, attachments);
  $('empty').hidden = true;
  if (regenerate) {
    const last = $('messages').lastElementChild;
    if (last?.classList.contains('assistant')) last.remove();
  } else {
    $('messages').append(messageNode({ role: 'user', content: text, attachments }));
  }

  const answer = { role: 'assistant', content: '', model_name: '' };
  const node = messageNode(answer);
  $('messages').append(node);
  scrollDown(true);
  const render = () => {
    fillAnswer(node, answer);
    scrollDown();
  };
  const renderSoon = perFrame(render);

  try {
    await stream(
      { conversationId: state.conversationId, message: text, model: $('model-pick').value, regenerate, attachments, web: state.web },
      (event, data) => {
        conversationEvent(event, data, text || attachments[0]?.name || '');
        if (event === 'model') {
          if (data.web) answer.notice = null;
          answer.model_name = data.name;
          answer.fallback = data.fallback;
          answer.web = data.web;
          answer.content = '';
        } else if (event === 'token') {
          answer.content += data.t;
          return renderSoon();
        } else if (event === 'searching') {
          answer.notice = 'بدوّر على النت وبقرا الصفحات…';
        } else if (event === 'notice') {
          answer.notice = data.message;
        } else if (event === 'sources') {
          answer.sources = data.sources;
        } else if (event === 'remaining') {
          renderRemaining(data);
        } else if (event === 'done') {
          answer.id = data.messageId;
          navigator.vibrate?.(12);
        } else if (event === 'error') {
          answer.content += `${answer.content ? '\n\n' : ''}⚠️ ${data.message}`;
        }
        render();
      },
    );
    render();
  } catch (err) {
    if (err.name !== 'AbortError') {
      answer.content += `\n\n⚠️ ${err.message}`;
      render();
    }
  }
}

/** Three answers side by side; the one kept becomes the conversation's answer. */
async function sendCompare(text, attachments) {
  $('empty').hidden = true;
  $('messages').append(messageNode({ role: 'user', content: text, attachments }));
  const slots = [];
  const grid = el('div', { class: 'compare' });
  const title = el('div', { class: 'compare-title' }, '⚖️ بيردّوا مع بعض… اختار أحسن رد وهو اللي يتحفظ');
  const block = el('div', { class: 'compare-block' }, title, grid);
  $('messages').append(block);
  scrollDown(true);

  const keep = async (s) => {
    if (block.dataset.kept) return;
    block.dataset.kept = '1';
    state.keepCompared = null;
    for (const b of grid.querySelectorAll('.pick')) b.disabled = true;
    try {
      const { messageId } = await api('/api/compare/pick', {
        method: 'POST',
        body: JSON.stringify({ conversationId: block.dataset.conversation, modelId: s.id, text: s.content }),
      });
      block.replaceWith(messageNode({ role: 'assistant', id: messageId, content: s.content, model_name: s.model_name, feedback: 1 }));
      notify('اتحفظ الرد ده 👍 والموديل خد نقطة');
    } catch (err) {
      delete block.dataset.kept;
      for (const b of grid.querySelectorAll('.pick')) b.disabled = false;
      notify(err.message);
    }
  };

  const renderSlots = () => {
    grid.style.setProperty('--slots', String(Math.max(slots.length, 1)));
    grid.replaceChildren(...slots.map((s) => {
      const card = s.node ?? (s.node = el('div', { class: 'compare-card' },
        el('div', { class: 'head' }, el('span', {}, `${slots.indexOf(s) + 1}.`), el('b', { dir: 'auto' }, ''), el('span', { class: 'prov' }, '')),
        el('div', { class: 'body', dir: 'auto' }),
        el('button', { type: 'button', class: 'pick', disabled: true, onclick: () => keep(s) }, 'اختار ده'),
      ));
      card.classList.toggle('failed', Boolean(s.failed));
      card.querySelector('.head b').textContent = s.model_name || '…';
      card.querySelector('.head .prov').textContent = s.provider ? `· ${s.provider}` : '';
      const body = card.querySelector('.body');
      if (s.content) body.innerHTML = renderMarkdown(s.content);
      else body.replaceChildren(s.failed ? `⚠️ ${s.failed}` : el('div', { class: 'typing' }, el('i'), el('i'), el('i')));
      card.querySelector('.pick').disabled = !s.done || Boolean(block.dataset.kept);
      return card;
    }));
    scrollDown();
  };
  const renderSoon = perFrame(renderSlots);

  // Sending again without choosing keeps the first finished answer, so the history stays whole.
  state.keepCompared = async () => {
    const first = slots.find((s) => s.done);
    if (first) await keep(first);
    state.keepCompared = null;
  };

  try {
    await stream({ conversationId: state.conversationId, message: text, attachments, compare: true }, (event, data) => {
      conversationEvent(event, data, text || attachments[0]?.name || '');
      if (event === 'conversation') {
        block.dataset.conversation = data.id;
        for (let i = 0; i < (data.slots ?? 0); i++) slots.push({ content: '' });
      } else if (event === 'model') {
        Object.assign(slots[data.slot], { id: data.id, model_name: data.name, provider: data.provider, content: '', failed: null });
      } else if (event === 'token') {
        slots[data.slot].content += data.t;
        return renderSoon();
      } else if (event === 'slot-done') {
        slots[data.slot].done = true;
        navigator.vibrate?.(8);
      } else if (event === 'slot-error') {
        slots[data.slot].failed = data.message;
      } else if (event === 'error') {
        title.textContent = `⚠️ ${data.message}`;
      } else if (event === 'done') {
        title.textContent = slots.some((s) => s.done) ? '⚖️ خلصوا — اختار أحسن رد وهو اللي يتحفظ' : '⚠️ ولا موديل عرف يرد';
      }
      renderSlots();
    });
  } catch (err) {
    if (err.name !== 'AbortError') title.textContent = `⚠️ ${err.message}`;
  }
  renderSlots();
}

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

const everyText = (d) => (d === 1 ? 'كل يوم' : d === 2 ? 'كل يومين' : d < 1 ? `كل ${Math.round(d * 24)} ساعة` : `كل ${d} أيام`);

async function loadAutoScan() {
  const st = await api('/api/status');
  const next = new Date(st.nextScanAt).toLocaleString('ar-EG-u-nu-latn', { weekday: 'long', hour: 'numeric', minute: '2-digit' });
  $('auto-scan').textContent = st.lastCron
    ? `🟢 بيدوّر لوحده ${everyText(st.everyDays)} · آخر مرة ${ago(st.lastCron.at)} (${st.lastCron.provider}) · الجاية ${next}`
    : `⏳ بيدوّر لوحده ${everyText(st.everyDays)} · أول مرة ${next}`;
}

$('tab-free').addEventListener('click', () => switchModelsTab('free'));
$('tab-paid').addEventListener('click', () => switchModelsTab('paid'));
function switchModelsTab(tab) {
  $('tab-free').classList.toggle('on', tab === 'free');
  $('tab-paid').classList.toggle('on', tab === 'paid');
  $('free-pane').hidden = tab !== 'free';
  $('paid-pane').hidden = tab !== 'paid';
  if (tab === 'paid') loadPaid();
}

$('scan-now').addEventListener('click', async () => {
  const btn = $('scan-now');
  btn.disabled = true;
  const providers = (await api('/api/providers')).filter((p) => p.configured);
  let added = 0;
  for (const p of providers) {
    toast(`بيدوّر في ${p.label}…`);
    try {
      const r = await api(`/api/discovery/${p.id}`, { method: 'POST' });
      added += r.added.length;
    } catch {
      // One provider failing must not stop the others.
    }
  }
  toast(added ? `✨ اتضاف ${added} موديل جديد` : 'مفيش جديد دلوقتي — كله متحدّث');
  btn.disabled = false;
  loadModels();
  loadModelPicker();
});

async function loadModels() {
  loadAutoScan();
  const [all, providers] = await Promise.all([api('/api/models'), api('/api/providers')]);
  const models = all.filter((m) => !m.paid);
  const now = Date.now();
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
          // The quick test's Arabic check only until the exam gives a real score.
          m.score_arabic != null ? null : m.arabic_ok === 1 ? el('span', { class: 'badge ok' }, 'عربي ✓') : m.arabic_ok === 0 ? el('span', { class: 'badge bad' }, 'عربي ✗') : null,
          m.latency_ms ? el('span', { class: 'badge' }, `${(m.latency_ms / 1000).toFixed(1)}s`) : null,
          m.context_length ? el('span', { class: 'badge' }, `${Math.round(m.context_length / 1000)}k`) : null,
          m.supports_vision ? el('span', { class: 'badge' }, 'صور') : null,
          ...[['score_code', 'كود'], ['score_reasoning', 'منطق'], ['score_arabic', 'عربي']].map(([k, label]) =>
            m[k] == null ? null : el('span', { class: `badge ${m[k] >= 100 ? 'ok' : m[k] === 0 ? 'bad' : 'warn'}`, title: 'نتيجة الامتحان' }, `${label} ${m[k]}`)),
          runs ? el('span', { class: 'badge' }, `${Math.round((m.ok_count / runs) * 100)}% نجاح`) : null,
        ),
        el('div', { class: 'bar', title: `الجودة ${m.quality}` }, el('i', { style: false, 'data-q': m.quality })),
        el('div', { class: 'foot' },
          el('span', { title: m.last_error || '' }, m.verified_at
            ? `اتأكد ${ago(m.verified_at)}`
            : m.last_error ? 'هيتجرّب تاني خلال ساعة' : 'مستني دوره في التجربة'),
          !isOwner() ? null : el('button', {
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

// --- Paid models ---------------------------------------------------------------------------

const paid = { data: null };
const usd = (n) => (n === 0 ? '$0' : n >= 0.1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
// The names people look for first; everything else follows.
const FEATURED = ['anthropic', 'openai', 'google', 'x-ai', 'deepseek', 'moonshotai', 'qwen', 'mistralai', 'meta-llama', 'z-ai'];
const rank = (m) => { const i = FEATURED.indexOf(m.vendor); return i === -1 ? FEATURED.length : i; };

async function loadPaid() {
  paid.data = await api('/api/paid');
  const { settings, spent, credits, catalog } = paid.data;
  $('balance').textContent = credits ? usd(Math.max(0, credits.total - credits.used)) : '—';
  $('spent').textContent = `صرفت الشهر ده تقريباً ${usd(spent)} من ${usd(settings.capUsd)}`;
  $('paid-mode').checked = settings.mode === 'on';
  $('paid-cap').value = String(settings.capUsd);
  $('paid-note').textContent = `${catalog.models.length} موديل · الأسعار بالدولار لكل مليون توكن (≈ 750 ألف كلمة) · اتحدّثت ${catalog.updatedAt ? ago(catalog.updatedAt) : '—'}`;
  renderPaid();
}

function renderPaid() {
  if (!paid.data) return;
  const q = $('paid-search').value.trim().toLowerCase();
  const allowed = new Set(paid.data.allowed);
  let rows = paid.data.catalog.models.filter((m) => m.out > 0 && (!q || `${m.id} ${m.name}`.toLowerCase().includes(q)));
  const sort = $('paid-sort').value;
  if (sort === 'popular') rows = [...rows].sort((a, b) => rank(a) - rank(b) || b.out - a.out);
  if (sort === 'expensive') rows = [...rows].sort((a, b) => b.out - a.out);
  if (sort === 'allowed') rows = rows.filter((m) => allowed.has(m.id));
  $('paid-table').replaceChildren(
    el('tr', {}, ...['الموديل', 'الشركة', 'دخل / 1M', 'خرج / 1M', 'السياق', ''].map((h) => el('th', {}, h))),
    ...rows.slice(0, 200).map((m) =>
      el('tr', { class: allowed.has(m.id) ? 'allowed' : '' },
        el('td', { dir: 'ltr' }, m.name, m.vision ? ' 🖼️' : ''),
        el('td', { dir: 'ltr', class: 'muted' }, m.vendor),
        el('td', {}, usd(m.in)),
        el('td', {}, usd(m.out)),
        el('td', {}, m.context ? `${Math.round(m.context / 1000)}k` : '—'),
        el('td', {},
          el('button', {
            class: allowed.has(m.id) ? 'btn-ghost on' : 'btn-ghost',
            onclick: async () => {
              const action = allowed.has(m.id) ? 'disallow' : 'allow';
              await api(`/api/paid/${action}`, { method: 'POST', body: JSON.stringify({ model: m.id }) });
              await loadPaid();
              loadModelPicker();
            },
          }, allowed.has(m.id) ? '✓ مسموح' : 'اسمح'),
        ),
      ),
    ),
  );
}

$('paid-search').addEventListener('input', renderPaid);
$('paid-sort').addEventListener('change', renderPaid);
$('paid-mode').addEventListener('change', async () => {
  await api('/api/paid/settings', { method: 'POST', body: JSON.stringify({ mode: $('paid-mode').checked ? 'on' : 'off' }) });
  loadPaid();
});
$('paid-cap').addEventListener('change', async () => {
  await api('/api/paid/settings', { method: 'POST', body: JSON.stringify({ capUsd: Number($('paid-cap').value) }) });
  loadPaid();
});

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

// --- My keys -------------------------------------------------------------------------------

const KEY_GUIDES = {
  groq: { url: 'https://console.groq.com/keys', steps: ['سجّل دخول بحساب Google', 'اضغط Create API Key وانسخ المفتاح'], hint: 'gsk_…', note: 'الأسرع — ردود في أقل من ثانية' },
  gemini: { url: 'https://aistudio.google.com/apikey', steps: ['اضغط Create API key وانسخ المفتاح', 'ما تفعّلش الـ billing (يفضل مجاني)'], hint: 'AIza… أو AQ.…', note: 'Gemini Flash و Gemma — عربي ممتاز' },
  openrouter: { url: 'https://openrouter.ai/settings/keys', steps: ['سجّل واضغط Create Key وانسخ المفتاح', 'من غير ما تشحن أي رصيد'], hint: 'sk-or-…', note: 'عشرات الموديلات المجانية من شركات مختلفة' },
};

async function loadKeys() {
  const list = await api('/api/keys');
  $('keys-list').replaceChildren(...list.map((p) => {
    const guide = KEY_GUIDES[p.id] || { url: '#', steps: [], hint: '', note: '' };
    const input = el('input', { type: 'password', dir: 'ltr', placeholder: guide.hint, autocomplete: 'off', spellcheck: 'false' });
    const status = el('span', { class: 'muted small' });
    const save = el('button', { class: 'btn-primary' }, p.saved ? 'غيّر' : 'احفظ');
    save.addEventListener('click', async () => {
      if (!input.value.trim()) return input.focus();
      save.disabled = true;
      status.textContent = 'بنتأكد إن المفتاح شغال…';
      try {
        await api(`/api/keys/${p.id}`, { method: 'PUT', body: JSON.stringify({ key: input.value }) });
        notify(`✓ اتحفظ مفتاح ${p.label}`);
        await Promise.all([loadKeys(), refreshMe(), loadModelPicker()]);
      } catch (err) {
        status.textContent = `✗ ${err.message}`;
        save.disabled = false;
      }
    });
    const badge = p.saved
      ? el('span', { class: 'badge ok' }, `✓ ••••${p.saved.hint}`)
      : p.fromApp
        ? el('span', { class: 'badge' }, 'من مفاتيح الموقع')
        : el('span', { class: 'badge warn' }, 'مش متضاف');
    return el('div', { class: `key-card glass ${p.saved || p.fromApp ? 'done' : ''}` },
      el('div', { class: 'head' },
        el('div', {}, el('b', {}, p.label), el('div', { class: 'muted small' }, guide.note)),
        badge,
      ),
      el('ol', { class: 'steps' },
        el('li', {}, 'افتح ', el('a', { href: guide.url, target: '_blank', rel: 'noopener noreferrer', class: 'open-link', dir: 'ltr' }, `${new URL(guide.url, location.href).host} ↗`)),
        ...guide.steps.map((step) => el('li', { dir: 'auto' }, step)),
        el('li', {}, 'الصقه هنا واضغط احفظ'),
      ),
      el('div', { class: 'row key-row' }, input, save,
        p.saved ? el('button', {
          class: 'icon-btn', title: 'امسح المفتاح', onclick: async () => {
            if (!(await confirmDialog(`تمسح مفتاح ${p.label}؟`, 'الموديلات بتاعته هتقف عندك لحد ما تضيف مفتاح تاني.'))) return;
            await api(`/api/keys/${p.id}`, { method: 'DELETE' });
            notify('اتمسح المفتاح');
            await Promise.all([loadKeys(), refreshMe(), loadModelPicker()]);
          },
        }, icon('trash')) : null),
      status,
    );
  }));
}

// --- Members (owner) -----------------------------------------------------------------------

function avatar(u) {
  return u.picture
    ? el('img', { src: u.picture, alt: '', class: 'me-avatar', referrerpolicy: 'no-referrer' })
    : el('span', { class: 'me-avatar letter' }, (u.name || u.email || '?')[0].toUpperCase());
}

async function loadMembers() {
  const data = await api('/api/members');
  $('google-warning').hidden = data.googleReady;
  const userRow = (u) => el('li', { class: 'member-row' },
    el('span', { class: 'member' }, avatar(u),
      el('span', { class: 'me-text' },
        el('b', { dir: 'auto' }, u.name || u.email || 'المالك'),
        el('span', { class: 'muted small', dir: 'ltr' }, u.email || ''),
      ),
    ),
    el('span', { class: 'row' },
      el('span', { class: 'badge' }, `${u.messages_30d} رسالة/شهر`),
      el('button', { class: 'btn-ghost small-btn', onclick: (e) => toggleLimits(e.currentTarget.closest('li'), u) }, '⏳ الحدود'),
      el('span', { class: `badge ${u.keys ? 'ok' : 'warn'}` }, u.keys ? `${u.keys} مفتاح` : 'من غير مفاتيح'),
      u.last_seen ? el('span', { class: 'muted small' }, ago(u.last_seen)) : null,
      u.role === 'owner' ? el('span', { class: 'badge ok' }, 'المالك') : el('button', {
        class: 'icon-btn', title: 'شيله', onclick: async () => {
          if (!(await confirmDialog('تشيل العضو ده؟', `${u.email} مش هيقدر يدخل تاني، وكل محادثاته ومفاتيحه هتتمسح.`, 'شيله'))) return;
          await api(`/api/members/${u.id}`, { method: 'DELETE' });
          notify('اتشال العضو');
          loadMembers();
        },
      }, icon('trash')),
    ),
  );
  const inviteRow = (i) => el('li', { class: 'pending' },
    el('span', { class: 'member' }, el('span', { class: 'me-avatar letter' }, '✉'),
      el('span', { class: 'me-text' }, el('b', { dir: 'ltr' }, i.email), el('span', { class: 'muted small' }, `مستني يدخل · اتدعى ${ago(i.created_at)}`))),
    el('button', {
      class: 'icon-btn', title: 'إلغاء الدعوة', onclick: async () => {
        await api(`/api/members/invite/${encodeURIComponent(i.email)}`, { method: 'DELETE' });
        loadMembers();
      },
    }, icon('x')),
  );
  $('members-list').replaceChildren(...data.users.map(userRow), ...data.invites.map(inviteRow));
}

const LIMIT_KINDS = [['messages', 'رسايل'], ['images', 'صور'], ['video', 'دقايق فيديو']];
/** '' = default, ∞ = no limit, otherwise a whole number. */
const limitValue = (text) => {
  const t = text.trim();
  if (!t) return null;
  if (/^(∞|-1?|مفتوح)$/.test(t)) return -1;
  return /^\d+$/.test(t) ? Number(t) : NaN;
};

/** Under a member: today's use and their own limits (empty = the default in config/limits.ts). */
function toggleLimits(row, u) {
  const open = row.nextElementSibling?.classList.contains('limits-row');
  if (open) return row.nextElementSibling.remove();
  const today = new Map(u.today.map((k) => [k.kind, k]));
  const inputs = LIMIT_KINDS.map(([kind]) => {
    const stored = u[`limit_${kind}`];
    return el('input', {
      type: 'text', inputmode: 'numeric', dir: 'ltr', 'aria-label': kind,
      value: stored === null || stored === undefined ? '' : stored === -1 ? '∞' : String(stored),
      placeholder: `افتراضي (${today.get(kind).limit ?? '∞'})`,
    });
  });
  const save = el('button', {
    class: 'btn-primary', onclick: async () => {
      const values = inputs.map((i) => limitValue(i.value));
      if (values.some((v) => Number.isNaN(v))) return notify('اكتب رقم، أو ∞ لمفتوح، أو سيبه فاضي للافتراضي');
      try {
        await api(`/api/members/${u.id}/limits`, {
          method: 'PUT',
          body: JSON.stringify(Object.fromEntries(LIMIT_KINDS.map(([kind], i) => [kind, values[i]]))),
        });
        notify('✓ اتحفظت الحدود');
        await loadMembers();
        if (u.id === session.me.id) loadQuota();
      } catch (err) {
        notify(err.message);
      }
    },
  }, 'احفظ');
  row.after(el('li', { class: 'limits-row' },
    el('div', { class: 'limits-grid' }, ...LIMIT_KINDS.map(([kind, label], i) => {
      const k = today.get(kind);
      return el('label', {}, el('span', {}, label), inputs[i], el('span', { class: 'muted small' }, `النهارده ${k.used} / ${k.limit ?? '∞'}`));
    })),
    el('div', { class: 'row' }, save, el('span', { class: 'muted small' }, 'فاضي = الافتراضي · ∞ = مفتوح · 0 = مقفول')),
  ));
}

$('invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/members/invite', { method: 'POST', body: JSON.stringify({ email: $('invite-email').value }) });
    notify('✓ اتدعى — قوله يدخل بحساب Google ده');
    $('invite-email').value = '';
    loadMembers();
  } catch (err) {
    notify(err.message);
  }
});

// --- Video (public/video.js, loaded the first time the page opens) ----------------------------

let videoPage = null;
async function loadVideo() {
  videoPage ??= await import('/video.js');
  videoPage.mount($('video-app'), { el, api, notify, loadQuota, editPicture });
}

// --- Voice, read-aloud, quick actions -------------------------------------------------------

/** Text worth reading out: no code blocks or Markdown symbols. */
const speakable = (md) => md.replace(/```[\s\S]*?```/g, ' (كود) ').replace(/[`*#>_]/g, '').replace(/\n+/g, '. ');

let speaking = null;
function speak(text, btn) {
  if (!('speechSynthesis' in window)) return notify('المتصفح ده مش بيدعم القراءة بصوت');
  const wasThis = speaking === btn;
  speechSynthesis.cancel();
  if (speaking) speaking.replaceChildren(icon('speak'));
  speaking = null;
  if (wasThis) return;
  const u = new SpeechSynthesisUtterance(speakable(text));
  const arabic = /[؀-ۿ]/.test(text);
  u.lang = arabic ? 'ar-EG' : 'en-US';
  const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith(arabic ? 'ar' : 'en'));
  if (voice) u.voice = voice;
  u.onend = () => {
    btn.replaceChildren(icon('speak'));
    speaking = null;
  };
  speaking = btn;
  btn.replaceChildren(icon('hush'));
  speechSynthesis.speak(u);
}

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Recognition) {
  $('mic').hidden = false;
  let rec = null;
  $('mic').addEventListener('click', () => {
    if (rec) return rec.stop();
    rec = new Recognition();
    rec.lang = 'ar-EG';
    rec.interimResults = true;
    rec.continuous = false;
    const before = $('input').value;
    rec.onresult = (e) => {
      const said = [...e.results].map((r) => r[0].transcript).join(' ');
      $('input').value = `${before}${before ? ' ' : ''}${said}`;
      autosize();
    };
    rec.onerror = (e) => { if (e.error === 'not-allowed') notify('اسمح للموقع يستخدم المايك'); };
    rec.onend = () => {
      rec = null;
      $('mic').classList.remove('live');
      $('input').focus();
    };
    $('mic').classList.add('live');
    navigator.vibrate?.(10);
    rec.start();
  });
}

/** With text typed: apply to it. Empty box: apply to the last answer. */
const QUICK = [
  { label: '✨ لخّص', withText: 'لخّص ده في نقط قصيرة:\n\n', alone: 'لخّص ردك اللي فات في نقط قصيرة.' },
  { label: '🌐 ترجم', withText: 'ترجم ده (للإنجليزي لو عربي، وللعربي لو إنجليزي):\n\n', alone: 'ترجم ردك اللي فات (للإنجليزي لو عربي، وللعربي لو إنجليزي).' },
  { label: '✍️ صحّح', withText: 'صحّح الأخطاء الإملائية والنحوية في ده ورجّعهولي مصحّح:\n\n', alone: null },
  { label: '🧒 بسّط', withText: 'اشرحلي ده ببساطة كأني مبتدئ:\n\n', alone: 'اشرح ردك اللي فات ببساطة أكتر، كأني مبتدئ.' },
  { label: '➕ كمّل', withText: null, alone: 'كمّل.' },
];

function renderQuick() {
  const pictures = count('image') && !pending.some((a) => a.type === 'file' || a.busy) && session.me?.media;
  if (pictures) {
    return $('quick').replaceChildren(...EDIT_PRESETS.map(([label, prompt]) => el('button', {
      type: 'button',
      class: 'quick-chip',
      onclick: () => {
        if (state.controller) return;
        const images = pending.splice(0);
        renderTray();
        sendImage(prompt, images);
      },
    }, label)));
  }
  $('quick').replaceChildren(...QUICK.map((q) => el('button', {
    type: 'button',
    class: 'quick-chip',
    onclick: () => {
      const text = $('input').value.trim();
      if (text && q.withText) {
        $('input').value = '';
        autosize();
        return send(q.withText + text);
      }
      if (!text && q.alone && state.conversationId) return send(q.alone);
      notify(q.withText ? 'اكتب أو الصق النص الأول' : 'ابدأ محادثة الأول');
    },
  }, q.label)));
}
renderQuick();

// --- Appearance ----------------------------------------------------------------------------

const THEMES = [
  { id: 'purple', name: 'بنفسجي', colors: ['#0c0817', '#a855f7', '#6d28d9'] },
  { id: 'ocean', name: 'أزرق محيط', colors: ['#060b17', '#38bdf8', '#2563eb'] },
  { id: 'emerald', name: 'زمرّدي', colors: ['#05110c', '#34d399', '#059669'] },
  { id: 'sunset', name: 'غروب', colors: ['#130905', '#fb923c', '#e11d48'] },
  { id: 'rose', name: 'وردي', colors: ['#14060f', '#f472b6', '#be185d'] },
  { id: 'gold', name: 'دهبي', colors: ['#100d05', '#fbbf24', '#b45309'] },
  { id: 'amoled', name: 'أسود AMOLED', colors: ['#000000', '#e5e5e5', '#737373'] },
  { id: 'light', name: 'فاتح', colors: ['#f7f5fc', '#7c3aed', '#4f46e5'] },
  { id: 'ramadan', name: 'رمضان 🌙', colors: ['#070b1a', '#f5c451', '#b7791f'] },
  { id: 'cairo', name: 'ليل القاهرة', colors: ['#0b0908', '#ff8a3d', '#c2410c'] },
  { id: 'terminal', name: 'Terminal', colors: ['#000000', '#22c55e', '#15803d'] },
  { id: 'auto', name: 'تلقائي 🌗', colors: ['#0c0817', '#a855f7', '#f7f5fc'] },
  { id: 'custom', name: 'لونك انت 🎨', colors: ['#0c0817', '#a855f7', '#6d28d9'] },
];

/** Hex → [r, g, b]. */
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (a, b, t) => {
  const [x, y] = [rgb(a), rgb(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
};

/** A whole dark theme from one colour: tinted background, glass, gradient and glow. */
function customVars(hex) {
  const [r, g, b] = rgb(hex);
  return {
    '--bg': mix('#07070b', hex, 0.06),
    '--bg-2': mix('#0e0e14', hex, 0.09),
    '--glass': `rgba(${rgb(mix('#12121a', hex, 0.12)).join(', ')}, .72)`,
    '--glass-line': `rgba(${r}, ${g}, ${b}, .12)`,
    '--line': `rgba(${r}, ${g}, ${b}, .14)`,
    '--soft': `rgba(${r}, ${g}, ${b}, .07)`,
    '--accent': mix(hex, '#ffffff', 0.25),
    '--accent-soft': `rgba(${r}, ${g}, ${b}, .14)`,
    '--grad': `linear-gradient(135deg, ${hex}, ${mix(hex, '#000000', 0.35)})`,
    '--user-bg': `linear-gradient(135deg, ${hex}, ${mix(hex, '#000000', 0.45)})`,
    '--glow': `rgba(${r}, ${g}, ${b}, .5)`,
    '--aura-1': `rgba(${r}, ${g}, ${b}, .2)`,
    '--aura-2': `rgba(${rgb(mix(hex, '#3b82f6', 0.5)).join(', ')}, .14)`,
  };
}

const pref = {
  get: (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

/** 'auto' follows the clock: light from 7:00 to 18:00, dark otherwise. */
const resolveTheme = (id) => {
  if (id !== 'auto') return id;
  const h = new Date().getHours();
  return h >= 7 && h < 18 ? 'light' : 'purple';
};

function applyAppearance() {
  const root = document.documentElement;
  const chosen = pref.get('bello-theme', 'purple');
  const theme = resolveTheme(chosen);
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-size', pref.get('bello-size', 'm'));
  root.setAttribute('data-motion', pref.get('bello-motion', 'off'));
  root.setAttribute('data-bubbles', pref.get('bello-bubbles', 'bubbles'));
  const vars = customVars(pref.get('bello-color', '#a855f7'));
  for (const k of Object.keys(vars)) root.style.removeProperty(k);
  if (theme === 'custom') for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  pref.set('bello-custom-vars', theme === 'custom' ? JSON.stringify(vars) : '');
  const bg = theme === 'custom' ? vars['--bg'] : THEMES.find((t) => t.id === theme)?.colors[0] || '#0c0817';
  document.querySelector('meta[name="theme-color"]').setAttribute('content', bg);
}
setInterval(() => pref.get('bello-theme', '') === 'auto' && applyAppearance(), 10 * 60_000);

function loadSettings() {
  const current = pref.get('bello-theme', 'purple');
  $('themes').replaceChildren(...THEMES.map((t) => {
    const swatch = el('span', { class: `swatch swatch-${t.id}` });
    const colors = t.id === 'custom' ? [t.colors[0], pref.get('bello-color', '#a855f7'), mix(pref.get('bello-color', '#a855f7'), '#000000', 0.35)] : t.colors;
    swatch.style.background = t.id === 'auto'
      ? `linear-gradient(135deg, ${colors[2]} 50%, ${colors[1]} 50%)`
      : `linear-gradient(135deg, ${colors[1]}, ${colors[2]})`;
    const pick = () => {
      pref.set('bello-theme', t.id);
      applyAppearance();
      loadSettings();
      notify(`✓ ${t.name}`);
    };
    const children = [swatch, el('span', {}, t.name)];
    if (t.id === 'custom') {
      const input = el('input', { type: 'color', value: pref.get('bello-color', '#a855f7'), 'aria-label': 'اختار لونك', class: 'color-input' });
      input.addEventListener('input', () => {
        pref.set('bello-color', input.value);
        pref.set('bello-theme', 'custom');
        applyAppearance();
        swatch.style.background = `linear-gradient(135deg, ${input.value}, ${mix(input.value, '#000000', 0.35)})`;
      });
      input.addEventListener('change', loadSettings);
      input.addEventListener('click', (e) => e.stopPropagation());
      children.push(input);
    }
    const card = el('button', { class: `theme-card ${t.id === current ? 'on' : ''}`, onclick: pick }, ...children);
    card.style.background = t.id === 'custom' ? mix('#07070b', colors[1], 0.08) : t.colors[0];
    card.style.color = t.id === 'light' ? '#1e1b2e' : '#f4f2fa';
    return card;
  }));
  const size = pref.get('bello-size', 'm');
  for (const b of $('font-size').querySelectorAll('button')) b.classList.toggle('on', b.dataset.size === size);
  $('motion-toggle').checked = pref.get('bello-motion', 'off') === 'on';
  const bubbles = pref.get('bello-bubbles', 'bubbles');
  for (const b of $('bubble-style').querySelectorAll('button')) b.classList.toggle('on', b.dataset.bubbles === bubbles);
}

$('motion-toggle').addEventListener('change', () => {
  pref.set('bello-motion', $('motion-toggle').checked ? 'on' : 'off');
  applyAppearance();
});
for (const b of document.querySelectorAll('#bubble-style button')) {
  b.addEventListener('click', () => {
    pref.set('bello-bubbles', b.dataset.bubbles);
    applyAppearance();
    loadSettings();
  });
}

for (const b of document.querySelectorAll('#font-size button')) {
  b.addEventListener('click', () => {
    pref.set('bello-size', b.dataset.size);
    applyAppearance();
    loadSettings();
  });
}
applyAppearance();

// --- Notifications -------------------------------------------------------------------------

const BELL_EVERY_MS = 5 * 60_000;
const bell = { items: [], resting: [], timer: 0 };

const seenRests = () => new Set(pref.get('bello-bell-rests', '').split('|').filter(Boolean));

async function loadBell() {
  try {
    Object.assign(bell, await api('/api/notifications'));
  } catch {
    return; // A nicety: the next check tries again.
  }
  // A device's first visit starts clean instead of showing a month of history as new.
  if (!pref.get('bello-bell-seen', '')) pref.set('bello-bell-seen', String(Date.now()));
  renderBell();
}

function bellRow(fresh, label, tone, name, detail) {
  return el('li', { class: fresh ? 'fresh' : '' },
    el('span', { class: `badge kind ${tone}` }, label),
    el('span', { class: 'bell-name', dir: 'ltr' }, name),
    el('span', { class: 'muted small' }, detail),
  );
}

function renderBell() {
  const seenAt = Number(pref.get('bello-bell-seen', '0'));
  const rests = seenRests();
  const rows = [
    ...bell.resting.map((r) => bellRow(!rests.has(r.key), 'خلص', 'warn', r.name, `${r.provider} · بيرجع ${untilText(r.until)}`)),
    ...bell.items.map((i) => {
      const [label, tone] = KIND[i.kind];
      return bellRow(i.at > seenAt, label, tone, i.name, `${i.provider} · ${ago(i.at)}`);
    }),
  ];
  $('bell-list').replaceChildren(...(rows.length ? rows : [el('li', { class: 'muted small bell-empty' }, 'مفيش إشعارات لسه.')]));
  const unread = $('bell-list').querySelectorAll('.fresh').length;
  $('bell-count').hidden = !unread;
  $('bell-count').textContent = unread > 9 ? '9+' : String(unread);
  $('bell').setAttribute('aria-label', unread ? `الإشعارات، ${unread} جديد` : 'الإشعارات');
}

function openBell(open) {
  $('bell-panel').hidden = !open;
  $('bell').setAttribute('aria-expanded', String(open));
  if (!open) return;
  renderBell(); // Keeps the new rows marked for as long as the panel stays open.
  pref.set('bello-bell-seen', String(Math.max(Number(pref.get('bello-bell-seen', '0')), ...bell.items.map((i) => i.at))));
  pref.set('bello-bell-rests', bell.resting.map((r) => r.key).join('|'));
  $('bell-count').hidden = true;
}

/** Checks every few minutes and whenever the tab comes back; hidden tabs do not poll. */
function watchBell() {
  if (bell.timer) return;
  bell.timer = setInterval(() => { if (!document.hidden) loadBell(); }, BELL_EVERY_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadBell(); });
}

$('bell').addEventListener('click', () => openBell($('bell-panel').hidden));
$('bell-panel').addEventListener('click', (e) => { if (e.target.closest('[data-go]')) openBell(false); });
document.addEventListener('click', (e) => {
  if (!$('bell-panel').hidden && !e.target.closest('.bell-wrap')) openBell(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('bell-panel').hidden) openBell(false);
});

// --- Boot ----------------------------------------------------------------------------------

api('/api/me').then(showApp).catch(() => {});
