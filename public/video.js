/**
 * Video page: trim, reframe, resize and mute a video on the device (Mediabunny over WebCodecs),
 * plus subtitles written by Whisper on the server. Only the sound goes up, in 30-second pieces of
 * 16 kHz mono WAV; the words can be corrected before they are burnt into the picture.
 */

const MEDIABUNNY = '/vendor/mediabunny/mediabunny.min.mjs';
const PIECE_SECONDS = 30;
const SAMPLE_RATE = 16_000;

const FRAMES = [['original', 'الأصل'], ['9:16', '9:16'], ['1:1', '1:1'], ['16:9', '16:9']];
const QUALITIES = [['original', 'الأصل'], ['1080', '1080p'], ['720', '720p'], ['480', '480p']];

let ui = null;
let mb = null;

const seconds = (t) => {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
};
const srtTime = (t) => {
  const ms = Math.round(t * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const isArabic = (text) => /[؀-ۿ]/.test(text);

/**
 * Whisper often hands back a whole paragraph as one line. Short lines read better on a phone:
 * at most 7 words, with the time shared out by length.
 */
export function shortLines(segments, maxWords = 7) {
  return segments.flatMap((s) => {
    const words = s.text.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) return [s];
    const parts = Math.ceil(words.length / maxWords);
    const per = Math.ceil(words.length / parts);
    const chunks = Array.from({ length: parts }, (_, i) => words.slice(i * per, (i + 1) * per).join(' '));
    const total = chunks.reduce((n, c) => n + c.length, 0);
    let at = s.start;
    return chunks.map((text) => {
      const start = at;
      at += ((s.end - s.start) * text.length) / total;
      return { start, end: at, text };
    });
  });
}

/** Crop to the chosen frame (centred), then scale so the short side is at most the chosen size. */
export function plan(width, height, frame, quality) {
  let crop = { left: 0, top: 0, width, height };
  if (frame !== 'original') {
    const [a, b] = frame.split(':').map(Number);
    const want = a / b;
    if (width / height > want) {
      const w = even(height * want);
      crop = { left: Math.floor((width - w) / 2), top: 0, width: w, height };
    } else {
      const h = even(width / want);
      crop = { left: 0, top: Math.floor((height - h) / 2), width, height: h };
    }
  }
  const short = Math.min(crop.width, crop.height);
  const scale = quality === 'original' ? 1 : Math.min(1, Number(quality) / short);
  return { crop: frame === 'original' ? null : crop, width: even(crop.width * scale), height: even(crop.height * scale) };
}

/** 16 kHz mono 16-bit PCM bytes → a WAV file. */
export function wav(pcm) {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const tag = (at, s) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  tag(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); tag(8, 'WAVE');
  tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/** The PCM bytes inside a WAV file, wherever its "data" chunk sits. */
function pcmOf(file) {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  for (let at = 12; at + 8 <= file.length;) {
    const id = String.fromCharCode(...file.subarray(at, at + 4));
    const size = v.getUint32(at + 4, true);
    if (id === 'data') return file.subarray(at + 8, Math.min(file.length, at + 8 + size));
    at += 8 + size + (size % 2);
  }
  throw new Error('no audio data');
}

function base64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function download(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

export function mount(root, ctx) {
  if (ui) return;
  const { el, notify } = ctx;
  if (!('VideoEncoder' in window)) {
    root.replaceChildren(el('div', { class: 'empty-note' }, 'المتصفح ده مش بيدعم تعديل الفيديو. جرّب Chrome أو Safari جديد.'));
    return;
  }

  const state = { file: null, url: null, duration: 0, width: 0, height: 0, frame: 'original', quality: '720', segments: [], busy: false };
  const segmented = (items, key, onPick) => {
    const box = el('div', { class: 'segmented' });
    const draw = () => box.replaceChildren(...items.map(([id, label]) =>
      el('button', { type: 'button', class: state[key] === id ? 'on' : '', onclick: () => { state[key] = id; draw(); onPick?.(); } }, label)));
    draw();
    return box;
  };

  const picker = el('input', { type: 'file', accept: 'video/*', hidden: true });
  const pick = el('button', { type: 'button', class: 'video-drop glass', onclick: () => picker.click() },
    el('b', {}, '🎬 اختار فيديو'), el('span', { class: 'muted small' }, 'أو اسحبه هنا · MP4 / MOV / WebM'));
  const player = el('video', { controls: true, playsinline: true, class: 'video-player', hidden: true });
  const info = el('p', { class: 'muted small' });

  const from = el('input', { type: 'number', min: 0, step: 0.1, dir: 'ltr', value: 0 });
  const to = el('input', { type: 'number', min: 0, step: 0.1, dir: 'ltr' });
  const here = (input) => el('button', { type: 'button', class: 'btn-ghost', onclick: () => { input.value = player.currentTime.toFixed(1); } }, 'من هنا');
  const mute = el('input', { type: 'checkbox' });
  const lang = el('select', {}, el('option', { value: 'ar' }, 'الكلام عربي'), el('option', { value: 'en' }, 'الكلام إنجليزي'), el('option', { value: '' }, 'اكتشف لوحده'));
  const task = el('select', {}, el('option', { value: 'transcribe' }, 'اكتب نفس الكلام'), el('option', { value: 'translate' }, 'ترجمه للإنجليزي'));
  const burn = el('input', { type: 'checkbox', checked: true });
  const listen = el('button', { type: 'button', class: 'btn-ghost' }, '🎙️ اسمع واكتب الترجمة');
  const srt = el('button', { type: 'button', class: 'btn-ghost', hidden: true }, '⬇️ ملف ‎.srt');
  const words = el('ol', { class: 'subs' });
  const frameShot = el('button', { type: 'button', class: 'btn-ghost' }, '📸 صورة من اللحظة دي');
  const make = el('button', { type: 'button', class: 'btn-primary' }, '🎬 اعمل الفيديو');
  const progress = el('div', { class: 'progress', hidden: true }, el('i'));
  const status = el('p', { class: 'muted small' });
  const result = el('div', { class: 'video-result', hidden: true });

  const range = () => {
    const start = Math.max(0, Number(from.value) || 0);
    const end = Math.min(state.duration, Number(to.value) || state.duration);
    return end > start ? { start, end } : null;
  };
  const setProgress = (p) => {
    progress.hidden = p === null;
    progress.firstChild.style.width = `${Math.round((p ?? 0) * 100)}%`;
  };
  const busy = (on, text = '') => {
    state.busy = on;
    for (const b of [make, listen, frameShot]) b.disabled = on;
    status.textContent = text;
    if (!on) setProgress(null);
  };

  async function open(file) {
    if (!file?.type.startsWith('video/')) return notify('ده مش فيديو');
    mb ??= await import(MEDIABUNNY);
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) return notify('مالقيتش صورة في الفيديو ده');
    if (state.url) URL.revokeObjectURL(state.url);
    Object.assign(state, {
      file, url: URL.createObjectURL(file), duration: await input.computeDuration(),
      width: track.displayWidth, height: track.displayHeight, segments: [],
      hasAudio: Boolean(await input.getPrimaryAudioTrack()),
    });
    player.src = state.url;
    player.hidden = false;
    from.value = 0;
    to.value = state.duration.toFixed(1);
    info.textContent = `${file.name} · ${state.width}×${state.height} · ${seconds(state.duration)} · ${(file.size / 1e6).toFixed(1)} MB`;
    renderWords();
    result.hidden = true;
    form.hidden = false;
  }

  function renderWords() {
    srt.hidden = !state.segments.length;
    words.replaceChildren(...state.segments.map((s) => {
      const input = el('input', { dir: 'auto', value: s.text });
      input.addEventListener('input', () => { s.text = input.value; });
      return el('li', {}, el('span', { class: 'when', dir: 'ltr' }, `${seconds(s.start)} → ${seconds(s.end)}`), input);
    }));
  }

  /** Whisper on the trimmed sound, one 30-second piece at a time. Times are from the trim start. */
  async function transcribe() {
    const r = range();
    if (!state.file || !r) return notify('اختار فيديو والجزء اللي عايزه الأول');
    if (!state.hasAudio) return notify('الفيديو ده مفيهوش صوت');
    busy(true, 'بطلّع الصوت…');
    try {
      const input = new mb.Input({ source: new mb.BlobSource(state.file), formats: mb.ALL_FORMATS });
      const output = new mb.Output({ format: new mb.WavOutputFormat(), target: new mb.BufferTarget() });
      const conversion = await mb.Conversion.init({
        input, output, trim: r, video: { discard: true },
        audio: { numberOfChannels: 1, sampleRate: SAMPLE_RATE, codec: 'pcm-s16', forceTranscode: true },
      });
      if (!conversion.isValid) throw new Error('مقدرتش أقرا الصوت');
      await conversion.execute();
      const pcm = pcmOf(new Uint8Array(output.target.buffer));
      const step = PIECE_SECONDS * SAMPLE_RATE * 2;
      const pieces = Math.ceil(pcm.length / step);
      const segments = [];
      for (let i = 0; i < pieces; i++) {
        status.textContent = `بسمع وبكتب… ${i + 1} من ${pieces}`;
        setProgress(i / pieces);
        const out = await ctx.api('/api/transcribe', {
          method: 'POST',
          body: JSON.stringify({ audio: base64(wav(pcm.subarray(i * step, (i + 1) * step))), language: lang.value, task: task.value }),
        });
        const offset = i * PIECE_SECONDS;
        segments.push(...out.segments.map((s) => ({ start: s.start + offset, end: s.end + offset, text: s.text })));
      }
      state.segments = shortLines(segments);
      renderWords();
      notify(segments.length ? `✓ ${segments.length} جملة — تقدر تصلّح أي كلمة قبل ما تعمل الفيديو` : 'مالقيتش كلام في الجزء ده');
    } catch (err) {
      notify(err.message);
    } finally {
      busy(false);
      ctx.loadQuota();
    }
  }

  /** The words on screen at time t (seconds from the trim start), wrapped to the frame. */
  function caption(g, w, h, t) {
    const line = state.segments.find((s) => t >= s.start && t < s.end);
    if (!line?.text.trim()) return;
    const size = Math.round(Math.min(w, h) * 0.055);
    g.font = `700 ${size}px 'IBM Plex Sans Arabic', 'Inter', sans-serif`;
    g.textAlign = 'center';
    g.direction = isArabic(line.text) ? 'rtl' : 'ltr';
    g.lineJoin = 'round';
    const rows = [];
    let row = '';
    for (const word of line.text.split(/\s+/)) {
      const next = row ? `${row} ${word}` : word;
      if (row && g.measureText(next).width > w * 0.88) {
        rows.push(row);
        row = word;
      } else {
        row = next;
      }
    }
    rows.push(row);
    const lh = size * 1.3;
    rows.forEach((text, i) => {
      const y = h - h * 0.08 - (rows.length - 1 - i) * lh;
      g.lineWidth = size * 0.22;
      g.strokeStyle = 'rgba(0, 0, 0, .85)';
      g.strokeText(text, w / 2, y);
      g.fillStyle = '#fff';
      g.fillText(text, w / 2, y);
    });
  }

  async function render() {
    const r = range();
    if (!state.file || !r) return notify('اختار فيديو والجزء اللي عايزه الأول');
    busy(true, 'بجهّز الفيديو…');
    setProgress(0);
    try {
      const { crop, width, height } = plan(state.width, state.height, state.frame, state.quality);
      const subtitles = burn.checked && state.segments.length;
      const canvas = el('canvas', { width, height });
      const g = canvas.getContext('2d');
      const input = new mb.Input({ source: new mb.BlobSource(state.file), formats: mb.ALL_FORMATS });
      const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
      const conversion = await mb.Conversion.init({
        input, output, trim: r,
        video: {
          ...(crop ? { crop } : {}), width, height, fit: 'fill',
          ...(subtitles ? {
            process: (sample) => {
              sample.draw(g, 0, 0, width, height);
              caption(g, width, height, sample.timestamp);
              return canvas;
            },
          } : {}),
        },
        audio: mute.checked ? { discard: true } : {},
      });
      if (!conversion.isValid) throw new Error('المتصفح ده ماعرفش يعمل الفيديو ده. جرّب مقاس أصغر.');
      conversion.onProgress = (p) => setProgress(p);
      await conversion.execute();
      const blob = new Blob([output.target.buffer], { type: 'video/mp4' });
      const name = `${state.file.name.replace(/\.[^.]+$/, '')}-bello.mp4`;
      const url = URL.createObjectURL(blob);
      result.replaceChildren(
        el('video', { controls: true, playsinline: true, src: url, class: 'video-player' }),
        el('div', { class: 'row' },
          el('a', { class: 'btn-primary', href: url, download: name }, '⬇️ نزّل الفيديو'),
          el('span', { class: 'muted small' }, `${width}×${height} · ${seconds(r.end - r.start)} · ${(blob.size / 1e6).toFixed(1)} MB`),
        ),
      );
      result.hidden = false;
      result.scrollIntoView({ behavior: 'smooth', block: 'start' });
      navigator.vibrate?.(12);
    } catch (err) {
      notify(err.message);
    } finally {
      busy(false);
    }
  }

  function grabFrame() {
    if (!state.file) return;
    const max = 1280 / Math.max(player.videoWidth, player.videoHeight);
    const scale = Math.min(1, max);
    const canvas = el('canvas', { width: Math.round(player.videoWidth * scale), height: Math.round(player.videoHeight * scale) });
    canvas.getContext('2d').drawImage(player, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', 0.9);
    const name = `frame-${player.currentTime.toFixed(1)}s.jpg`;
    shot.replaceChildren(
      el('img', { src: data, alt: name }),
      el('div', { class: 'row' },
        el('a', { class: 'btn-ghost', href: data, download: name }, '⬇️ نزّلها'),
        el('button', { type: 'button', class: 'btn-ghost', onclick: () => ctx.editPicture(data, name) }, '✏️ عدّلها بالذكاء الاصطناعي'),
      ),
    );
    shot.hidden = false;
  }

  const shot = el('div', { class: 'frame-shot glass', hidden: true });
  listen.addEventListener('click', transcribe);
  make.addEventListener('click', render);
  frameShot.addEventListener('click', grabFrame);
  srt.addEventListener('click', () => {
    const text = state.segments.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}\n`).join('\n');
    download(new Blob([text], { type: 'application/x-subrip' }), `${state.file.name.replace(/\.[^.]+$/, '')}.srt`);
  });
  picker.addEventListener('change', () => {
    open(picker.files[0]).catch((err) => notify(err.message));
    picker.value = '';
  });
  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) open(e.dataTransfer.files[0]).catch((err) => notify(err.message));
  });

  const card = (title, ...children) => el('div', { class: 'video-card glass' }, el('h3', {}, title), ...children);
  const form = el('div', { class: 'video-form', hidden: true },
    card('✂️ القص',
      el('div', { class: 'row trim' },
        el('label', {}, 'من', from, here(from)),
        el('label', {}, 'لحد', to, here(to)),
        el('span', { class: 'muted small' }, 'بالثواني'),
      ),
    ),
    card('📐 المقاس', segmented(FRAMES, 'frame'), segmented(QUALITIES, 'quality'),
      el('label', { class: 'toggle' }, mute, el('span'), 'اكتم الصوت')),
    card('💬 ترجمة مكتوبة بالذكاء الاصطناعي',
      el('p', { class: 'muted small' }, 'Whisper بيسمع الصوت ويكتبه بتوقيته (مجاني على Cloudflare، وبيتحسب من دقايق الفيديو بتاعتك النهارده).'),
      el('div', { class: 'row' }, lang, task, listen, srt),
      words,
      el('label', { class: 'toggle' }, burn, el('span'), 'احرق الكلام جوه الفيديو'),
    ),
    card('🖼️ صورة من الفيديو', el('p', { class: 'muted small' }, 'وقّف الفيديو على اللقطة اللي عايزها.'), frameShot, shot),
    el('div', { class: 'row' }, make, status),
    progress,
  );

  root.replaceChildren(
    pick, picker, player, info, form, result,
    el('p', { class: 'muted small video-note' },
      'فيديو من نص (Veo و Kling و Seedance وغيرهم) لسه مفيش منه نسخة مجانية بـ API — كله مدفوع. أول ما يظهر واحد مجاني هيتضاف هنا.'),
  );
  ui = root;
}
