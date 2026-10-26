/* Solo Spot Lab: compare solo transitions (jump vs. vocal-removed preview loop). */
(function () {
  'use strict';
  const C = window.SoloCore;
  const D = window.SoloDSP;
  const $ = (id) => document.getElementById(id);
  const enc = encodeURIComponent;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const VER = (document.currentScript && (document.currentScript.src.match(/v=(\w+)/) || [])[1]) || '1';

  const S = {
    token: 0, vid: null, query: null, lyrics: null, segs: null, lrcDur: 0,
    pv: null, period: 0, beats: [], align: null, songChorus: null, prevOnset: null, onsetFromAI: false,
    loopLen: 0, w0: 0, w1: 0, buf: {}, shift: 0, taps: [], phase: null, steps: {}, aiDone: false,
  };

  // ---------- log + steps ----------
  const logLines = [];
  function log(s) {
    const t = new Date().toISOString().slice(14, 23);
    logLines.push(t + ' ' + s);
    if (logLines.length > 200) logLines.shift();
    $('log').textContent = logLines.join('\n');
  }
  const ORDER = ['song', 'lyrics', 'preview', 'chorus', 'ai'];
  const LABEL = { song: 'Song', lyrics: 'Vocal timing', preview: 'Preview audio', chorus: 'Chorus bars', ai: 'AI vocal removal' };
  function step(k, status, text) {
    S.steps[k] = { status, text };
    const ul = $('steps');
    ul.textContent = '';
    for (const key of ORDER) {
      const s = S.steps[key];
      if (!s) continue;
      const li = document.createElement('li');
      li.className = s.status;
      li.append(LABEL[key] + ': ');
      const sp = document.createElement('span');
      sp.textContent = s.text || '';
      li.append(sp);
      ul.append(li);
    }
  }
  function dock(text, state) {
    $('dockText').textContent = text;
    $('led').className = 'led' + (state ? ' ' + state : '');
  }

  // ---------- audio ----------
  let ctx = null;
  function audio() {
    if (!ctx) {
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch (e) {}
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC({ latencyHint: 'interactive' });
      log('audio ready, base latency ' + Math.round((ctx.baseLatency || 0) * 1000) + ' ms');
    }
    if (ctx.state !== 'running') ctx.resume();
    return ctx;
  }
  function toBuffer(L, R, sr) {
    const b = audio().createBuffer(2, L.length, sr);
    b.copyToChannel(L, 0);
    b.copyToChannel(R, 1);
    return b;
  }
  let playing = null;
  function stopAudio(at) {
    if (!playing) return;
    const p = playing;
    playing = null;
    const t = at == null ? ctx.currentTime : at;
    try {
      p.gain.gain.cancelScheduledValues(t);
      p.gain.gain.setValueAtTime(p.gain.gain.value, t);
      p.gain.gain.linearRampToValueAtTime(0, t + 0.012);
      p.src.stop(t + 0.02);
    } catch (e) {}
  }
  // play the loop: starts at context time `when`, `loops` times through
  function bufOf(kind) {
    return S.buf[kind] ? S.buf[kind].buffer : null;
  }
  function playLoop(kind, when, loops) {
    const buf = bufOf(kind);
    if (!buf) return null;
    const c = audio();
    stopAudio();
    const src = c.createBufferSource();
    src.buffer = buf;
    const start = loopStart() - S.w0;
    src.loop = true;
    src.loopStart = start;
    src.loopEnd = start + S.loopLen;
    const gain = c.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(1, when + 0.006);
    src.connect(gain).connect(c.destination);
    src.start(when, start);
    const end = when + S.loopLen * loops;
    gain.gain.setValueAtTime(1, end);
    gain.gain.linearRampToValueAtTime(0, end + 0.012);
    src.stop(end + 0.03);
    playing = { src, gain, when, end, loops, kind };
    src.onended = () => { if (playing && playing.src === src) playing = null; };
    return playing;
  }
  // map a wall-clock time (ms since epoch) to audio-context time
  function ctxTimeAt(epochMs) {
    return audio().currentTime + (epochMs - Date.now()) / 1000;
  }

  function loopStart() {
    if (S.prevOnset == null) return 0;
    // nearest beat of the preview's grid to the chorus's first sung note, plus the user's shift
    let best = S.prevOnset;
    let bd = Infinity;
    for (const b of S.beats) {
      const d = Math.abs(b - S.prevOnset);
      if (d < bd) { bd = d; best = b; }
    }
    return best + S.shift * S.period;
  }

  // ---------- YouTube ----------
  const yt = { player: null, ready: false, state: -1, anchor: null, dur: 0, created: false, lastSeek: null, delay: 0.15, rate: 1 };
  function loadYT() {
    return new Promise((resolve) => {
      if (window.YT && window.YT.Player) return resolve();
      window.onYouTubeIframeAPIReady = resolve;
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    });
  }
  function setAnchor(ct, wall) {
    const now = Date.now();
    if (!(wall > 0) || Math.abs(wall - now) > 3000) wall = now;
    yt.anchor = { ct, wall, real: true };
    const J = yt.lastSeek;
    if (J && !J.done && yt.state === 1 && wall > J.t + 700 && wall < J.t + 4000) {
      const d = (wall - J.t) / 1000 - (ct - J.target);
      J.done = true;
      if (d > 0.005 && d < 0.8) {
        yt.delay = yt.delay * 0.5 + d * 0.5;
        log('seek delay measured ' + Math.round(d * 1000) + ' ms (estimate now ' + Math.round(yt.delay * 1000) + ')');
      }
    }
  }
  function posNow(atEpoch) {
    const a = yt.anchor;
    if (!a) return 0;
    const w = atEpoch == null ? Date.now() : atEpoch;
    return yt.state === 1 ? a.ct + Math.max(0, Math.min(2, (w - a.wall) / 1000)) * (yt.rate || 1) : a.ct;
  }
  function wallWhenPos(pos) {
    const a = yt.anchor;
    return a.wall + ((pos - a.ct) * 1000) / (yt.rate || 1);
  }
  window.addEventListener('message', (e) => {
    if (!yt.player || !yt.player.getIframe) return;
    let ifr;
    try { ifr = yt.player.getIframe(); } catch (err) { return; }
    if (!ifr || e.source !== ifr.contentWindow) return;
    let d = e.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (err) { return; } }
    if (!d || d.event !== 'infoDelivery' || !d.info) return;
    const i = d.info;
    if (typeof i.playerState === 'number') yt.state = i.playerState;
    if (typeof i.playbackRate === 'number' && i.playbackRate > 0) yt.rate = i.playbackRate;
    if (typeof i.duration === 'number' && i.duration > 0) yt.dur = i.duration;
    if (typeof i.currentTime === 'number') setAnchor(i.currentTime, typeof i.currentTimeLastUpdated_ === 'number' ? i.currentTimeLastUpdated_ * 1000 : Date.now());
  });
  setInterval(() => {
    if (!yt.ready) return;
    try {
      yt.state = yt.player.getPlayerState();
      if (!yt.anchor || Date.now() - yt.anchor.wall > 1200) setAnchor(yt.player.getCurrentTime(), Date.now());
      const du = yt.player.getDuration();
      if (du > 0) yt.dur = du;
    } catch (e) {}
  }, 250);
  async function showVideo(id) {
    await loadYT();
    if (!yt.created) {
      yt.created = true;
      yt.player = new YT.Player('player', {
        videoId: id,
        playerVars: { playsinline: 1, rel: 0, origin: location.origin },
        events: {
          onReady: () => { yt.ready = true; },
          onStateChange: (e) => { yt.state = e.data; try { setAnchor(yt.player.getCurrentTime(), Date.now()); } catch (x) {} },
          onError: (e) => log('YouTube error ' + e.data),
        },
      });
      for (let i = 0; i < 40 && !yt.ready; i++) await sleep(100);
    } else yt.player.cueVideoById(id);
  }
  function ytSeek(t) {
    yt.player.seekTo(Math.max(0, t), true);
    yt.lastSeek = { t: Date.now(), target: Math.max(0, t), done: false };
    yt.anchor = { ct: Math.max(0, t), wall: Date.now() + yt.delay * 1000, real: false };
  }
  function setRate(r) {
    try { yt.player.setPlaybackRate(r); } catch (e) {}
    yt.rate = r;
    if (yt.anchor) yt.anchor = { ct: posNow(), wall: Date.now(), real: false };
  }

  // ---------- network ----------
  async function getJSON(url, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || 12000);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- load + analyze ----------
  async function load(link) {
    const p = C.parseYouTubeId(link || 'dQw4w9WgXcQ');
    if (!p) { step('song', 'bad', "That isn't a YouTube link."); return; }
    const token = ++S.token;
    Object.assign(S, { vid: p.id, query: null, lyrics: null, segs: null, pv: null, beats: [], align: null, songChorus: null, prevOnset: null, onsetFromAI: false, buf: {}, shift: 0, taps: [], phase: null, steps: {}, aiDone: false });
    $('aiPlay').disabled = true;
    $('aiTry').disabled = true;
    $('aiBar').hidden = true;
    $('shiftVal').textContent = '0 beats';
    $('syncState').textContent = 'Not synced yet.';
    const live = () => token === S.token;
    step('song', 'busy', 'loading…');
    await showVideo(p.id);
    let meta = null;
    try {
      const j = await getJSON('https://www.youtube.com/oembed?format=json&url=' + enc('https://www.youtube.com/watch?v=' + p.id));
      meta = { title: j.title, author: j.author_name };
    } catch (e) {}
    if (!live()) return;
    if (!meta) { step('song', 'bad', "couldn't read the video title"); return; }
    S.query = C.cleanTitle(meta.title, meta.author);
    step('song', 'ok', S.query.artist + ' – ' + S.query.track);
    for (let i = 0; i < 12 && !yt.dur; i++) await sleep(250);
    // lyrics + preview in parallel
    step('lyrics', 'busy', 'looking…');
    step('preview', 'busy', 'downloading…');
    const pL = (async () => {
      const res = await getJSON('https://lrclib.net/api/search?q=' + enc(S.query.artist + ' ' + S.query.track));
      const pick = C.pickLyrics(res, S.query.artist, S.query.track, yt.dur);
      if (!pick || !pick.syncedLyrics) throw new Error('no synced lyrics');
      return pick;
    })();
    const pP = (async () => {
      const j = await getJSON('https://itunes.apple.com/search?media=music&entity=song&limit=10&term=' + enc(S.query.artist + ' ' + S.query.track));
      const it = (j.results || []).find((r) => C.similarity(C.stripJunk(r.trackName), S.query.track) >= 0.5 && C.similarity(r.artistName, S.query.artist) >= 0.4 && !/\blive\b/i.test(r.trackName)) || (j.results || [])[0];
      if (!it || !it.previewUrl) throw new Error('no preview');
      const buf = await (await fetch(it.previewUrl)).arrayBuffer();
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const ab = await new Promise((res, rej) => { const pr = new OAC(2, 44100, 44100).decodeAudioData(buf, res, rej); if (pr && pr.then) pr.then(res, rej); });
      const L = ab.getChannelData(0).slice();
      const R = (ab.numberOfChannels > 1 ? ab.getChannelData(1) : ab.getChannelData(0)).slice();
      return { L, R, sr: ab.sampleRate, dur: ab.duration };
    })();
    let lyr = null, pv = null;
    try { lyr = await pL; S.lyrics = lyr; S.lrcDur = lyr.duration; S.segs = C.vocalSegments(C.parseLRC(lyr.syncedLyrics), lyr.duration); step('lyrics', 'ok', S.segs.length + ' sung lines'); } catch (e) { step('lyrics', 'bad', String(e.message || e)); }
    try { pv = await pP; S.pv = pv; step('preview', 'ok', pv.dur.toFixed(0) + ' s, ' + (pv.L === pv.R ? 'mono' : 'stereo')); } catch (e) { step('preview', 'bad', String(e.message || e)); }
    if (!live() || !pv) return;
    if (yt.dur && S.lrcDur && Math.abs(yt.dur - S.lrcDur) > 2.5) log('warning: video length ' + yt.dur + ' s vs lyric timing ' + S.lrcDur + ' s');
    analyzePreview(token);
  }

  async function analyzePreview(token) {
    const live = () => token === S.token;
    const { L, R, sr } = S.pv;
    step('chorus', 'busy', 'finding the beat…');
    await sleep(20);
    const m = D.mono(L, R);
    const tp = C.tempoFromPCM(m, sr);
    const bpm = C.foldTempo(tp.bpm);
    const ons = D.onsets(m, sr);
    const tb = D.trackBeats(ons.env, ons.rate, bpm, ons.latency);
    S.period = tb.period;
    S.beats = tb.beats;
    log('preview tempo ' + tb.bpm.toFixed(2) + ' BPM');
    let bars = 4;
    if (bars * 4 * S.period > 13) bars = 2;
    S.loopLen = bars * 4 * S.period;
    // where in the song is this preview? match its singing against the lyric timing
    let onsetCoarse = null;
    let runN = null;
    if (S.segs && S.segs.length) {
      const va = D.vocalActivity(L, R, sr);
      const al = D.alignToLyrics(va.activity, va.rate, S.segs, S.lrcDur);
      S.align = al;
      const sec = C.sections(S.segs);
      const runs = sec.runs.map((r) => ({ n: r.n, t: S.segs[r.first].start }));
      log('preview matches song at ' + al.slice(0, 3).map((a) => a.offset.toFixed(1) + 's (r ' + a.r.toFixed(2) + ')').join(', ') + '; choruses at ' + runs.map((r) => r.t.toFixed(1)).join(', '));
      // the solo goes right before the last chorus that starts past the halfway point
      const late = sec.runs.filter((r) => S.segs[r.first].start > S.lrcDur * 0.5);
      const targetRun = late.length ? late[late.length - 1] : sec.runs[sec.runs.length - 1];
      S.songChorus = targetRun ? S.segs[targetRun.first].start : null;
      // in the preview, find the same sung line (choruses repeat, any copy works)
      const norm = targetRun ? S.segs[targetRun.first].norm : null;
      for (const a of al) {
        for (let j = 0; j < S.segs.length && norm; j++) {
          if (S.segs[j].norm !== norm) continue;
          const cp = S.segs[j].start - a.offset;
          if (cp >= 1.2 && cp + S.loopLen + 0.6 <= S.pv.dur) { onsetCoarse = cp; runN = targetRun.n; break; }
        }
        if (onsetCoarse != null) break;
      }
      if (onsetCoarse == null && al.length) {
        for (let i = 0; i < S.segs.length && onsetCoarse == null; i++) {
          if (!sec.isChorus[i]) continue;
          const cp = S.segs[i].start - al[0].offset;
          if (cp >= 1.2 && cp + S.loopLen + 0.6 <= S.pv.dur) onsetCoarse = cp;
        }
      }
    }
    if (onsetCoarse == null) onsetCoarse = Math.min(2, S.pv.dur - S.loopLen - 1);
    S.prevOnset = onsetCoarse;
    const songTxt = S.songChorus != null ? C.fmtTime(S.songChorus) : '?';
    step('chorus', 'ok', bars + '-bar loop from ' + onsetCoarse.toFixed(1) + ' s into the preview' + (runN ? ' (chorus)' : '') + '; solo spot at ' + songTxt);
    $('loopInfo').textContent = 'The ' + bars + ' chorus bars that will play under your solo (' + S.loopLen.toFixed(1) + ' s), looped twice.';
    $('spotInfo').textContent = 'The solo goes in right before the chorus at ' + songTxt + '. Each button starts the video a few seconds before it.';
    // the window we process: loop plus room to shift by a couple of beats
    S.w0 = Math.max(0, onsetCoarse - 1.5 - 2 * S.period);
    S.w1 = Math.min(S.pv.dur, onsetCoarse + S.loopLen + 1.2 + 2 * S.period);
    const a = Math.floor(S.w0 * sr), b = Math.floor(S.w1 * sr);
    const segL = L.slice(a, b), segR = R.slice(a, b);
    S.buf.orig = toBufferLazy(segL, segR, sr);
    await sleep(20);
    const q = D.centerRemove(segL, segR, sr);
    if (!live()) return;
    S.buf.quick = toBufferLazy(q.L, q.R, sr);
    log('quick removal done');
    runAI(token, segL, segR, sr);
  }

  // AudioBuffers need an AudioContext, which iOS only allows after a tap; build them on first use
  function toBufferLazy(L, R, sr) {
    return { L, R, sr, get buffer() { return this._b || (this._b = toBuffer(this.L, this.R, this.sr)); } };
  }

  let worker = null;
  function runAI(token, segL, segR, sr) {
    const live = () => token === S.token;
    step('ai', 'busy', 'getting ready…');
    $('aiBar').hidden = false;
    if (!worker) worker = new Worker('sep-worker.js?v=' + VER);
    const t0 = Date.now();
    worker.onmessage = (e) => {
      const m = e.data;
      if (!live()) return;
      if (m.type === 'progress') {
        let frac = 0, txt = '';
        if (m.stage === 'download') { frac = m.frac * 0.3; txt = m.cached ? 'model ready (cached)' : 'downloading model ' + Math.round(m.frac * 100) + '%'; }
        else if (m.stage === 'prepare') { frac = 0.32; txt = 'starting the model…'; }
        else if (m.stage === 'separate') { frac = 0.32 + 0.68 * (m.done / m.total); txt = 'separating ' + m.done + ' of ' + m.total + ' (' + (m.engine === 'webgpu' ? 'graphics chip' : 'processor') + ')'; log('AI chunk ' + m.done + '/' + m.total + ' ' + m.ms + ' ms on ' + m.engine); }
        $('aiBar').firstElementChild.style.width = Math.round(frac * 100) + '%';
        $('aiState').textContent = txt;
        step('ai', 'busy', txt);
      } else if (m.type === 'done') {
        S.buf.ai = toBufferLazy(m.instL, m.instR, sr);
        S.aiDone = true;
        // sharpen where the chorus's first note is, using the separated vocals
        const refined = vocalOnset(m.vocL, m.vocR, sr, S.prevOnset - S.w0);
        if (refined != null) {
          log('chorus first note: ' + S.prevOnset.toFixed(3) + ' s -> ' + (refined + S.w0).toFixed(3) + ' s (from separated vocals)');
          S.prevOnset = refined + S.w0;
          S.onsetFromAI = true;
        }
        const secs = ((Date.now() - t0) / 1000).toFixed(0);
        step('ai', 'ok', 'done in ' + secs + ' s on the ' + (m.engine === 'webgpu' ? 'graphics chip' : 'processor'));
        $('aiState').textContent = 'Ready';
        $('aiPlay').disabled = false;
        $('aiTry').disabled = false;
        $('aiBar').hidden = true;
      } else if (m.type === 'error') {
        step('ai', 'bad', m.message);
        $('aiState').textContent = 'Failed: ' + m.message;
        log('AI error ' + m.message);
      }
    };
    worker.onerror = (e) => { step('ai', 'bad', e.message || 'worker failed'); log('worker error ' + (e.message || '')); };
    worker.postMessage({ type: 'separate', id: token, L: segL, R: segR, gpu: true });
  }

  // first strong rise of vocal energy within ±0.7 s of a guess
  function vocalOnset(vL, vR, sr, guess) {
    const hop = Math.round(sr * 0.01);
    const n = Math.floor(vL.length / hop);
    const e = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = i * hop; j < (i + 1) * hop; j++) s += vL[j] * vL[j] + vR[j] * vR[j];
      e[i] = s;
    }
    const sm = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) { s += e[j]; c++; } sm[i] = Math.log(1e-9 + s / c); }
    const g = Math.round(guess / 0.01);
    let best = null, bv = -Infinity;
    for (let i = Math.max(5, g - 70); i <= Math.min(n - 6, g + 70); i++) {
      const rise = sm[i + 5] - sm[i - 5];
      if (rise > bv) { bv = rise; best = i; }
    }
    return best == null || bv < 1.0 ? null : best * 0.01;
  }

  // ---------- sync taps ----------
  function onTap(ev) {
    ev.preventDefault();
    audio();
    if (!yt.anchor || yt.state !== 1) { $('syncState').textContent = 'Start the video first, then tap along.'; return; }
    if (!S.period) { $('syncState').textContent = 'Still analyzing the song. Try again in a moment.'; return; }
    const wall = Date.now() - (performance.now() - ev.timeStamp);
    const pos = posNow(wall) - 0.02; // allow ~20 ms for the touch to register
    const bar = 4 * S.period;
    if (S.taps.length && Math.abs(pos - S.taps[S.taps.length - 1]) > 4 * bar) S.taps = [];
    S.taps.push(pos);
    if (S.taps.length > 8) S.taps.shift();
    const n = S.taps.length;
    if (n < 4) { $('syncState').textContent = n + ' of 4 taps…'; return; }
    // circular mean of tap positions within the bar
    let sx = 0, sy = 0;
    for (const t of S.taps) { const a = (2 * Math.PI * t) / bar; sx += Math.cos(a); sy += Math.sin(a); }
    const mean = (((Math.atan2(sy, sx) / (2 * Math.PI)) * bar) % bar + bar) % bar;
    const devs = S.taps.map((t) => { let d = ((t - mean) % bar + bar) % bar; if (d > bar / 2) d -= bar; return d; });
    const spread = Math.sqrt(devs.reduce((s, d) => s + d * d, 0) / n);
    S.phase = mean;
    $('syncState').textContent = 'Synced from ' + n + ' taps (steadiness ±' + Math.round(spread * 1000) + ' ms).' + (spread > 0.06 ? ' A bit uneven, keep tapping to improve it.' : ' Good.');
    log('sync phase ' + mean.toFixed(3) + ' s, spread ' + Math.round(spread * 1000) + ' ms');
  }

  // the song time where the solo goes: the beat nearest the chorus's first sung note
  function soloPoint() {
    if (S.songChorus == null) return null;
    const t = S.songChorus;
    if (S.phase == null) return t;
    const beat = S.period;
    const k = Math.round((t - S.phase) / beat);
    return S.phase + k * beat;
  }

  // ---------- transitions ----------
  let run = null;
  function stopAll() {
    if (run) run.cancel = true;
    run = null;
    if (ctx) stopAudio();
    try { yt.player.unMute(); } catch (e) {}
    try { if (yt.rate !== 1) setRate(1); } catch (e) {}
    dock('Stopped', '');
  }

  async function tryTransition(kind) {
    const c = audio();
    stopAll();
    const Se = soloPoint();
    if (Se == null) { dock('No solo spot found for this song', ''); return; }
    if (kind !== 'jump' && !S.buf[kind]) { dock('That version is not ready yet', ''); return; }
    const me = { cancel: false };
    run = me;
    const bars = Math.round(S.loopLen / (4 * S.period));
    const loops = 2;
    const lead = Math.max(6, 2 * 4 * S.period + 1);
    log('try ' + kind + ': solo point ' + Se.toFixed(3) + ' s' + (S.phase == null ? ' (not synced: using lyric timing)' : ''));
    try { yt.player.unMute(); } catch (e) {}
    ytSeek(Se - lead);
    yt.player.playVideo();
    dock('Solo in ' + Math.round(lead) + ' s', 'wait');
    // wait for steady playback
    for (let i = 0; i < 60 && !me.cancel; i++) {
      await sleep(100);
      if (yt.state === 1 && yt.anchor && Date.now() - yt.lastSeek.t > 900) break;
    }
    if (me.cancel) return;
    // countdown until ~300 ms before the solo point
    for (;;) {
      if (me.cancel) return;
      const Ws = wallWhenPos(Se);
      const left = Ws - Date.now();
      dock('Solo in ' + Math.max(0, left / 1000).toFixed(1) + ' s', 'wait');
      if (left < 320) break;
      await sleep(Math.min(100, left - 300));
    }
    const Ws = wallWhenPos(Se);
    if (kind === 'jump') {
      // the current app's method: jump back inside the video by the loop length
      await sleep(Math.max(0, Ws - Date.now() - 45));
      const aPrime = Se - posNow();
      const target = Se - S.loopLen + yt.delay - aPrime;
      ytSeek(target);
      log('jump at ' + posNow().toFixed(3) + ' -> ' + target.toFixed(3));
      soloDock(Date.now(), S.loopLen, bars, me);
      return;
    }
    // vocal-removed loop: start the backing exactly when the video reaches the solo point
    const tStart = ctxTimeAt(Ws);
    const p = playLoop(kind, tStart, loops);
    const muteAt = Ws - 8;
    await sleep(Math.max(0, muteAt - Date.now()));
    if (me.cancel) return;
    yt.player.mute();
    log('backing in at ' + posNow().toFixed(3) + ' (target ' + Se.toFixed(3) + ')');
    soloDock(Ws, S.loopLen * loops, bars * loops, me);
    await sleep(200);
    yt.player.pauseVideo();
    // line the (muted) video back up so it reaches the solo point exactly when the backing ends
    const Wx = Ws + (p.end - p.when) * 1000;
    await landAt(Se, Wx, me);
    if (me.cancel) return;
    await sleep(Math.max(0, Wx - Date.now() - 15));
    if (me.cancel) return;
    yt.player.unMute();
    log('vocals back in');
  }

  // Get the muted video to be exactly at song time `pos` at wall time `W`.
  // A rough jump first, then small speed nudges (0.75x / 1.25x) to land on the beat.
  async function landAt(pos, W, me) {
    const runway = 4.5;
    await sleep(Math.max(0, W - Date.now() - (runway + 0.8) * 1000));
    if (me.cancel) return;
    setRate(1);
    ytSeek(pos - (W - Date.now()) / 1000 + yt.delay);
    yt.player.playVideo();
    let lastAction = Date.now();
    let settled = false;
    for (;;) {
      if (me.cancel) return;
      await sleep(40);
      const left = (W - Date.now()) / 1000;
      if (left < 0.12) break;
      const a = yt.anchor;
      // only trust a real report that arrived after our last action
      if (yt.state !== 1 || !a || !a.real || a.wall < lastAction + 250 || yt.rate !== 1) continue;
      const predicted = a.ct + (W - a.wall) / 1000;
      const err = predicted - pos; // positive: video is ahead
      if (Math.abs(err) <= 0.008) {
        if (!settled) log('landing locked: ' + Math.round(err * 1000) + ' ms with ' + left.toFixed(1) + ' s to spare');
        settled = true;
        continue;
      }
      settled = false;
      if (Math.abs(err) > 0.2 && left > 1.6) {
        const target = pos - (W - Date.now()) / 1000 + yt.delay;
        log('landing: off by ' + Math.round(err * 1000) + ' ms, jumping');
        ytSeek(target);
        lastAction = Date.now() + yt.delay * 1000;
      } else if (left > 4 * Math.abs(err) + 0.35) {
        const r = err > 0 ? 0.75 : 1.25;
        const dur = 4 * Math.abs(err);
        log('landing: off by ' + Math.round(err * 1000) + ' ms, playing at ' + r + 'x for ' + Math.round(dur * 1000) + ' ms');
        setRate(r);
        await sleep(dur * 1000);
        setRate(1);
        lastAction = Date.now();
      } else {
        log('landing: out of time, ' + Math.round(err * 1000) + ' ms off');
        break;
      }
    }
    const a = yt.anchor;
    if (a && a.real) log('final check: ' + Math.round((a.ct + (W - a.wall) / 1000 - pos) * 1000) + ' ms from the beat');
  }

  function soloDock(startWall, length, bars, me) {
    const barLen = length / bars;
    const tick = () => {
      if (me.cancel) return;
      const el = (Date.now() - startWall) / 1000;
      if (el < 0) { requestAnimationFrame(tick); return; }
      if (el >= length) { dock('Vocals back', ''); return; }
      dock('Solo · bar ' + (Math.floor(el / barLen) + 1) + ' of ' + bars, 'live');
      setTimeout(tick, 50);
    };
    tick();
  }

  // ---------- events ----------
  $('loadBtn').addEventListener('click', () => { audio(); load($('link').value.trim()); });
  $('link').addEventListener('keydown', (e) => { if (e.key === 'Enter') { audio(); load($('link').value.trim()); } });
  document.querySelectorAll('[data-play]').forEach((b) => b.addEventListener('click', () => {
    const kind = b.dataset.play;
    if (!bufOf(kind)) { dock('Not ready yet', ''); return; }
    try { yt.player.pauseVideo(); } catch (e) {}
    const c = audio();
    playLoop(kind, c.currentTime + 0.08, 2);
    const bars = Math.round(S.loopLen / (4 * S.period)) * 2;
    soloDock(Date.now() + 80, S.loopLen * 2, bars, { cancel: false });
    log('listen ' + kind + ' from ' + loopStart().toFixed(3) + ' s');
  }));
  document.querySelectorAll('[data-try]').forEach((b) => b.addEventListener('click', () => tryTransition(b.dataset.try)));
  $('shiftL').addEventListener('click', () => { S.shift--; $('shiftVal').textContent = S.shift + (Math.abs(S.shift) === 1 ? ' beat' : ' beats'); });
  $('shiftR').addEventListener('click', () => { S.shift++; $('shiftVal').textContent = (S.shift > 0 ? '+' : '') + S.shift + (Math.abs(S.shift) === 1 ? ' beat' : ' beats'); });
  $('stopBtn').addEventListener('click', stopAll);
  $('stopBtn2').addEventListener('click', stopAll);
  $('tapBtn').addEventListener('pointerdown', onTap);

  window.__lab = { S, yt, tryTransition, load, soloPoint, loopStart, posNow };
  load('');
})();
