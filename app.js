/* Market Brief: app logic
 * Sections:
 *   1. Bulletin player (loads briefs/*.json, reads it aloud with the phone's voices)
 *   2. Storage helpers
 *   3. PWA plumbing: service worker, install button, update banner, offline bar
 */

// ---------- 1. Bulletin player ----------
const $ = id => document.getElementById(id);
const RATES = [0.5, 0.8, 0.9, 1, 1.1, 1.25, 1.4];
const ACCENTS = { 'en-IN': 'Indian English', 'en-GB': 'British English', 'en-US': 'American English' };
const WPM = 165;                      // typical speaking pace at 1×, used for durations

let briefs = [];                      // [{date, edition, headline}] newest first, from briefs/index.json
let brief = null;                     // the edition on screen
let sents = [];                       // [{seg, text}] across the whole bulletin
let pos = 0;                          // sentence index
let playing = false, gen = 0, wake = null;
let rate = 1;

function spokenFix(s) {
  return s.replace(/₹\s?/g, 'rupees ').replace(/\bRs\.?\s?(?=\d)/g, 'rupees ')
          .replace(/\bbps\b/gi, 'basis points').replace(/\bFY(\d{2})\b/g, 'F Y $1').replace(/%/g, ' percent');
}
function splitSentences(p) {
  const out = (p.match(/[^.!?]+(?:[.!?]+["'’”)]?|$)/g) || [p]).map(s => s.trim()).filter(Boolean);
  // Merge fragments created by decimals or initials ("2.5", "U.S.") back into their sentence.
  return out.reduce((a, s) => {
    const prev = a[a.length - 1];
    if (prev && ((/\d\.$/.test(prev) && /^\d/.test(s)) || (/\b[A-Z]\.$/.test(prev) && /^[A-Z]\./.test(s)))) a[a.length - 1] += s;
    else a.push(s);
    return a;
  }, []);
}
const words = t => t.split(/\s+/).length;
const mins = w => Math.max(1, Math.round(w / WPM));
function clock(w) { const s = Math.round(w / WPM * 60); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function longDate(d) { return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }); }
function shortDate(d) { return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }); }

function showBrief(b) {
  stop();
  brief = b; sents = [];
  const segs = b.segments || [];
  let before = 0, total = 0;
  segs.forEach(s => total += words(s.script || ''));
  $('headline').textContent = b.headline || 'Your daily financial news';
  const n = segs.reduce((a, s) => a + (s.stories || []).length, 0);
  $('edition').textContent = b.kind === 'story' ? `${b.byline} · ${mins(total)} min`
    : `${longDate(b.date)} · ${b.edition || 'Daily'} edition · ${mins(total)} min · ${n} stories from ET, Moneycontrol, Business Standard and Livemint`;
  let para = -1;                      // paragraphs count across the bulletin, matching the audio's timings
  $('rundown').innerHTML = segs.map((s, i) => {
    const paras = (s.script || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    const html = paras.map(p => { para++; return '<p>' + splitSentences(p).map(t => { sents.push({ seg: i, para, text: t }); return `<span class="s" data-i="${sents.length - 1}" data-p="${para}">${esc(t)} </span>`; }).join('') + '</p>'; }).join('');
    const start = clock(before); before += words(s.script || '');
    const stories = (s.stories || []).map(st => `<li><a href="${esc(st.link)}" target="_blank" rel="noopener">${esc(st.title)}<small>${esc(st.source)} ↗</small></a></li>`).join('');
    return `<li class="seg" data-seg="${i}">
      <button class="seg-head" data-seg="${i}"><span class="seg-time">${start}</span><span class="seg-title">${esc(s.title)}${s.isNew ? '<span class="badge">New</span>' : ''}</span><span class="seg-len">${mins(words(s.script || ''))} min</span></button>
      <div class="script">${html}${stories ? `<details class="stories"><summary>Read the ${(s.stories || []).length} stories</summary><ul>${stories}</ul></details>` : ''}</div>
    </li>`;
  }).join('');
  $('empty').hidden = true; $('start').hidden = false;
  const saved = store.get('pos', {});
  pos = saved.date === b.date && saved.i < sents.length ? saved.i : 0;
  fillReaders();
  renderPos();
  $('editions').innerHTML = b.kind !== 'story' && briefs.length > 1 ? briefs.map(x => `<button class="ed" data-date="${esc(x.date)}" aria-pressed="${x.date === b.date}">${esc(shortDate(x.date))}</button>`).join('') : '';
}

function renderPos() {
  document.querySelectorAll('.s.now').forEach(e => e.classList.remove('now'));
  document.querySelectorAll('.seg.current').forEach(e => e.classList.remove('current'));
  const segs = brief ? brief.segments || [] : [];
  const cur = sents[pos];
  const done = pos >= sents.length;
  $('prog').style.width = sents.length ? (Math.min(pos, sents.length) / sents.length * 100) + '%' : '0';
  if (!cur) {
    $('nowTitle').textContent = done && sents.length ? "That's the brief" : 'Nothing playing';
    $('nowSub').textContent = done && sents.length ? 'Tap play to hear it again' : 'Tap play to start';
    $('startTitle').textContent = 'Play from the top'; $('startSub').textContent = '';
    return;
  }
  const el = document.querySelector(`.s[data-i="${pos}"]`);
  // The audio is timed by paragraph, so it lights up the whole paragraph being read.
  if (el && (playing || pos > 0)) (track() ? document.querySelectorAll(`.s[data-p="${cur.para}"]`) : [el]).forEach(e => e.classList.add('now'));
  document.querySelector(`.seg[data-seg="${cur.seg}"]`)?.classList.add('current');
  $('nowTitle').textContent = segs[cur.seg].title;
  $('nowSub').textContent = `Section ${cur.seg + 1} of ${segs.length}`;
  $('startTitle').textContent = pos > 0 ? `Resume: ${segs[cur.seg].title}` : brief.kind === 'story' ? 'Play the story' : "Play today's brief";
  $('startSub').textContent = pos > 0 ? 'Picks up where you stopped' : `${segs.length} sections, starting with ${segs[0].title}`;
  if (playing && el) { const r = el.getBoundingClientRect(); if (r.top < 60 || r.bottom > innerHeight - 140) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}

// Speech: the phone's own voices for the chosen accent, most natural voice first.
let accent = 'en-IN';
const sameAccent = v => v.lang.replace('_', '-').toLowerCase() === accent.toLowerCase();
function voices() { return speechSynthesis.getVoices().filter(sameAccent); }
function score(v) { return (/natural|online|neural|enhanced|premium/i.test(v.name) ? 4 : 0) + (/google/i.test(v.name) ? 2 : 0); }
function fillVoices() {
  const vs = voices();
  $('accentHelp').hidden = vs.length > 0 || !speechSynthesis.getVoices().length;
  if (!vs.length) { $('voice').innerHTML = `<option value="">Phone's default ${esc(ACCENTS[accent])} voice</option>`; return; }
  const saved = store.get('voice', null);
  const sorted = vs.slice().sort((a, b) => score(b) - score(a));
  const pick = vs.find(v => v.name === saved) || sorted[0];
  $('voice').innerHTML = sorted.map(v => `<option value="${esc(v.name)}"${v === pick ? ' selected' : ''}>${esc(v.name)}</option>`).join('');
}
const currentVoice = () => voices().find(v => v.name === $('voice').value) || null;

function speakFrom(i) {
  if (track()) { audioFrom(i); return; }
  speechSynthesis.cancel();
  const my = ++gen;
  pos = i;
  if (pos >= sents.length) { finish(); return; }
  store.set('pos', { date: brief.date, i: pos });
  renderPos();
  const u = new SpeechSynthesisUtterance(spokenFix(sents[pos].text));
  const v = currentVoice(); if (v) u.voice = v;
  u.lang = accent;                    // with no matching voice, the phone picks its own voice for this accent
  u.rate = rate;
  const nextSeg = sents[pos + 1] && sents[pos + 1].seg !== sents[pos].seg;
  u.onend = () => { if (my === gen) setTimeout(() => { if (my === gen) speakFrom(pos + 1); }, nextSeg ? 900 : 120); };
  u.onerror = e => { if (my === gen && e.error !== 'interrupted' && e.error !== 'canceled') speakFrom(pos + 1); };
  speechSynthesis.speak(u);
}
function finish() { stop(); pos = sents.length; store.set('pos', { date: brief.date, i: pos }); renderPos(); }

// Audio: the bulletin recorded each morning in Google's Indian-English voices. Real audio keeps
// playing with the screen locked, and the lock screen gets play, pause and skip controls.
const audio = new Audio();
audio.preload = 'metadata';
let reader = 'phone';                 // 'female' | 'male' | 'phone'
const track = () => reader !== 'phone' && brief?.audio?.[reader]?.url ? brief.audio[reader] : null;
const audioLength = () => isFinite(audio.duration) ? audio.duration : (track()?.duration || 0);
function paraAt(t) { const ps = track().paras; let k = 0; while (k + 1 < ps.length && ps[k + 1] <= t + 0.05) k++; return k; }

function fillReaders() {
  const a = brief?.audio || {};
  const opts = [];
  if (a.female?.url) opts.push(['female', 'Google voice, female (plays in background)']);
  if (a.male?.url) opts.push(['male', 'Google voice, male (plays in background)']);
  opts.push(['phone', "Phone's own voice"]);
  const want = store.get('reader', 'female');
  reader = opts.some(o => o[0] === want) ? want : opts[0][0];
  $('reader').innerHTML = opts.map(([k, n]) => `<option value="${k}"${k === reader ? ' selected' : ''}>${n}</option>`).join('');
  $('phoneOpts').hidden = reader !== 'phone';
  $('audioNote').hidden = opts.length === 1;
  const tr = track();
  if (tr) { if (audio.src !== tr.url) audio.src = tr.url; }
  else if (audio.getAttribute('src')) { audio.removeAttribute('src'); audio.load(); }
}

function audioFrom(i) {
  gen++;
  pos = i;
  if (pos >= sents.length) { finish(); return; }
  store.set('pos', { date: brief.date, i: pos });
  renderPos(); mediaMeta();
  const t = track().paras[sents[pos].para] ?? 0;
  const go = () => { audio.currentTime = t; audio.playbackRate = rate; audio.play().catch(() => stop()); };
  audio.readyState >= 1 ? go() : audio.addEventListener('loadedmetadata', go, { once: true });
}
audio.addEventListener('timeupdate', () => {
  if (!track() || !audioLength()) return;
  $('prog').style.width = Math.min(100, audio.currentTime / audioLength() * 100) + '%';
  if (!playing) return;
  const k = paraAt(audio.currentTime);
  if (sents[pos]?.para !== k) {
    pos = sents.findIndex(s => s.para === k);
    store.set('pos', { date: brief.date, i: pos });
    renderPos(); mediaMeta();
  }
});
audio.addEventListener('ended', () => { if (track()) finish(); });
// Paused or resumed from outside the app (lock screen, headphones, a phone call)
audio.addEventListener('pause', () => { if (playing && track() && !audio.ended) { playing = false; setIcons(); } });
audio.addEventListener('play', () => { if (!playing && track()) { playing = true; setIcons(); } });

function mediaMeta() {
  if (!('mediaSession' in navigator) || !brief) return;
  const seg = (brief.segments || [])[(sents[pos] || {}).seg ?? 0];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: seg ? seg.title : 'Market Brief', artist: 'Market Brief',
    album: brief.kind === 'story' ? brief.headline : `${longDate(brief.date)} · ${brief.edition || 'Daily'} edition`,
    artwork: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }]
  });
}
if ('mediaSession' in navigator) {
  const on = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch {} };
  on('play', () => play());
  on('pause', () => stop());
  on('nexttrack', () => jumpSeg(1));
  on('previoustrack', () => jumpSeg(-1));
  on('seekbackward', d => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 15)); });
  on('seekforward', d => { audio.currentTime = Math.min(audioLength(), audio.currentTime + (d.seekOffset || 15)); });
  on('seekto', d => { audio.currentTime = d.seekTime; });
}

async function holdScreen() {
  try { if (navigator.wakeLock && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => wake = null); } } catch {}
}
function play() {
  if (!sents.length) return;
  playing = true; setIcons();
  const tr = track();
  if (!tr) { holdScreen(); speakFrom(pos >= sents.length ? 0 : pos); return; }
  // Resume mid-paragraph when the audio is already where we left it
  if (pos < sents.length && audio.currentTime > 0 && paraAt(audio.currentTime) === sents[pos].para) {
    audio.playbackRate = rate; audio.play().catch(() => stop()); mediaMeta(); renderPos();
  } else audioFrom(pos >= sents.length ? 0 : pos);
}
function stop() {
  playing = false; gen++; speechSynthesis.cancel(); audio.pause(); setIcons();
  if (wake) { wake.release().catch(() => {}); wake = null; }
}
function jumpSeg(d) {
  if (!sents.length) return;
  const cur = (sents[Math.min(pos, sents.length - 1)] || {}).seg ?? 0;
  const segStart = s => sents.findIndex(x => x.seg === s);
  let target = cur + d;
  if (d < 0 && pos > segStart(cur) + 1) target = cur;          // first press goes back to the start of this section
  const i = segStart(Math.max(0, target));
  goTo(i < 0 ? sents.length : i);
}
function goTo(i) { if (playing) speakFrom(i); else { pos = i; store.set('pos', { date: brief.date, i }); renderPos(); } }

function setIcons() {
  const p = playing ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="M7 4v16l13-8z"/>';
  $('playIcon').innerHTML = p; $('bigIcon').innerHTML = p;
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('onair').textContent = playing ? 'On air' : 'Off air';
  $('onair').classList.toggle('live', playing);
}

function showEmpty(title, text) {
  $('empty').innerHTML = `<b>${esc(title)}</b>${esc(text)}`; $('empty').hidden = false; $('start').hidden = true;
}

// Bulletins live in the repo: briefs/index.json lists them, briefs/<date>.json holds each one.
async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}
async function openDate(date) {
  try { showBrief(await getJSON(`./briefs/${date}.json`)); }
  catch { showEmpty("Couldn't open that bulletin", "Check your connection and try again. Bulletins you've opened before also work offline."); }
}
async function loadIndex() {
  try {
    const idx = await getJSON('./briefs/index.json');
    briefs = idx.briefs || [];
  } catch {
    $('edition').textContent = '';
    showEmpty("Couldn't load the bulletin", "Check your connection. Once you've opened a bulletin, it plays offline too.");
    return;
  }
  loadStories();
  if (view !== 'today') return;
  if (!briefs.length) { $('edition').textContent = ''; showEmpty("Today's bulletin isn't here yet", 'A fresh bulletin is written every morning at 7:30 AM.'); return; }
  if (playing) return;                                            // don't swap the edition mid-listen
  await openDate(briefs[0].date);
}

// Following: stories tracked from the beginning. stories/index.json lists them, stories/<slug>.json holds
// each one's summary, timeline (oldest first) and what to watch. A story plays like a bulletin.
let view = 'today';                   // 'today' | 'list' | 'story'
let stories = [];
const entryKey = e => e.date + '|' + e.title;
function unseen(st) {
  const seen = store.get('seen:' + st.slug, null);
  return seen ? (st.keys || []).filter(k => !seen.includes(k)).length : 0;
}
async function loadStories() {
  try { stories = (await getJSON('./stories/index.json')).stories || []; } catch { stories = []; }
  // A story seen for the first time starts with nothing marked new; later updates get the badge.
  stories.forEach(s => { if (!store.get('seen:' + s.slug, null)) store.set('seen:' + s.slug, s.keys || []); });
  const fresh = stories.filter(s => unseen(s) > 0).length;
  $('followCount').textContent = fresh; $('followCount').hidden = !fresh;
  if (view === 'list') renderStoryList();
}
function renderStoryList() {
  $('storyList').innerHTML = stories.length ? stories.map(s => {
    const u = unseen(s);
    return `<li><button class="story-card" data-slug="${esc(s.slug)}">
      <b>${esc(s.title)}${u ? `<span class="badge">${u} new</span>` : ''}</b>
      <span>${esc(s.latest || '')}</span>
      <small>Since ${esc(longYear(s.started))} · ${s.entries} updates · last on ${esc(shortDate(s.lastDate))}</small>
    </button></li>`;
  }).join('') : '<li class="empty"><b>No stories yet</b>Ask Claude to track a story and it will appear here.</li>';
}
function longYear(d) { return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); }

function storyAsBrief(st) {
  const seen = store.get('seen:' + st.slug, null);
  const timeline = st.timeline || [];
  return {
    kind: 'story', date: 'story-' + st.slug, headline: st.title,
    byline: `Followed since ${longYear(st.started)} · ${timeline.length} updates · last on ${shortDate(timeline.length ? timeline[timeline.length - 1].date : st.started)}`,
    segments: [
      { title: 'The story so far', script: st.summary || '', stories: [] },
      ...timeline.map(e => ({ title: `${longYear(e.date)} · ${e.title}`, script: e.text, stories: e.sources || [],
                              isNew: !!seen && !seen.includes(entryKey(e)) })),
      { title: 'What to watch', script: st.watch || '', stories: [] }
    ].filter(s => s.script)
  };
}
async function openStory(slug) {
  try {
    const st = await getJSON(`./stories/${slug}.json`);
    view = 'story'; setView();
    showBrief(storyAsBrief(st));
    store.set('seen:' + slug, (st.timeline || []).map(entryKey));
    loadStories();
    scrollTo(0, 0);
  } catch { showEmpty("Couldn't open that story", 'Check your connection and try again.'); }
}
function setView() {
  $('tabToday').setAttribute('aria-pressed', view === 'today');
  $('tabFollow').setAttribute('aria-pressed', view !== 'today');
  $('followView').hidden = view !== 'list';
  $('readerView').hidden = view === 'list';
  $('backBtn').hidden = view !== 'story';
}
$('tabToday').onclick = () => { if (view === 'today') return; stop(); view = 'today'; setView(); loadIndex(); scrollTo(0, 0); };
$('tabFollow').onclick = () => { if (view !== 'story') stop(); view = 'list'; setView(); renderStoryList(); loadStories(); scrollTo(0, 0); };
$('backBtn').onclick = () => $('tabFollow').onclick();
$('storyList').onclick = e => { const c = e.target.closest('.story-card'); if (c) { stop(); openStory(c.dataset.slug); } };

$('play').onclick = $('bigPlay').onclick = () => playing ? stop() : play();
$('next').onclick = () => jumpSeg(1);
$('prev').onclick = () => jumpSeg(-1);
$('rate').onclick = () => {
  rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length]; store.set('rate', rate);
  $('rate').textContent = rate + '×';
  if (track()) audio.playbackRate = rate; else if (playing) speakFrom(pos);
};
$('reader').onchange = () => {
  const was = playing; stop();
  store.set('reader', $('reader').value); fillReaders(); renderPos();
  if (was) play();
};
$('voice').onchange = () => { store.set('voice', $('voice').value); if (playing) speakFrom(pos); };
$('accent').onchange = () => {
  accent = $('accent').value; store.set('accent', accent); store.remove('voice');
  fillVoices(); if (playing) speakFrom(pos);
};
$('rundown').onclick = e => {
  if (e.target.closest('a, summary')) return;
  const s = e.target.closest('.s');
  const h = e.target.closest('.seg-head');
  const i = s ? +s.dataset.i : h ? sents.findIndex(x => x.seg === +h.dataset.seg) : -1;
  if (i < 0) return;
  if (!playing) { playing = true; setIcons(); if (!track()) holdScreen(); }
  speakFrom(i);
};
$('editions').onclick = e => { const b = e.target.closest('.ed'); if (b) openDate(b.dataset.date); };
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (playing) holdScreen(); else loadIndex();                   // pick up a new morning bulletin when reopened
});

// ---------- 2. Storage helpers ----------
const STORE_PREFIX = 'market-brief:';
const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(STORE_PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value)); return true; }
    catch { return false; }
  },
  remove(key) { try { localStorage.removeItem(STORE_PREFIX + key); } catch {} }
};

rate = store.get('rate', 1);
if (!RATES.includes(rate)) rate = 1;
$('rate').textContent = rate + '×';
accent = ACCENTS[store.get('accent', 'en-IN')] ? store.get('accent', 'en-IN') : 'en-IN';
$('accent').innerHTML = Object.entries(ACCENTS).map(([k, n]) => `<option value="${k}"${k === accent ? ' selected' : ''}>${n}</option>`).join('');
speechSynthesis.onvoiceschanged = fillVoices;
fillVoices();
loadIndex();

// ---------- 3. PWA plumbing ----------
const APP_VERSION = '1.3.0';
const versionLabel = document.getElementById('versionLabel');
if (versionLabel) versionLabel.textContent = `Version ${APP_VERSION}`;

// 3a. Register the service worker (relative path: works under /market-brief/)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });

      // A new version was found while the app is open → show the update bar
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar(reg);
        });
      });
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateBar(reg);

      // Check for updates each time the app comes back to the foreground
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    } catch (err) {
      console.warn('Service worker registration failed:', err);
    }
  });

  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}

function showUpdateBar(reg) {
  const bar = document.getElementById('updateBar');
  const btn = document.getElementById('reloadBtn');
  if (!bar || !btn) return;
  bar.hidden = false;
  btn.onclick = () => reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
}

// 3b. Install button (Android/desktop Chrome & Edge; iPhone uses Share → Add to Home Screen)
let deferredPrompt = null;
const installBtn = document.getElementById('installBtn');
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  if (installBtn) installBtn.hidden = false;
});
installBtn?.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  installBtn.hidden = true;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
});
window.addEventListener('appinstalled', () => { if (installBtn) installBtn.hidden = true; });

// 3c. Offline bar
const offlineBar = document.getElementById('offlineBar');
const syncOnline = () => { if (offlineBar) offlineBar.hidden = navigator.onLine; };
window.addEventListener('online', syncOnline);
window.addEventListener('offline', syncOnline);
syncOnline();
