/* Solo Spot app: YouTube player, lookups, AI backing track, solo engine, UI.
   Depends on core.js (SoloCore) and dsp.js (SoloDSP). */
(function () {
  'use strict';
  const C = window.SoloCore;
  const D = window.SoloDSP;
  const $ = (id) => document.getElementById(id);
  const enc = encodeURIComponent;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const VER = (document.currentScript && (document.currentScript.src.match(/v=(\w+)/) || [])[1]) || '1';
  const TEST = /[?&]test=1/.test(location.search);

  // ---------- storage (best effort) ----------
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem('solospot:' + k);
        return v == null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem('solospot:' + k, JSON.stringify(v));
      } catch (e) {}
    },
    del(k) {
      try {
        localStorage.removeItem('solospot:' + k);
      } catch (e) {}
    },
  };

  // ---------- state ----------
  const A = {
    token: 0,
    vid: null,
    meta: null,
    query: null,
    lyrics: null,
    lyricResults: null,
    segs: null,
    itunes: null,
    deezer: null,
    ab: null,
    pv: null, // Apple preview, stereo {L, R, sr, dur, url}
    previewFeats: [],
    keyResult: null,
    tempo: null, // {bpm, period, beats}
    backing: null, // ready backing: see prepareBacking
    unsupported: null, // reason text when this song can't get a solo
    progress: null, // {frac, text}
    steps: {},
    S: {},
  };
  const DEF = () => ({ key: null, bars: store.get('bars', 8), spot: null, shift: 0, fine: 0 });
  function saveS() {
    if (A.vid) store.set('v:' + A.vid, A.S);
  }

  // ---------- network ----------
  async function fetchJSON(url, ms) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctl && ctl.abort(), ms || 12000);
    try {
      const r = await fetch(url, ctl ? { signal: ctl.signal } : undefined);
      if (!r.ok) {
        const e = new Error('HTTP ' + r.status);
        e.status = r.status;
        throw e;
      }
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }
  function jsonp(url, ms) {
    return new Promise((resolve, reject) => {
      const cb = '__ss' + Math.random().toString(36).slice(2);
      const s = document.createElement('script');
      const done = () => {
        clearTimeout(timer);
        try {
          delete window[cb];
        } catch (e) {
          window[cb] = undefined;
        }
        s.remove();
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error('timeout'));
      }, ms || 10000);
      window[cb] = (d) => {
        done();
        resolve(d);
      };
      s.onerror = () => {
        done();
        reject(new Error('load error'));
      };
      s.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'output=jsonp&callback=' + cb;
      document.head.appendChild(s);
    });
  }

  // ---------- sound (Web Audio) ----------
  let ctx = null;
  function audio() {
    if (!ctx) {
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch (e) {}
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC({ latencyHint: 'interactive' });
    }
    if (ctx.state !== 'running') {
      try {
        ctx.resume();
      } catch (e) {}
    }
    return ctx;
  }
  const soundReady = () => !!ctx && ctx.state === 'running';
  // iPhone only lets a page make sound after a tap on the page itself
  ['pointerdown', 'touchend', 'keydown'].forEach((ev) => document.addEventListener(ev, () => audio(), { passive: true }));
  function ctxTimeAt(epochMs) {
    return ctx.currentTime + (epochMs - Date.now()) / 1000;
  }

  // ---------- YouTube player ----------
  const yt = { player: null, ready: false, state: -1, rate: 1, dur: 0, anchor: null, apiP: null, created: false, lastSeek: null, delay: store.get('seekDelay', 0.18) };

  function loadYTApi() {
    if (yt.apiP) return yt.apiP;
    yt.apiP = new Promise((resolve, reject) => {
      if (window.YT && window.YT.Player) return resolve();
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof prev === 'function') prev();
        resolve();
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => reject(new Error('YouTube player failed to load'));
      document.head.appendChild(s);
    });
    return yt.apiP;
  }

  function setAnchor(ct, wall, real) {
    const now = Date.now();
    if (!(wall > 0) || Math.abs(wall - now) > 3000) wall = now;
    yt.anchor = { ct, wall, real: real !== false };
    // learn how long a jump takes on this device
    const J = yt.lastSeek;
    if (real !== false && J && !J.done && yt.state === 1 && yt.rate === 1 && wall > J.t + 700 && wall < J.t + 4000) {
      J.done = true;
      const d = (wall - J.t) / 1000 - (ct - J.target);
      if (d > 0.005 && d < 0.9) {
        yt.delay = yt.delay * 0.6 + d * 0.4;
        store.set('seekDelay', yt.delay);
      }
    }
  }
  function posNow(atEpoch) {
    const a = yt.anchor;
    if (!a) return 0;
    const w = atEpoch == null ? Date.now() : atEpoch;
    if (yt.state === 1) return a.ct + Math.max(0, Math.min(2, (w - a.wall) / 1000)) * (yt.rate || 1);
    return a.ct;
  }
  function wallWhenPos(pos) {
    const a = yt.anchor;
    return a.wall + ((pos - a.ct) * 1000) / (yt.rate || 1);
  }

  window.addEventListener('message', (e) => {
    if (!yt.player || typeof yt.player.getIframe !== 'function') return;
    let ifr = null;
    try {
      ifr = yt.player.getIframe();
    } catch (err) {
      return;
    }
    if (!ifr || e.source !== ifr.contentWindow) return;
    let d = e.data;
    if (typeof d === 'string') {
      try {
        d = JSON.parse(d);
      } catch (err) {
        return;
      }
    }
    if (!d || d.event !== 'infoDelivery' || !d.info) return;
    const i = d.info;
    if (typeof i.playerState === 'number') yt.state = i.playerState;
    if (typeof i.playbackRate === 'number' && i.playbackRate > 0) yt.rate = i.playbackRate;
    if (typeof i.duration === 'number' && i.duration > 0 && i.duration !== yt.dur) {
      yt.dur = i.duration;
      onDuration();
    }
    if (typeof i.currentTime === 'number') setAnchor(i.currentTime, typeof i.currentTimeLastUpdated_ === 'number' ? i.currentTimeLastUpdated_ * 1000 : Date.now(), true);
  });

  setInterval(() => {
    if (!yt.ready || !yt.player || typeof yt.player.getCurrentTime !== 'function') return;
    try {
      const st = yt.player.getPlayerState();
      if (typeof st === 'number') yt.state = st;
      const ct = yt.player.getCurrentTime();
      if (typeof ct === 'number' && (!yt.anchor || Date.now() - yt.anchor.wall > 1200)) setAnchor(ct, Date.now(), true);
      const du = yt.player.getDuration && yt.player.getDuration();
      if (du > 0 && du !== yt.dur) {
        yt.dur = du;
        onDuration();
      }
    } catch (e) {}
  }, 250);

  async function showVideo(id) {
    await loadYTApi();
    yt.anchor = null;
    yt.dur = 0;
    if (!yt.created) {
      yt.created = true;
      yt.player = new YT.Player('player', {
        videoId: id,
        playerVars: { playsinline: 1, rel: 0, origin: location.origin },
        events: {
          onReady: () => {
            yt.ready = true;
            try {
              const du = yt.player.getDuration();
              if (du > 0) {
                yt.dur = du;
                onDuration();
              }
            } catch (e) {}
          },
          onStateChange: (e) => {
            yt.state = e.data;
            if (e.data === 1) $('playHint').hidden = true;
            try {
              setAnchor(yt.player.getCurrentTime(), Date.now(), true);
            } catch (err) {}
          },
          onError: (e) => onPlayerError(e.data),
        },
      });
    } else if (yt.ready) {
      yt.player.cueVideoById({ videoId: id });
    } else {
      await sleep(400);
      return showVideo(id);
    }
  }

  function ytSeek(t) {
    t = Math.max(0, t);
    try {
      yt.player.seekTo(t, true);
    } catch (e) {}
    yt.lastSeek = { t: Date.now(), target: t, done: false };
    yt.anchor = { ct: t, wall: Date.now() + yt.delay * 1000, real: false };
  }
  function setRate(r) {
    try {
      yt.player.setPlaybackRate(r);
    } catch (e) {}
    const p = posNow();
    yt.rate = r;
    yt.anchor = { ct: p, wall: Date.now(), real: false };
  }
  const ytMute = () => { try { yt.player.mute(); } catch (e) {} };
  const ytUnmute = () => { try { yt.player.unMute(); } catch (e) {} };

  function onPlayerError(code) {
    const m = {
      2: 'That link has a bad video ID. Copy the link again from YouTube.',
      5: 'The video failed to play in this browser. Try reloading the page.',
      100: 'That video is private or removed.',
      101: "This video's owner doesn't allow it to play outside YouTube. Try another upload of the song (search \"song name official audio\").",
      150: "This video's owner doesn't allow it to play outside YouTube. Try another upload of the song (search \"song name official audio\").",
      153: 'YouTube refused to play the video here. Try another upload of the song.',
    }[code];
    const el = $('linkMsg');
    el.textContent = m || 'YouTube could not play this video (error ' + code + ').';
    el.className = 'msg err';
  }

  // ---------- steps list ----------
  const STEP_ORDER = ['title', 'lyrics', 'preview', 'backing'];
  const STEP_LABEL = { title: 'Song', lyrics: 'Vocal timing', preview: 'Key and tempo', backing: 'Backing track' };
  function setStep(k, status, text) {
    A.steps[k] = { status, text };
    const ul = $('steps');
    ul.textContent = '';
    for (const key of STEP_ORDER) {
      const s = A.steps[key];
      if (!s) continue;
      const li = document.createElement('li');
      li.className = s.status;
      li.append(STEP_LABEL[key] + ': ');
      const sp = document.createElement('span');
      sp.textContent = s.text || (s.status === 'busy' ? 'working…' : '');
      li.append(sp);
      ul.append(li);
    }
  }

  // ---------- loading a link ----------
  function resetAnalysis() {
    A.token++;
    engineStop(true);
    Object.assign(A, {
      meta: null, query: null, lyrics: null, lyricResults: null, segs: null, itunes: null, deezer: null, ab: null, pv: null,
      previewFeats: [], keyResult: null, tempo: null, backing: null, unsupported: null, progress: null, steps: {},
    });
    $('steps').textContent = '';
  }

  async function loadLink(text) {
    const p = C.parseYouTubeId(text);
    const msg = $('linkMsg');
    if (!p) {
      msg.textContent = "That doesn't look like a YouTube link. In YouTube tap Share, then Copy link.";
      msg.className = 'msg err';
      return;
    }
    msg.textContent = '';
    msg.className = 'msg';
    if (p.id === A.vid) return;
    resetAnalysis();
    const token = A.token;
    A.vid = p.id;
    A.S = Object.assign(DEF(), store.get('v:' + p.id, {}));
    store.set('last', p.id);
    renderRecents();
    try {
      history.replaceState(null, '', '#v=' + p.id + (TEST ? '' : ''));
    } catch (e) {}
    $('howto').hidden = true;
    $('stage').hidden = false;
    $('playHint').hidden = false;
    $('songTitle').textContent = 'Loading…';
    $('songArtist').textContent = '';
    renderAll();
    try {
      await showVideo(p.id);
    } catch (e) {
      msg.textContent = "Couldn't load the YouTube player. Check your connection and try again.";
      msg.className = 'msg err';
    }
    if (token !== A.token) return;
    analyze(token);
  }

  async function getVideoMeta(id) {
    const watch = 'https://www.youtube.com/watch?v=' + id;
    try {
      const j = await fetchJSON('https://www.youtube.com/oembed?format=json&url=' + enc(watch), 8000);
      if (j && j.title) return { title: j.title, author: j.author_name || '' };
    } catch (e) {}
    try {
      const j = await fetchJSON('https://noembed.com/embed?url=' + enc(watch), 8000);
      if (j && j.title) return { title: j.title, author: j.author_name || '' };
    } catch (e) {}
    for (let i = 0; i < 20; i++) {
      try {
        const d = yt.player && yt.player.getVideoData && yt.player.getVideoData();
        if (d && d.title) return { title: d.title, author: d.author || '' };
      } catch (e) {}
      await sleep(300);
    }
    return null;
  }

  async function analyze(token) {
    setStep('title', 'busy');
    const meta = await getVideoMeta(A.vid);
    if (token !== A.token) return;
    A.meta = meta;
    if (!meta) {
      setStep('title', 'bad', "couldn't read the title. Tap \"Wrong song?\" to type it in.");
      $('songTitle').textContent = 'Unknown song';
      openSongForm();
      return;
    }
    A.query = A.S.query || C.cleanTitle(meta.title, meta.author);
    saveRecent();
    renderSong();
    setStep('title', 'ok', (A.query.artist ? A.query.artist + ' – ' : '') + A.query.track);
    await runLookups(token);
  }

  function unsupported(reason) {
    A.unsupported = reason;
    A.progress = null;
    setStep('backing', 'bad', 'not available for this song');
    renderSolo();
  }

  async function runLookups(token) {
    const q = A.query;
    const live = () => token === A.token;
    setStep('lyrics', 'busy');
    setStep('preview', 'busy');
    setStep('backing', 'busy', 'waiting for the song details…');
    for (let i = 0; i < 12 && !yt.dur && live(); i++) await sleep(250);
    if (!live()) return;
    const pLyrics = findLyrics(q, yt.dur)
      .then((r) => {
        if (!live()) return;
        A.lyrics = r;
        prepLyrics();
        if (r && A.segs && A.segs.length) setStep('lyrics', 'ok', A.segs.length + ' sung lines');
        else if (r && r.instrumental) setStep('lyrics', 'bad', 'instrumental track');
        else setStep('lyrics', 'bad', 'no synced lyrics found');
      })
      .catch(() => live() && setStep('lyrics', 'bad', 'lyrics service unreachable'));
    const pItunes = findItunes(q, yt.dur).then((r) => { if (live()) A.itunes = r; }).catch(() => {});
    const pDeezer = findDeezer(q, yt.dur).then((r) => { if (live()) A.deezer = r; }).catch(() => {});
    await Promise.all([pLyrics, pItunes, pDeezer]);
    if (!live()) return;
    // key: database + previews, in the background
    const album = {
      artist: (A.itunes && A.itunes.artist) || (A.lyrics && A.lyrics.artistName) || q.artist,
      track: (A.itunes && A.itunes.track) || q.track,
      dur: (A.lyrics && A.lyrics.duration) || (A.itunes && A.itunes.dur) || yt.dur || 0,
    };
    acoustic(album, token).then((r) => { if (live()) { A.ab = r; updateKey(); } }).catch(() => {});
    // the Apple preview drives the backing track; Deezer's helps the key
    let pv = null;
    if (A.itunes && A.itunes.preview) {
      try {
        pv = await decodePreview(A.itunes.preview, 2);
        pv.url = A.itunes.preview;
      } catch (e) {}
    }
    if (!live()) return;
    A.pv = pv;
    if (pv) {
      await sleep(0);
      A.previewFeats.push(C.keyFeatures(D.mono(pv.L, pv.R), pv.sr));
      const tp = C.tempoFromPCM(D.mono(pv.L, pv.R), pv.sr);
      const ons = D.onsets(D.mono(pv.L, pv.R), pv.sr);
      const tb = D.trackBeats(ons.env, ons.rate, C.foldTempo(tp.bpm), ons.latency);
      A.tempo = { bpm: tb.bpm, period: tb.period, beats: tb.beats };
      updateKey();
      renderTempo();
      setStep('preview', 'ok', 'analyzed the 30-second preview');
    } else setStep('preview', 'bad', 'no preview audio found');
    if (A.deezer && A.deezer.preview) {
      decodePreview(A.deezer.preview, 1)
        .then((d) => {
          if (!live()) return;
          A.previewFeats.push(C.keyFeatures(d.L, d.sr));
          updateKey();
        })
        .catch(() => {});
    }
    prepareBacking(token);
  }

  // ---------- lookups ----------
  async function findLyrics(q, dur) {
    const tries = [];
    if (q.artist) tries.push('q=' + enc(q.artist + ' ' + q.track));
    if (q.artist) tries.push('track_name=' + enc(q.track) + '&artist_name=' + enc(q.artist));
    tries.push('q=' + enc(q.track));
    let lastErr = null;
    for (const qs of tries) {
      try {
        const res = await fetchJSON('https://lrclib.net/api/search?' + qs, 12000);
        const pick = C.pickLyrics(res, q.artist, q.track, dur);
        if (pick) {
          A.lyricResults = res;
          return pick;
        }
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr && lastErr.name !== 'AbortError' && !lastErr.status) throw lastErr;
    return null;
  }

  function bestMatch(list, q, dur, getT, getA, getDur) {
    let best = null;
    for (const x of list || []) {
      const t = getT(x) || '';
      const sT = C.similarity(C.stripJunk(t), q.track);
      const sA = q.artist ? C.similarity(getA(x), q.artist) : 0.5;
      if (sT < 0.5) continue;
      let sD = 0.5;
      const d = getDur(x);
      if (dur && d) {
        const dd = Math.abs(d - dur);
        sD = dd <= 3 ? 1 : dd <= 10 ? 0.7 : dd <= 30 ? 0.4 : 0.15;
      }
      const isLive = /\blive\b|\bacoustic\b|\bdemo\b|\bremix\b|\bkaraoke\b|\binstrumental\b/i.test(t) && !/\blive\b/i.test(q.track);
      const score = sT * 0.45 + sA * 0.35 + sD * 0.2 - (isLive ? 0.25 : 0);
      if (!best || score > best.score) best = { x, score };
    }
    return best && best.score > 0.45 ? best.x : null;
  }

  async function findItunes(q, dur) {
    const term = (q.artist ? q.artist + ' ' : '') + q.track;
    const j = await fetchJSON('https://itunes.apple.com/search?media=music&entity=song&limit=15&term=' + enc(term), 10000);
    const x = bestMatch(j.results, q, dur, (r) => r.trackName, (r) => r.artistName, (r) => (r.trackTimeMillis || 0) / 1000);
    if (!x) return null;
    return { artist: x.artistName, track: C.stripJunk(x.trackName) || x.trackName, dur: (x.trackTimeMillis || 0) / 1000, preview: x.previewUrl };
  }

  async function findDeezer(q, dur) {
    const term = (q.artist ? q.artist + ' ' : '') + q.track;
    const j = await jsonp('https://api.deezer.com/search?limit=15&q=' + enc(term), 9000);
    const x = bestMatch(j && j.data, q, dur, (r) => r.title, (r) => r.artist && r.artist.name, (r) => r.duration);
    if (!x) return null;
    return { preview: x.preview, dur: x.duration };
  }

  const AB_FEATS = 'rhythm.bpm;tonal.key_key;tonal.key_scale;tonal.key_strength;tonal.chords_key;tonal.chords_scale';
  async function acoustic(album, token) {
    const clean = (s) => String(s || '').replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
    const track = clean(C.stripJunk(album.track));
    const artist = clean(album.artist);
    if (!track) return null;
    const query = 'recording:"' + track + '"' + (artist ? ' AND artist:"' + artist + '"' : '');
    let mb = null;
    for (let i = 0; i < 2 && !mb; i++) {
      try {
        mb = await fetchJSON('https://musicbrainz.org/ws/2/recording?fmt=json&limit=50&query=' + enc(query), 12000);
      } catch (e) {
        if (e.status === 503 && i === 0) await sleep(1200);
        else throw e;
      }
    }
    if (token !== A.token) return null;
    const recs = ((mb && mb.recordings) || []).filter((r) => r.score >= 85 && C.similarity(r.title, track) >= 0.5);
    const dur = album.dur;
    recs.sort((a, b) => (a.length ? Math.abs(a.length / 1000 - dur) : 999) - (b.length ? Math.abs(b.length / 1000 - dur) : 999));
    const ids = Array.from(new Set(recs.map((r) => r.id))).slice(0, 25);
    if (!ids.length) return null;
    let bulk;
    try {
      bulk = await fetchJSON('https://acousticbrainz.org/api/v1/low-level?recording_ids=' + ids.join(';') + '&features=' + enc(AB_FEATS), 15000);
    } catch (e) {
      if (e.status === 400) bulk = await fetchJSON('https://acousticbrainz.org/api/v1/low-level?recording_ids=' + ids.join(';') + '&features=' + enc('rhythm.bpm;tonal.key_key;tonal.key_scale'), 15000);
      else throw e;
    }
    const entries = C.parseAcousticBulk(bulk);
    return { agg: entries.length ? C.aggregateAcoustic(entries, dur) : { key: null, tempo: null, count: 0 } };
  }

  async function decodePreview(url, channels) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = await r.arrayBuffer();
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const oc = new OAC(channels, 44100, 44100);
    const ab = await new Promise((resolve, reject) => {
      const p = oc.decodeAudioData(buf, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
    const L = ab.getChannelData(0).slice();
    const R = ab.numberOfChannels > 1 ? ab.getChannelData(1).slice() : L;
    return { L, R, sr: ab.sampleRate, dur: ab.duration };
  }

  // ---------- key ----------
  function updateKey() {
    const ranked = C.rankKeys(A.previewFeats);
    A.keyResult = C.combineKeys(ranked, A.ab && A.ab.agg);
    renderKey();
  }

  // ---------- lyric timing ----------
  function prepLyrics() {
    const L = A.lyrics;
    A.segs = null;
    if (!L || !L.syncedLyrics) return;
    A.segs = C.vocalSegments(C.parseLRC(L.syncedLyrics), L.duration || yt.dur || 0);
  }

  function lengthMismatch() {
    if (!A.lyrics || !yt.dur || !A.lyrics.duration) return null;
    const diff = yt.dur - A.lyrics.duration;
    return Math.abs(diff) > 2.5 ? diff : null;
  }

  function onDuration() {
    if (A.lyrics && A.lyricResults && yt.dur && A.query && Math.abs((A.lyrics.duration || 0) - yt.dur) > 2.5) {
      const r = C.pickLyrics(A.lyricResults, A.query.artist, A.query.track, yt.dur);
      if (r && r !== A.lyrics && Math.abs((r.duration || 0) - yt.dur) <= 3) {
        A.lyrics = r;
        prepLyrics();
        setStep('lyrics', 'ok', A.segs.length + ' sung lines');
        if (A.pv && A.steps.backing && A.steps.backing.status !== 'busy') prepareBacking(A.token);
      }
    }
    if (A.backing && lengthMismatch() != null) unsupported('edit');
    renderSolo();
  }

  // ---------- the backing track ----------
  let worker = null;
  let workerJobs = {};
  function separate(L, R, onProgress) {
    if (!worker) {
      worker = new Worker('sep-worker.js?v=' + VER + (TEST ? '&test=1' : ''));
      worker.onmessage = (e) => {
        const m = e.data;
        const job = workerJobs[m.id];
        if (!job) return;
        if (m.type === 'progress') job.progress(m);
        else if (m.type === 'done') { delete workerJobs[m.id]; job.resolve(m); }
        else if (m.type === 'error') { delete workerJobs[m.id]; job.reject(new Error(m.message)); }
      };
      worker.onerror = (e) => {
        for (const id in workerJobs) workerJobs[id].reject(new Error(e.message || 'background processing failed'));
        workerJobs = {};
        worker = null;
      };
    }
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      workerJobs[id] = { resolve, reject, progress: onProgress };
      worker.postMessage({ type: 'separate', id, L, R, gpu: true });
    });
  }

  async function cacheGet(key) {
    try {
      const c = await caches.open('solo-spot-backing-v1');
      const r = await c.match('https://cache.solo-spot.local/' + key);
      if (!r) return null;
      const buf = await r.arrayBuffer();
      const n = new Uint32Array(buf, 0, 1)[0];
      const f = new Float32Array(buf, 4, n * 4);
      return { instL: f.slice(0, n), instR: f.slice(n, 2 * n), vocL: f.slice(2 * n, 3 * n), vocR: f.slice(3 * n, 4 * n) };
    } catch (e) {
      return null;
    }
  }
  async function cachePut(key, res) {
    try {
      const n = res.instL.length;
      const buf = new ArrayBuffer(4 + n * 16);
      new Uint32Array(buf, 0, 1)[0] = n;
      const f = new Float32Array(buf, 4, n * 4);
      f.set(res.instL, 0);
      f.set(res.instR, n);
      f.set(res.vocL, 2 * n);
      f.set(res.vocR, 3 * n);
      const c = await caches.open('solo-spot-backing-v1');
      await c.put('https://cache.solo-spot.local/' + key, new Response(buf));
    } catch (e) {}
  }
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    return h.toString(36);
  }

  async function prepareBacking(token) {
    const live = () => token === A.token;
    A.backing = null;
    A.unsupported = null;
    if (!A.segs || !A.segs.length) return unsupported('nolyrics');
    if (lengthMismatch() != null) return unsupported('edit');
    if (!A.pv || !A.tempo) return unsupported('nopreview');
    const segs = A.segs;
    const sec = C.sections(segs);
    if (!sec.runs.length) return unsupported('nochorus');
    const period = A.tempo.period;
    const lrcDur = A.lyrics.duration || yt.dur;
    setStep('backing', 'busy', 'finding the chorus in the preview…');
    A.progress = { frac: 0.03, text: 'Finding the chorus…' };
    renderSolo();
    await sleep(10);
    const va = D.vocalActivity(A.pv.L, A.pv.R, A.pv.sr);
    const align = D.alignToLyrics(va.activity, va.rate, segs, lrcDur);
    if (!live()) return;
    const runStarts = sec.runs.map((r) => r.first);
    // prefer an 8-bar loop, settle for 4
    let found = null;
    let loopBars = 0;
    for (const bars of [8, 4]) {
      const len = bars * 4 * period;
      if (len > 21) continue;
      for (let r = sec.runs.length - 1; r >= 0 && !found; r--) found = D.findLineInPreview(segs, sec.runs[r].first, align, A.pv.dur, len + 0.6, runStarts);
      if (found) { loopBars = bars; break; }
    }
    if (!found) return unsupported('preview-no-chorus');
    const loopLen = loopBars * 4 * period;
    const w0 = Math.max(0, found.tPrev - 1.5 - 2 * period);
    const w1 = Math.min(A.pv.dur, found.tPrev + loopLen + 1.2 + 2 * period);
    const sr = A.pv.sr;
    const a = Math.floor(w0 * sr), b = Math.floor(w1 * sr);
    const segL = A.pv.L.slice(a, b), segR = A.pv.R.slice(a, b);
    const key = hash(A.vid + '|' + A.pv.url + '|' + w0.toFixed(2) + '|' + w1.toFixed(2) + '|mdx9703');
    let res = await cacheGet(key);
    if (!live()) return;
    if (!res) {
      const t0 = Date.now();
      try {
        res = await separate(segL, segR, (m) => {
          if (!live()) return;
          let frac = 0, text = '';
          if (m.stage === 'download') { frac = 0.05 + 0.25 * m.frac; text = m.cached ? 'Starting the vocal remover…' : 'Downloading the vocal remover (one time, 30 MB) ' + Math.round(m.frac * 100) + '%'; }
          else if (m.stage === 'prepare') { frac = 0.32; text = 'Starting the vocal remover…'; }
          else if (m.stage === 'separate') { frac = 0.32 + 0.66 * (m.done / m.total); text = 'Removing vocals: part ' + m.done + ' of ' + m.total; }
          A.progress = { frac, text };
          setStep('backing', 'busy', text.toLowerCase());
          renderSolo();
        });
      } catch (e) {
        if (!live()) return;
        A.failReason = String((e && e.message) || e);
        return unsupported('ai');
      }
      if (!live()) return;
      res.engine && (A.engineUsed = res.engine);
      A.aiSeconds = Math.round((Date.now() - t0) / 1000);
      cachePut(key, res);
    }
    // precise first notes of the sung lines inside the processed window
    const inWin = [];
    for (let i = 0; i < segs.length; i++) {
      const tp = segs[i].start - found.offset;
      if (tp > w0 + 0.3 && tp < w1 - 0.3) inWin.push({ i, g: tp - w0 });
    }
    const ons = D.vocalOnsetsNear(res.vocL, res.vocR, sr, inWin.map((x) => x.g), 0.6);
    const onsetMap = new Map();
    inWin.forEach((x, k) => { if (ons[k] != null) onsetMap.set(x.i, ons[k] + w0); });
    const onsetOf = (i) => (onsetMap.has(i) ? onsetMap.get(i) : null);
    const first = onsetOf(found.idx) != null ? onsetOf(found.idx) : found.tPrev;
    // the loop starts on the beat at (or just before) the chorus's first sung note, so a pickup word isn't clipped
    let pRaw = null;
    for (const bt of A.tempo.beats) if (bt <= first + 0.06) pRaw = bt;
    if (pRaw == null) pRaw = A.tempo.beats[0] || first;
    // where each chorus copy sits in the song
    const spots = [];
    const runs = sec.runs;
    for (let r = 0; r < runs.length; r++) {
      const idx = runs[r].first;
      const t = segs[idx].start;
      if (t < lrcDur * 0.33) continue;
      const so = D.songOffset(segs, found.idx, onsetOf, idx) || (segs[idx].norm === segs[found.idx].norm ? { offset: t - first, pairs: 0 } : null);
      if (!so) continue;
      const isLast = r === runs.length - 1;
      spots.push({ id: 'c' + (r + 1), kind: 'before', run: r, songAt: pRaw + so.offset, label: isLast && runs.length > 1 ? 'Before the last chorus' : 'Before chorus ' + (r + 1), pairs: so.pairs });
    }
    // ending solo: after the last chorus, the backing keeps going
    const last = runs[runs.length - 1];
    const soL = D.songOffset(segs, found.idx, onsetOf, last.first) || (segs[last.first].norm === segs[found.idx].norm ? { offset: segs[last.first].start - first, pairs: 0 } : null);
    if (soL) {
      const lastStart = pRaw + soL.offset;
      const lastEnd = segs[segs.length - 1].end;
      const m = Math.max(1, Math.ceil((lastEnd - lastStart + 0.2) / loopLen));
      const at = lastStart + m * loopLen;
      if (at < (yt.dur || lrcDur) - 1) spots.push({ id: 'end', kind: 'end', songAt: at, label: 'Ending solo' });
    }
    if (!spots.length) return unsupported('nospot');
    const L = res.instL, R = res.instR;
    A.backing = {
      L, R, sr, w0, pRaw, period, loopBars, loopLen, spots, onsets: onsetMap.size,
      get buffer() { return this._b || (this._b = (() => { const c = audio(); const bf = c.createBuffer(2, L.length, sr); bf.copyToChannel(L, 0); bf.copyToChannel(R, 1); return bf; })()); },
    };
    A.progress = null;
    setStep('backing', 'ok', 'ready (' + loopBars + '-bar instrumental chorus' + (A.aiSeconds ? ', made in ' + A.aiSeconds + ' s' : '') + ')');
    renderAll();
    armEngine();
  }

  // ---------- current solo choice ----------
  function currentSpot() {
    const B = A.backing;
    if (!B) return null;
    let s = B.spots.find((x) => x.id === A.S.spot);
    if (!s) s = B.spots.filter((x) => x.kind === 'before').pop() || B.spots[0];
    return s;
  }
  function soloTiming() {
    const B = A.backing;
    const s = currentSpot();
    if (!B || !s) return null;
    const barLen = 4 * B.period;
    const at = s.songAt + (A.S.fine || 0) / 1000;
    const startInBuf = B.pRaw + (A.S.shift || 0) * B.period - B.w0;
    if (s.kind === 'end') return { spot: s, at, startInBuf, length: Infinity, bars: null, barLen };
    const bars = A.S.bars || 8;
    return { spot: s, at, startInBuf, length: bars * barLen, bars, barLen };
  }

  // ---------- playing the backing ----------
  let src = null;
  function startBacking(when, T, untilSec) {
    const B = A.backing;
    const c = audio();
    stopBacking();
    const s = c.createBufferSource();
    s.buffer = B.buffer;
    s.loop = true;
    s.loopStart = Math.max(0, T.startInBuf);
    s.loopEnd = s.loopStart + B.loopLen;
    const g = c.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(1, when + 0.006);
    s.connect(g).connect(c.destination);
    s.start(when, s.loopStart);
    src = { s, g, when };
    if (isFinite(untilSec)) endBackingAt(when + untilSec, 0.012);
    return src;
  }
  function endBackingAt(t, fade) {
    if (!src) return;
    const { s, g } = src;
    try {
      g.gain.setValueAtTime(1, t);
      g.gain.linearRampToValueAtTime(0, t + fade);
      s.stop(t + fade + 0.02);
    } catch (e) {}
  }
  function stopBacking() {
    if (!src) return;
    const p = src;
    src = null;
    try {
      const t = ctx.currentTime;
      p.g.gain.cancelScheduledValues(t);
      p.g.gain.setValueAtTime(p.g.gain.value, t);
      p.g.gain.linearRampToValueAtTime(0, t + 0.02);
      p.s.stop(t + 0.04);
    } catch (e) {}
  }

  // ---------- solo engine ----------
  // states: idle, armed, solo, done
  const E = { state: 'idle', T: null, Ws: 0, Wend: 0, run: null, endAsked: false, needSound: false };
  function armEngine() {
    E.state = A.backing ? 'armed' : 'idle';
    E.T = soloTiming();
    if (E.T && yt.anchor && posNow() > E.T.at + 0.3) E.state = 'done';
  }
  function engineStop(silent) {
    if (E.run) E.run.cancel = true;
    E.run = null;
    if (ctx) stopBacking();
    if (yt.player) {
      ytUnmute();
      if (yt.rate !== 1) setRate(1);
    }
    if (E.state === 'solo') E.state = 'done';
    if (silent) E.state = 'idle';
  }

  setInterval(() => {
    if (E.state === 'idle' || !A.backing || !yt.player) return;
    const T = E.T;
    if (!T) return;
    const pos = posNow();
    if (E.state === 'done') {
      if (yt.state === 1 && yt.anchor && yt.anchor.real && pos < T.at - 2 && !E.run) E.state = 'armed';
      return;
    }
    if (E.state !== 'armed') return;
    if (yt.state !== 1 || !yt.anchor || !yt.anchor.real || yt.rate !== 1) return;
    if (pos > T.at + 0.3) { E.state = 'done'; return; }
    const Ws = wallWhenPos(T.at);
    const left = Ws - Date.now();
    E.needSound = !soundReady() && left < 15000;
    if (left > 0 && left < 300) {
      if (!soundReady()) return; // can't make sound yet; the dock asks for a tap
      enterSolo(Ws, T);
    }
  }, 15);

  async function enterSolo(Ws, T) {
    const me = { cancel: false };
    E.run = me;
    E.state = 'solo';
    E.Ws = Ws;
    E.endAsked = false;
    const startT = ctxTimeAt(Ws);
    startBacking(startT, T, T.length);
    await sleep(Math.max(0, Ws - Date.now() - 8));
    if (me.cancel) return;
    ytMute();
    await sleep(200);
    if (me.cancel) return;
    try { yt.player.pauseVideo(); } catch (e) {}
    if (T.spot.kind === 'end') {
      // loops until the player asks to end (cap: 64 bars)
      const cap = Ws + 64 * T.barLen * 1000;
      while (!me.cancel && !E.endAsked && Date.now() < cap) await sleep(100);
      if (me.cancel) return;
      // finish at the end of the current 4-bar phrase
      const el = (Date.now() - Ws) / 1000;
      const phrase = 4 * T.barLen;
      const endAt = Ws / 1000 + Math.ceil((el + 0.3) / phrase) * phrase;
      endBackingAt(ctxTimeAt(endAt * 1000) - 2 * A.backing.period, 2 * A.backing.period);
      E.Wend = endAt * 1000;
      await sleep(Math.max(0, E.Wend - Date.now() + 100));
      if (me.cancel) return;
      ytUnmute();
      src = null;
      E.state = 'done';
      E.run = null;
      return;
    }
    E.Wend = Ws + T.length * 1000;
    await landAt(T.at, E.Wend, me);
    if (me.cancel) return;
    await sleep(Math.max(0, E.Wend - Date.now() - 15));
    if (me.cancel) return;
    ytUnmute();
    src = null;
    E.state = 'done';
    E.run = null;
  }

  // Get the muted video to song time `pos` exactly at wall time `W`: a jump, then small speed nudges.
  async function landAt(pos, W, me) {
    const runway = 4.5;
    await sleep(Math.max(0, W - Date.now() - (runway + 0.8) * 1000));
    if (me.cancel) return;
    if (yt.rate !== 1) setRate(1);
    ytSeek(pos - (W - Date.now()) / 1000 + yt.delay);
    try { yt.player.playVideo(); } catch (e) {}
    let lastAction = Date.now();
    for (;;) {
      if (me.cancel) return;
      await sleep(40);
      const left = (W - Date.now()) / 1000;
      if (left < 0.12) break;
      const a = yt.anchor;
      if (yt.state !== 1 || !a || !a.real || a.wall < lastAction + 250 || yt.rate !== 1) continue;
      const err = a.ct + (W - a.wall) / 1000 - pos;
      if (Math.abs(err) <= 0.025) continue;
      if (Math.abs(err) > 0.2 && left > 1.6) {
        ytSeek(pos - (W - Date.now()) / 1000 + yt.delay);
        lastAction = Date.now() + yt.delay * 1000;
      } else if (left > 4 * Math.abs(err) + 0.35) {
        setRate(err > 0 ? 0.75 : 1.25);
        await sleep(4 * Math.abs(err) * 1000);
        setRate(1);
        lastAction = Date.now();
      } else break;
    }
  }

  // ---------- rendering ----------
  function renderAll() {
    renderSong();
    renderKey();
    renderTempo();
    renderSolo();
    renderSources();
  }

  function renderSong() {
    const q = A.query;
    $('songTitle').textContent = q ? q.track || 'Unknown song' : 'Loading…';
    $('songArtist').textContent = q && q.artist ? q.artist : '';
  }

  function keyOf() {
    if (A.S.key) return { pc: A.S.key.pc, scale: A.S.key.scale, manual: true };
    if (A.keyResult) return { pc: A.keyResult.main.pc, scale: A.keyResult.main.scale, manual: false };
    return null;
  }

  function chip(text, onClick, on) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (on ? ' on' : '');
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  function setKey(k) {
    A.S.key = k ? { pc: k.pc, scale: k.scale } : null;
    saveS();
    renderKey();
  }

  function renderKey() {
    const k = keyOf();
    const name = $('keyName'), tag = $('keyTag'), play = $('keyPlay'), facts = $('keyFacts'), chips = $('keyChips');
    facts.textContent = '';
    chips.textContent = '';
    $('fretboard').textContent = '';
    if (!k) {
      const busy = !A.query || (A.steps.preview && A.steps.preview.status === 'busy') || !A.steps.preview;
      name.textContent = busy ? 'Listening…' : 'Unknown';
      name.className = 'keyname pending';
      play.textContent = busy ? '' : "Couldn't find this one. Pick the key by ear:";
      tag.textContent = '';
      $('dockKey').textContent = '';
      if (!busy) renderKeyPicker(chips);
      return;
    }
    name.className = 'keyname';
    name.textContent = C.keyLabel(k.pc, k.scale);
    $('dockKey').textContent = C.keyLabel(k.pc, k.scale);
    const adv = C.scaleAdvice(k.pc, k.scale);
    play.textContent = '';
    play.append('Solo with ');
    const b = document.createElement('b');
    b.textContent = adv.main;
    play.append(b);
    const rf = C.rootFrets(k.pc);
    const add = (t) => { const li = document.createElement('li'); li.textContent = t; facts.append(li); };
    add('Full scale: ' + adv.full + '. ' + adv.same + '.');
    add('Root on the low E string: fret ' + rf.lowE.join(' or ') + '. On the A string: fret ' + rf.a.join(' or ') + '.');
    add((k.scale === 'major' ? 'Bluesier option: ' : 'Grittier option: ') + adv.extra + '.');
    drawFretboard(k);
    tag.textContent = k.manual ? 'set by you' : A.keyResult && A.keyResult.sure ? 'two checks agree' : 'best guess';
    tag.className = 'tag' + (!k.manual && A.keyResult && A.keyResult.sure ? ' good' : '');
    const rel = C.relativeKey(k.pc, k.scale);
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = 'Sounds off? One tap to switch:';
    chips.append(lbl);
    chips.append(chip((k.scale === 'major' ? 'Sounds minor? ' : 'Sounds major? ') + C.keyLabel(rel.pc, rel.scale), () => setKey(rel)));
    if (A.keyResult) {
      for (const a of A.keyResult.alts) {
        if ((a.pc === k.pc && a.scale === k.scale) || (a.pc === rel.pc && a.scale === rel.scale)) continue;
        chips.append(chip(C.keyLabel(a.pc, a.scale), () => setKey(a)));
      }
      const m = A.keyResult.main;
      if (k.manual && !(m.pc === k.pc && m.scale === k.scale)) chips.append(chip('Back to ' + C.keyLabel(m.pc, m.scale), () => setKey(null)));
    }
    chips.append(chip('Other key…', () => renderKeyPicker(chips, true)));
  }

  function renderKeyPicker(container, replace) {
    if (replace) container.textContent = '';
    const wrap = document.createElement('div');
    wrap.className = 'chips';
    for (const scale of ['major', 'minor']) for (let pc = 0; pc < 12; pc++) wrap.append(chip(C.keyLabel(pc, scale), () => setKey({ pc, scale })));
    container.append(wrap);
  }

  function drawFretboard(k) {
    const NS = 'http://www.w3.org/2000/svg';
    const minorRoot = k.scale === 'minor' ? k.pc : (k.pc + 9) % 12;
    let f = (minorRoot - 4 + 12) % 12;
    if (f === 0) f = 12;
    const frets = [f, f + 1, f + 2, f + 3];
    const shape = [[0, 3], [0, 3], [0, 2], [0, 2], [0, 2], [0, 3]];
    const open = [4, 11, 7, 2, 9, 4];
    const W = 420, H = 150, left = 34, right = 14, top = 18, bottom = 26;
    const colW = (W - left - right) / 4, rowH = (H - top - bottom) / 5;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', C.scaleAdvice(k.pc, k.scale).main + ' shape starting at fret ' + f);
    const el = (n, attrs, text) => { const e = document.createElementNS(NS, n); for (const a in attrs) e.setAttribute(a, attrs[a]); if (text != null) e.textContent = text; svg.append(e); return e; };
    el('rect', { x: left, y: top, width: W - left - right, height: H - top - bottom, rx: 6, fill: 'var(--surface-2)' });
    for (let i = 0; i <= 4; i++) el('line', { x1: left + i * colW, y1: top, x2: left + i * colW, y2: H - bottom, stroke: 'var(--fret)', 'stroke-width': i === 0 ? 3 : 1.5 });
    for (let s = 0; s < 6; s++) {
      const y = top + s * rowH;
      el('line', { x1: left, y1: y, x2: W - right, y2: y, stroke: 'var(--muted)', 'stroke-width': 1 + s * 0.35 });
      el('text', { x: left - 12, y: y + 4, 'text-anchor': 'middle', 'font-size': 12, 'font-family': 'var(--mono)', fill: 'var(--muted)' }, ['e', 'B', 'G', 'D', 'A', 'E'][s]);
    }
    for (let i = 0; i < 4; i++) el('text', { x: left + (i + 0.5) * colW, y: H - 6, 'text-anchor': 'middle', 'font-size': 13, 'font-family': 'var(--mono)', fill: 'var(--muted)' }, String(frets[i]));
    for (let s = 0; s < 6; s++) for (const d of shape[s]) {
      const pc = (open[s] + f + d) % 12;
      el('circle', { cx: left + (d + 0.5) * colW, cy: top + s * rowH, r: 9, fill: pc === k.pc ? 'var(--accent)' : 'var(--ink)', stroke: 'var(--surface)', 'stroke-width': 2 });
    }
    $('fretboard').append(svg);
  }

  function renderTempo() {
    const el = $('bpm');
    el.textContent = '';
    el.append(A.tempo ? A.tempo.bpm.toFixed(1) : '–');
    const sm = document.createElement('small');
    sm.textContent = 'BPM';
    el.append(sm);
    $('tempoTag').textContent = A.tempo ? 'from the recording' : '';
    $('tempoNote').textContent = A.tempo ? 'One bar ≈ ' + (4 * A.tempo.period).toFixed(1) + ' s' : A.query ? 'Working it out…' : '';
  }

  const REASONS = {
    nolyrics: "There's no time-synced lyric data for this song, so Solo Spot can't find where the chorus is.",
    edit: 'This upload is a different edit than the album version, so the timing won\'t line up. The official audio upload works.',
    nopreview: "Apple doesn't have a preview of this song, which Solo Spot needs to build the backing track.",
    nochorus: "This song doesn't have a repeating chorus Solo Spot can use for the backing.",
    'preview-no-chorus': "Apple's 30-second preview of this song doesn't include the chorus, so there's nothing to build the backing from.",
    ai: "The vocal remover couldn't run on this device.",
    nospot: "Solo Spot couldn't line the chorus up with the song's timing.",
  };

  function renderSolo() {
    const head = $('soloHead'), sub = $('soloSub'), tag = $('soloTag'), prog = $('backingProg'), ctrls = $('soloControls');
    const warn = $('editWarn');
    warn.hidden = true;
    if (A.unsupported) {
      head.textContent = 'No solo for this song';
      sub.textContent = REASONS[A.unsupported] + (A.unsupported === 'ai' && A.failReason ? ' (' + A.failReason + ')' : '');
      sub.className = 'solosub warn';
      prog.hidden = true;
      ctrls.hidden = true;
      tag.textContent = '';
      if (A.unsupported === 'edit' && A.query) {
        const diff = lengthMismatch();
        warn.hidden = false;
        $('editWarnText').textContent = 'This video is ' + Math.abs(diff || 0).toFixed(0) + ' s ' + ((diff || 0) > 0 ? 'longer' : 'shorter') + ' than the album version.';
        $('findAudio').href = 'https://www.youtube.com/results?search_query=' + enc((A.query.artist ? A.query.artist + ' ' : '') + A.query.track + ' official audio');
      }
      return;
    }
    if (!A.backing) {
      head.textContent = A.query ? 'Building the backing track…' : '—';
      sub.className = 'solosub';
      sub.textContent = A.progress ? A.progress.text : A.query ? 'Looking up the song…' : '';
      prog.hidden = !A.progress;
      if (A.progress) prog.firstElementChild.style.width = Math.round(A.progress.frac * 100) + '%';
      ctrls.hidden = true;
      tag.textContent = '';
      return;
    }
    prog.hidden = true;
    ctrls.hidden = false;
    const T = soloTiming();
    const B = A.backing;
    head.textContent = T.spot.label + ' · ' + C.fmtTime(T.at);
    tag.textContent = B.loopBars + '-bar backing';
    sub.className = 'solosub';
    sub.textContent = T.spot.kind === 'end'
      ? 'After the last chorus the band keeps playing the chorus without vocals for as long as you want.'
      : 'The band plays the chorus without vocals for ' + T.bars + ' bars (' + Math.round(T.length) + ' s), then the real chorus comes in.';
    // spot chips
    const box = $('spots');
    box.textContent = '';
    for (const s of B.spots) {
      const c = chip(s.label + ' · ' + C.fmtTime(s.songAt), () => { A.S.spot = s.id; saveS(); onTimingChange(); });
      c.setAttribute('role', 'radio');
      c.setAttribute('aria-checked', String(s.id === T.spot.id));
      box.append(c);
    }
    $('barsSeg').hidden = T.spot.kind === 'end';
    $('endNote').hidden = T.spot.kind !== 'end';
    document.querySelectorAll('#barsSeg button').forEach((bt) => {
      const n = +bt.dataset.bars;
      bt.setAttribute('aria-pressed', String(n === (A.S.bars || 8)));
      bt.querySelector('small').textContent = '≈ ' + Math.round(n * T.barLen) + ' s';
    });
    $('shiftVal').textContent = (A.S.shift > 0 ? '+' : '') + (A.S.shift || 0) + (Math.abs(A.S.shift || 0) === 1 ? ' beat' : ' beats');
    $('fineVal').textContent = (A.S.fine > 0 ? '+' : '') + (A.S.fine || 0) + ' ms';
    drawTimeline();
  }

  function onTimingChange() {
    if (E.state === 'solo') engineStop();
    armEngine();
    renderSolo();
  }

  function renderSources() {
    $('sources').textContent = 'Vocal timing: LRCLIB. Backing track: Apple Music 30-second preview with the vocals removed on this phone by an open-source AI model (UVR MDX-Net). Key: AcousticBrainz plus preview analysis.';
  }

  // ---------- timeline ----------
  function drawTimeline() {
    const cv = $('tl');
    const box = cv.getBoundingClientRect();
    if (!box.width) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(box.width * dpr), H = Math.round(box.height * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    const col = (v) => css.getPropertyValue(v).trim() || '#888';
    g.clearRect(0, 0, W, H);
    const dur = yt.dur || (A.lyrics && A.lyrics.duration) || 0;
    const trackY = H * 0.3, trackH = H * 0.4;
    g.fillStyle = col('--surface-2');
    g.fillRect(0, trackY, W, trackH);
    if (!dur) return;
    const x = (t) => Math.max(0, Math.min(W, (t / dur) * W));
    if (A.segs) {
      g.fillStyle = col('--vocal');
      for (const s of A.segs) { const x0 = x(s.start); g.fillRect(x0, trackY, Math.max(1, x(s.end) - x0), trackH); }
    }
    const T = soloTiming();
    if (T) {
      g.fillStyle = col('--muted');
      for (const s of A.backing.spots) if (s.id !== T.spot.id) g.fillRect(x(s.songAt) - dpr, trackY + trackH + 3 * dpr, 2 * dpr, 6 * dpr);
      g.fillStyle = col('--accent');
      const px = x(T.at);
      g.fillRect(px - 1.5 * dpr, 2 * dpr, 3 * dpr, H - 4 * dpr);
      g.beginPath(); g.moveTo(px - 6 * dpr, 2 * dpr); g.lineTo(px + 6 * dpr, 2 * dpr); g.lineTo(px, 10 * dpr); g.closePath(); g.fill();
    }
    if (yt.anchor) { g.fillStyle = col('--ink'); g.fillRect(x(posNow()) - dpr, trackY - 6 * dpr, 2 * dpr, trackH + 12 * dpr); }
  }

  // ---------- dock ----------
  let lastDock = '';
  function renderDock() {
    const led = $('led'), main = $('dockMain'), sub = $('dockSub'), barsEl = $('dockBars'), dock = $('dock'), btn = $('dockBtn');
    let state = 'idle', m = 'Ready when you are', s = 'Paste a YouTube link to start', prog = null, action = null;
    const T = E.T;
    if (A.vid) {
      m = 'Loading…';
      s = 'Getting the song ready';
      if (A.unsupported) { m = 'No solo for this song'; s = 'Key and scale are still shown above'; }
      else if (!A.backing) { if (A.progress) { m = 'Building backing ' + Math.round(A.progress.frac * 100) + '%'; s = 'Start the song anytime, the solo is a few minutes in'; } }
      else if (E.state === 'solo' && T) {
        state = 'live';
        const el = (Date.now() - E.Ws) / 1000;
        if (el < 0) { m = 'Solo in ' + (-el).toFixed(1) + ' s'; state = 'wait'; }
        else {
          const bar = Math.floor(el / T.barLen) + 1;
          if (T.spot.kind === 'end') { m = 'Ending solo · bar ' + bar; s = E.endAsked ? 'Wrapping up at the end of this phrase' : 'Tap End when you want to finish'; action = E.endAsked ? null : 'End'; }
          else { m = 'Solo · bar ' + Math.min(bar, T.bars) + ' of ' + T.bars; s = 'The chorus comes back after this'; prog = { bar, bars: T.bars, frac: (el % T.barLen) / T.barLen }; action = 'Stop'; }
        }
      } else if (E.state === 'armed' && T) {
        const playing = yt.state === 1;
        state = playing ? 'wait' : 'idle';
        if (E.needSound) { m = 'Tap here to turn on the backing'; s = 'iPhone needs one tap on this page before it can play sound'; action = 'Sound on'; state = 'wait'; }
        else { m = playing ? 'Solo in ' + C.fmtTime(Math.max(0, T.at - posNow())) : yt.state === 2 ? 'Paused' : 'Tap the video to start'; s = T.spot.label + (T.bars ? ' · ' + T.bars + ' bars' : ''); }
      } else if (E.state === 'done' && T) {
        m = yt.state === 1 ? 'Solo done' : 'Paused';
        s = 'Tap "Play from just before the solo" for another take';
      }
    }
    const sig = state + '|' + m + '|' + s + '|' + (prog ? prog.bar : '') + '|' + action;
    led.className = 'led' + (state === 'live' ? ' live' : state === 'wait' ? ' wait' : '');
    dock.classList.toggle('solo', state === 'live');
    if (sig !== lastDock) {
      main.textContent = m;
      sub.textContent = s;
      lastDock = sig;
      btn.hidden = !action;
      if (action) btn.textContent = action;
      btn.dataset.action = action || '';
      $('dockKey').hidden = !!action;
      if (prog && prog.bars) {
        barsEl.hidden = false;
        if (barsEl.childElementCount !== prog.bars) {
          barsEl.textContent = '';
          for (let i = 0; i < prog.bars; i++) barsEl.append(document.createElement('span'));
        }
      } else barsEl.hidden = true;
    }
    if (prog && prog.bars) {
      const spans = barsEl.children;
      for (let i = 0; i < spans.length; i++) {
        const sp = spans[i];
        sp.className = i < prog.bar - 1 ? 'done' : '';
        let fill = sp.firstChild;
        if (i === prog.bar - 1) {
          if (!fill) { fill = document.createElement('i'); sp.append(fill); }
          fill.style.width = Math.round(prog.frac * 100) + '%';
        } else if (fill) fill.remove();
      }
    }
  }
  function frame() {
    renderDock();
    if (A.vid && yt.state === 1) drawTimeline();
    requestAnimationFrame(frame);
  }
  setInterval(renderDock, 150);

  // ---------- recent songs ----------
  function saveRecent() {
    if (!A.vid || !A.query) return;
    const list = store.get('recent', []).filter((r) => r.id !== A.vid);
    list.unshift({ id: A.vid, track: A.query.track, artist: A.query.artist });
    store.set('recent', list.slice(0, 8));
    renderRecents();
  }
  function renderRecents() {
    const box = $('recents');
    const list = store.get('recent', []).filter((r) => r.id !== A.vid);
    box.textContent = '';
    box.hidden = !list.length;
    for (const r of list) box.append(chip(r.track + (r.artist ? ' · ' + r.artist : ''), () => { $('link').value = 'https://youtu.be/' + r.id; loadLink(r.id); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
  }

  // ---------- song form ----------
  function openSongForm() {
    $('songForm').hidden = false;
    $('fArtist').value = (A.query && A.query.artist) || '';
    $('fTrack').value = (A.query && A.query.track) || '';
  }

  // ---------- events ----------
  function bind() {
    const link = $('link');
    $('pasteBtn').addEventListener('click', async () => {
      audio();
      let txt = '';
      try {
        if (navigator.clipboard && navigator.clipboard.readText) txt = await navigator.clipboard.readText();
      } catch (e) {}
      if (txt && C.parseYouTubeId(txt)) { link.value = txt.trim(); loadLink(txt); }
      else if (link.value && C.parseYouTubeId(link.value)) loadLink(link.value);
      else {
        link.focus();
        const msg = $('linkMsg');
        msg.textContent = txt ? "Your clipboard doesn't have a YouTube link. Copy it from YouTube's Share button first." : 'Long-press the box above and choose Paste.';
        msg.className = 'msg';
      }
    });
    link.addEventListener('input', () => { if (C.parseYouTubeId(link.value)) loadLink(link.value); });
    link.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadLink(link.value); });
    $('editSong').addEventListener('click', () => { const f = $('songForm'); if (f.hidden) openSongForm(); else f.hidden = true; });
    $('cancelSong').addEventListener('click', () => ($('songForm').hidden = true));
    $('songForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const artist = $('fArtist').value.trim();
      const track = $('fTrack').value.trim();
      if (!track) return;
      $('songForm').hidden = true;
      const vid = A.vid, S = A.S, meta = A.meta;
      resetAnalysis();
      A.vid = vid;
      A.S = S;
      A.meta = meta || { title: track, author: artist };
      A.query = { artist, track };
      A.S.query = A.query;
      A.S.key = null;
      saveS();
      renderAll();
      setStep('title', 'ok', (artist ? artist + ' – ' : '') + track);
      runLookups(A.token);
    });
    $('barsSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      A.S.bars = +b.dataset.bars;
      store.set('bars', A.S.bars);
      saveS();
      onTimingChange();
    });
    $('goSolo').addEventListener('click', () => {
      audio();
      const T = soloTiming();
      if (!T || !yt.player) return;
      engineStop();
      const lead = Math.max(6, 2 * T.barLen + 1);
      ytSeek(T.at - lead);
      try { yt.player.playVideo(); } catch (e) {}
      armEngine();
      E.state = 'armed';
    });
    $('listenBtn').addEventListener('click', () => {
      const c = audio();
      const T = soloTiming();
      if (!T || !c) return;
      engineStop();
      try { yt.player.pauseVideo(); } catch (e) {}
      startBacking(c.currentTime + 0.08, T, 2 * A.backing.loopLen);
      armEngine();
    });
    const bump = (k, d) => {
      const lim = k === 'shift' ? 2 : 400;
      A.S[k] = Math.max(-lim, Math.min(lim, (A.S[k] || 0) + d));
      saveS();
      onTimingChange();
    };
    $('shiftL').addEventListener('click', () => bump('shift', -1));
    $('shiftR').addEventListener('click', () => bump('shift', 1));
    $('fineL').addEventListener('click', () => bump('fine', -20));
    $('fineR').addEventListener('click', () => bump('fine', 20));
    $('resetSong').addEventListener('click', () => { A.S.shift = 0; A.S.fine = 0; saveS(); onTimingChange(); });
    $('dockBtn').addEventListener('click', () => {
      audio();
      const a = $('dockBtn').dataset.action;
      if (a === 'End') E.endAsked = true;
      else if (a === 'Stop') { engineStop(); try { yt.player.pauseVideo(); } catch (e) {} }
      lastDock = '';
    });
    $('dock').addEventListener('click', () => audio());
    $('tl').addEventListener('click', (e) => {
      const dur = yt.dur || (A.lyrics && A.lyrics.duration) || 0;
      if (!dur || !yt.player) return;
      const r = e.currentTarget.getBoundingClientRect();
      const t = ((e.clientX - r.left) / r.width) * dur;
      engineStop();
      ytSeek(t);
      armEngine();
    });
    window.addEventListener('resize', drawTimeline);
    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    if (mq && mq.addEventListener) mq.addEventListener('change', () => { drawTimeline(); renderKey(); });
  }

  function boot() {
    bind();
    renderRecents();
    renderSources();
    requestAnimationFrame(frame);
    const m = location.hash.match(/v=([A-Za-z0-9_-]{11})/);
    if (m) { $('link').value = 'https://youtu.be/' + m[1]; loadLink(m[1]); }
  }

  window.__solo = { A, yt, E, posNow, soloTiming, loadLink, armEngine, engineStop };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
