/* Solo Spot app: YouTube player, lookups, UI. Depends on core.js (window.SoloCore). */
(function () {
  'use strict';
  const C = window.SoloCore;
  const $ = (id) => document.getElementById(id);
  const enc = encodeURIComponent;

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
    start: 0,
    meta: null, // {title, author}
    query: null, // {artist, track}
    lyrics: null, // LRCLIB record
    lyricResults: null,
    lines: null,
    segs: null,
    instrumental: false,
    itunes: null,
    deezer: null,
    deferredPlan: null,
    ab: null, // {agg, beats, docLen, refined}
    previewFeats: [],
    previewTempos: [],
    rankedKeys: [],
    keyResult: null,
    tempo: null,
    cands: [],
    candIdx: -1,
    plan: null,
    steps: {},
    S: {}, // per-video settings
  };
  const DEF = () => ({ key: null, bars: store.get('bars', 4), candT: null, nudge: 0, sync: null, bpb: 4, tf: 1, tadj: 0, tap: null, repeat: false, manualT: null });

  function saveS() {
    if (A.vid) store.set('v:' + A.vid, A.S);
  }

  // ---------- network helpers ----------
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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- YouTube player ----------
  const yt = { player: null, ready: false, state: -1, rate: 1, dur: 0, anchor: null, apiP: null, lastJump: null, created: false };

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

  function setAnchor(ct, wall) {
    const now = Date.now();
    if (!(wall > 0) || Math.abs(wall - now) > 3000) wall = now;
    yt.anchor = { ct, wall };
    // learn how long a jump takes on this device
    const J = yt.lastJump;
    if (J && !J.measured && yt.state === 1 && wall >= J.t + 800 && wall <= J.t + 4000) {
      const d = (wall - J.t) / 1000 - (ct - J.target);
      if (d > 0.005 && d < 0.6) {
        J.measured = true;
        const keyName = J.kind === 'far' ? 'delayFar' : 'delay';
        const prev = store.get(keyName, null);
        const est = prev == null ? d : prev * 0.6 + d * 0.4;
        store.set(keyName, est);
        if (J.kind === 'far') engine.delayFar = est;
        else engine.delayEst = est;
        renderDelayNote();
      } else J.measured = true;
    }
  }

  function posNow() {
    const a = yt.anchor;
    if (!a) return 0;
    if (yt.state === 1) {
      const el = (Date.now() - a.wall) / 1000;
      return a.ct + Math.max(0, Math.min(el, 2)) * (yt.rate || 1);
    }
    return a.ct;
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
    if (typeof i.currentTime === 'number') {
      const wall = typeof i.currentTimeLastUpdated_ === 'number' ? i.currentTimeLastUpdated_ * 1000 : Date.now();
      setAnchor(i.currentTime, wall);
    }
  });

  // Fallback polling in case the player never posts timing messages
  setInterval(() => {
    if (!yt.ready || !yt.player || typeof yt.player.getCurrentTime !== 'function') return;
    try {
      const st = yt.player.getPlayerState();
      if (typeof st === 'number') yt.state = st;
      const ct = yt.player.getCurrentTime();
      if (typeof ct === 'number' && (!yt.anchor || Date.now() - yt.anchor.wall > 1200)) setAnchor(ct, Date.now());
      const du = yt.player.getDuration && yt.player.getDuration();
      if (du > 0 && du !== yt.dur) {
        yt.dur = du;
        onDuration();
      }
    } catch (e) {}
  }, 250);

  async function showVideo(id, start) {
    await loadYTApi();
    yt.anchor = null;
    yt.dur = 0;
    if (!yt.created) {
      yt.created = true;
      yt.player = new YT.Player('player', {
        videoId: id,
        playerVars: { playsinline: 1, rel: 0, start: Math.floor(start || 0) || undefined, origin: location.origin },
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
            if (e.data === 1 || e.data === 2) {
              try {
                setAnchor(yt.player.getCurrentTime(), Date.now());
              } catch (err) {}
            }
          },
          onError: (e) => onPlayerError(e.data),
        },
      });
    } else if (yt.ready) {
      yt.player.cueVideoById({ videoId: id, startSeconds: start || 0 });
    } else {
      // player still booting: wait and retry
      await sleep(400);
      return showVideo(id, start);
    }
  }

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

  // ---------- engine loop ----------
  const engine = new C.SoloEngine({ delayEst: store.get('delay', 0.12), delayFar: store.get('delayFar', store.get('delay', 0.12) + 0.06) });
  setInterval(() => {
    if (A.deferredPlan && engine.state !== 'region') {
      const P = A.deferredPlan;
      const pos = posNow();
      engine.setPlan(P, pos);
      // the solo just ended: don't start another one a moment later
      if (engine.state === 'armed' && pos > P.tIns - 3) engine.state = 'done';
      A.deferredPlan = null;
    }
    if (!engine.plan || !yt.player) return;
    const playing = yt.state === 1;
    const now = Date.now();
    const pos = posNow();
    const cmd = engine.tick(pos, now, playing);
    if (cmd) {
      try {
        yt.player.seekTo(cmd.target, true);
        yt.lastJump = { t: now, target: cmd.target, measured: false, kind: cmd.kind };
      } catch (e) {}
    }
  }, 8);

  // ---------- steps list ----------
  const STEP_ORDER = ['title', 'lyrics', 'db', 'listen'];
  const STEP_LABEL = { title: 'Song', lyrics: 'Vocal timing', db: 'Audio database', listen: 'Listening to previews' };
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
    Object.assign(A, {
      meta: null, query: null, lyrics: null, lyricResults: null, lines: null, segs: null, instrumental: false, itunes: null, deezer: null, ab: null,
      previewFeats: [], previewTempos: [], rankedKeys: [], keyResult: null, tempo: null, cands: [], candIdx: -1, plan: null, steps: {}, deferredPlan: null,
    });
    A._autoOpened = false;
    engine.setPlan(null);
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
    A.start = p.start;
    A.S = Object.assign(DEF(), store.get('v:' + p.id, {}));
    store.set('last', p.id);
    try {
      history.replaceState(null, '', '#v=' + p.id);
    } catch (e) {}
    $('howto').hidden = true;
    $('stage').hidden = false;
    $('playHint').hidden = false;
    $('songTitle').textContent = 'Loading…';
    $('songArtist').textContent = '';
    renderAll();
    try {
      await showVideo(p.id, p.start);
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
    renderSong();
    setStep('title', 'ok', (A.query.artist ? A.query.artist + ' – ' : '') + A.query.track);
    await runLookups(token);
  }

  function targetDuration() {
    return yt.dur || (A.lyrics && A.lyrics.duration) || (A.itunes && A.itunes.dur) || 0;
  }

  async function runLookups(token) {
    const q = A.query;
    const live = () => token === A.token;
    setStep('lyrics', 'busy');
    setStep('db', 'busy');
    setStep('listen', 'busy');
    // the video length helps pick the right version of the lyric timing
    for (let i = 0; i < 12 && !yt.dur && live(); i++) await sleep(250);
    if (!live()) return;
    const pLyrics = findLyrics(q, yt.dur)
      .then((r) => {
        if (!live()) return;
        A.lyrics = r;
        prepLyrics();
        if (r && r.instrumental && !A.lines) setStep('lyrics', 'ok', 'instrumental, any spot works');
        else if (r) setStep('lyrics', 'ok', 'found (' + (A.segs ? A.segs.length : 0) + ' sung lines)');
        else setStep('lyrics', 'bad', 'no synced lyrics found. The solo spot is a guess at two-thirds in.');
        replan();
      })
      .catch(() => {
        if (live()) setStep('lyrics', 'bad', 'lyrics service unreachable');
        replan();
      });
    const pItunes = findItunes(q, yt.dur).then((r) => { if (live()) A.itunes = r; }).catch(() => {});
    const pDeezer = findDeezer(q, yt.dur).then((r) => { if (live()) { A.deezer = r; updateTempo(); } }).catch(() => {});
    await Promise.all([pLyrics, pItunes, pDeezer]);
    if (!live()) return;
    const album = {
      artist: (A.itunes && A.itunes.artist) || (A.lyrics && A.lyrics.artistName) || q.artist,
      track: (A.itunes && A.itunes.track) || q.track,
      dur: (A.lyrics && A.lyrics.duration) || (A.itunes && A.itunes.dur) || yt.dur || 0,
    };
    const pDb = acoustic(album, token)
      .then((r) => {
        if (!live()) return;
        A.ab = r;
        if (r && r.agg && (r.agg.key || r.agg.tempo)) setStep('db', 'ok', 'analysis of ' + r.agg.count + (r.agg.count === 1 ? ' copy' : ' copies') + ' of the recording' + (r.refined ? ', with beat map' : ''));
        else setStep('db', 'bad', 'not in the database (common for songs after 2022)');
        updateKey();
        updateTempo();
      })
      .catch(() => {
        if (live()) setStep('db', 'bad', 'database unreachable');
      });
    const pListen = listenToPreviews(token)
      .then((n) => {
        if (!live()) return;
        if (n) setStep('listen', 'ok', n === 1 ? 'analyzed a 30-second preview' : 'analyzed ' + n + ' 30-second previews');
        else setStep('listen', 'bad', 'no preview available');
        updateKey();
        updateTempo();
      })
      .catch(() => {
        if (live()) setStep('listen', 'bad', 'preview analysis failed');
      });
    await Promise.all([pDb, pListen]);
    if (!live()) return;
    updateKey();
    updateTempo();
    renderSources();
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
    let bpm = 0;
    try {
      const t = await jsonp('https://api.deezer.com/track/' + x.id, 9000);
      bpm = t && t.bpm > 0 ? t.bpm : 0;
    } catch (e) {}
    return { bpm, preview: x.preview, dur: x.duration };
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
    let recs = ((mb && mb.recordings) || []).filter((r) => r.score >= 85 && C.similarity(r.title, track) >= 0.5);
    const dur = album.dur;
    recs.sort((a, b) => {
      const da = a.length ? Math.abs(a.length / 1000 - dur) : 999;
      const db = b.length ? Math.abs(b.length / 1000 - dur) : 999;
      return da - db;
    });
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
    if (!entries.length) return { agg: { key: null, tempo: null, count: 0 } };
    const agg = C.aggregateAcoustic(entries, dur);
    const out = { agg, beats: null, refined: null, docLen: 0 };
    // beat map from the best-matching copy
    if (agg.pick && agg.pick.mbid) {
      try {
        const doc = await fetchJSON('https://acousticbrainz.org/api/v1/' + agg.pick.mbid + '/low-level', 15000);
        const beats = doc && doc.rhythm && doc.rhythm.beats_position;
        const len = doc && doc.metadata && doc.metadata.audio_properties && doc.metadata.audio_properties.length;
        if (Array.isArray(beats) && beats.length > 32) {
          out.beats = beats;
          out.docLen = len || 0;
          out.refined = C.refineFromBeats(beats);
        }
      } catch (e) {}
    }
    return out;
  }

  async function decodePreview(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = await r.arrayBuffer();
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new OAC(1, 44100, 44100);
    const audio = await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(buf, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
    const n = audio.length;
    const ch = audio.numberOfChannels;
    const mono = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      const d = audio.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += d[i] / ch;
    }
    return { mono, sr: audio.sampleRate };
  }

  async function listenToPreviews(token) {
    const urls = [];
    if (A.itunes && A.itunes.preview) urls.push({ url: A.itunes.preview, name: 'apple' });
    if (A.deezer && A.deezer.preview) urls.push({ url: A.deezer.preview, name: 'deezer' });
    let n = 0;
    for (const u of urls) {
      try {
        const { mono, sr } = await decodePreview(u.url);
        if (token !== A.token) return n;
        await sleep(0);
        const f = C.keyFeatures(mono, sr);
        await sleep(0);
        const tp = C.tempoFromPCM(mono, sr);
        if (token !== A.token) return n;
        A.previewFeats.push(f);
        if (tp && tp.bpm) A.previewTempos.push({ bpm: tp.bpm, name: u.name });
        n++;
        updateKey();
        updateTempo();
      } catch (e) {}
    }
    return n;
  }

  // ---------- derive key / tempo ----------
  function updateKey() {
    A.rankedKeys = C.rankKeys(A.previewFeats);
    A.keyResult = C.combineKeys(A.rankedKeys, A.ab && A.ab.agg);
    renderKey();
  }

  function updateTempo() {
    const src = [];
    for (const p of A.previewTempos) src.push({ bpm: p.bpm, w: 1, name: 'preview', rank: p.name === 'apple' ? 2 : 2.2 });
    if (A.ab && A.ab.refined && A.ab.refined.bpm) src.push({ bpm: A.ab.refined.bpm, w: 1.2, name: 'beatmap', rank: 1 });
    else if (A.ab && A.ab.agg && A.ab.agg.tempo) src.push({ bpm: A.ab.agg.tempo.bpm, w: 1, name: 'database', rank: 3 });
    if (A.deezer && A.deezer.bpm) src.push({ bpm: A.deezer.bpm, w: 0.7, name: 'deezer', rank: 4 });
    A.tempo = C.chooseTempo(src);
    renderTempo();
    replan();
  }

  function effectiveBpm() {
    const S = A.S;
    let b = S.tap || (A.tempo && A.tempo.bpm) || 0;
    if (!b) return 0;
    if (!S.tap) b *= S.tf || 1;
    return b + (S.tadj || 0);
  }

  // ---------- lyrics prep + plan ----------
  function prepLyrics() {
    const L = A.lyrics;
    A.lines = null;
    A.segs = null;
    A.instrumental = false;
    if (!L) return;
    if (L.syncedLyrics) {
      A.lines = C.parseLRC(L.syncedLyrics);
      A.segs = C.vocalSegments(A.lines, L.duration || targetDuration());
      if (!A.segs.length) A.instrumental = true;
    } else if (L.instrumental) A.instrumental = true;
    autoSync();
  }

  function onDuration() {
    // a version of the lyric timing that matches this video's length beats the album version
    if (A.lyrics && A.lyricResults && yt.dur && A.query && Math.abs((A.lyrics.duration || 0) - yt.dur) > 2.5) {
      const r = C.pickLyrics(A.lyricResults, A.query.artist, A.query.track, yt.dur);
      if (r && r !== A.lyrics && Math.abs((r.duration || 0) - yt.dur) <= 3) {
        A.lyrics = r;
        prepLyrics();
        setStep('lyrics', 'ok', 'found (' + (A.segs ? A.segs.length : 0) + ' sung lines)');
      }
    }
    autoSync();
    replan();
  }

  function autoSync() {
    renderSync();
  }

  function syncOffset() {
    return A.S.sync == null ? 0 : A.S.sync;
  }

  function syncStatus() {
    if (!A.lyrics || !A.segs || !A.segs.length) return null;
    if (A.S.sync != null) return { kind: 'set' };
    if (!yt.dur || !A.lyrics.duration) return { kind: 'unknown' };
    const diff = yt.dur - A.lyrics.duration;
    if (Math.abs(diff) <= 2.5) return { kind: 'match', diff };
    return { kind: 'mismatch', diff };
  }

  function replan() {
    const S = A.S;
    const bpm = effectiveBpm();
    const dur = targetDuration();
    A.plan = null;
    A.cands = [];
    A.candIdx = -1;
    if (!bpm || !dur) {
      A.deferredPlan = null;
      engine.setPlan(null);
      renderSolo();
      return;
    }
    const period = 60 / bpm;
    const bpb = S.bpb || 4;
    const barLen = period * bpb;
    const bars = S.bars || 4;
    const off = syncOffset();
    let tIns = null;
    let gaps = [];
    let label = '';
    if (A.segs && A.segs.length) {
      const lrcDur = (A.lyrics && A.lyrics.duration) || dur;
      const r = C.insertionCandidates(A.segs, lrcDur, barLen, bars);
      A.cands = r.cands;
      gaps = r.gaps.map((g) => ({ start: g.start + off, end: g.end + off, kind: g.kind }));
      if (A.cands.length) {
        let idx = C.bestCandidateIndex(A.cands);
        if (S.candT != null) {
          let bd = Infinity;
          A.cands.forEach((c, i) => {
            const d = Math.abs(c.tIns - S.candT);
            if (d < bd) {
              bd = d;
              idx = i;
            }
          });
        }
        A.candIdx = idx;
        const c = A.cands[idx];
        tIns = c.tIns + off;
        label = c.label;
      }
    } else if (A.instrumental) {
      gaps = [{ start: 0, end: dur, kind: 'all' }];
    }
    if (S.manualT != null) {
      tIns = S.manualT;
      label = 'your spot at ' + C.fmtTime(tIns);
    }
    if (tIns == null) {
      tIns = dur * 0.66;
      label = A.instrumental ? 'two-thirds of the way in' : 'a guess at two-thirds in';
    }
    tIns += S.nudge || 0;
    // beat map, when it lines up with this upload's timing
    let grid = C.makeGrid({ period });
    const ab = A.ab;
    if (ab && ab.beats && ab.refined && !S.tap && !S.tadj) {
      const albumDur = (A.lyrics && A.lyrics.duration) || (A.itunes && A.itunes.dur) || 0;
      const lenOk = !albumDur || !ab.docLen || Math.abs(ab.docLen - albumDur) < 3;
      const ratio = Math.round(period / ab.refined.period);
      const close = ratio >= 1 && ratio <= 4 && Math.abs((ab.refined.period * ratio) / period - 1) < 0.03;
      if (lenOk && close) grid = C.makeGrid({ period, beats: ab.beats, beatOffset: off, ratio });
    }
    const plan = C.planSolo({ tIns, gaps, grid, soloBars: bars, bpb, minStart: 0.8 });
    plan.label = label;
    plan.gridBeats = grid.hasBeats;
    A.plan = plan;
    engine.repeatForever = !!S.repeat;
    applyPlan(plan);
    renderSolo();
  }

  function samePlan(a, b) {
    if (!a || !b) return false;
    const eq = (x, y) => Math.abs(x - y) < 0.002;
    return eq(a.tIns, b.tIns) && eq(a.rs, b.rs) && eq(a.re, b.re) && a.n === b.n && a.exit === b.exit && a.loopBars === b.loopBars;
  }

  function applyPlan(plan) {
    if (samePlan(plan, engine.plan)) {
      engine.plan = plan;
      A.deferredPlan = null;
      return;
    }
    if (engine.plan && engine.state === 'region' && yt.state === 1) {
      A.deferredPlan = plan; // don't pull the rug out mid-solo
      return;
    }
    A.deferredPlan = null;
    engine.setPlan(plan, yt.anchor ? posNow() : 0);
  }

  // ---------- rendering ----------
  function renderAll() {
    renderSong();
    renderKey();
    renderTempo();
    renderSolo();
    renderSync();
    renderDelayNote();
    renderSources();
    $('repeatSolo').checked = !!A.S.repeat;
  }

  function renderSong() {
    const q = A.query;
    $('songTitle').textContent = q ? q.track || 'Unknown song' : 'Loading…';
    $('songArtist').textContent = q && q.artist ? q.artist : '';
  }

  function lookupsPending() {
    const st = (k) => !A.steps[k] || A.steps[k].status === 'busy';
    return !!A.query && (st('db') || st('listen'));
  }

  function keyOf() {
    const S = A.S;
    if (S.key) return { pc: S.key.pc, scale: S.key.scale, manual: true };
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
    const name = $('keyName');
    const tag = $('keyTag');
    const play = $('keyPlay');
    const facts = $('keyFacts');
    const chips = $('keyChips');
    facts.textContent = '';
    chips.textContent = '';
    $('fretboard').textContent = '';
    if (!k) {
      const busy = !A.query || lookupsPending();
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
    const add = (t) => {
      const li = document.createElement('li');
      li.textContent = t;
      facts.append(li);
    };
    add('Full scale: ' + adv.full + '. ' + adv.same + '.');
    add('Root on the low E string: fret ' + rf.lowE.join(' or ') + '. On the A string: fret ' + rf.a.join(' or ') + '.');
    if (k.scale === 'major') add('Bluesier option: ' + adv.extra + '.');
    else add('Grittier option: ' + adv.extra + '.');
    drawFretboard(k);
    if (k.manual) tag.textContent = 'set by you';
    else if (A.keyResult && A.keyResult.sure) tag.textContent = 'two checks agree';
    else tag.textContent = 'best guess';
    tag.className = 'tag' + (!k.manual && A.keyResult && A.keyResult.sure ? ' good' : '');
    const rel = C.relativeKey(k.pc, k.scale);
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = 'Sounds off? One tap to switch:';
    chips.append(lbl);
    chips.append(chip((k.scale === 'major' ? 'Sounds minor? ' : 'Sounds major? ') + C.keyLabel(rel.pc, rel.scale), () => setKey(rel)));
    if (A.keyResult) {
      for (const a of A.keyResult.alts) {
        if (a.pc === k.pc && a.scale === k.scale) continue;
        if (a.pc === rel.pc && a.scale === rel.scale) continue;
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
    for (const scale of ['major', 'minor']) {
      for (let pc = 0; pc < 12; pc++) wrap.append(chip(C.keyLabel(pc, scale), () => setKey({ pc, scale })));
    }
    container.append(wrap);
  }

  // Box-1 pentatonic shape for the key, roots highlighted
  function drawFretboard(k) {
    const NS = 'http://www.w3.org/2000/svg';
    const minorRoot = k.scale === 'minor' ? k.pc : (k.pc + 9) % 12;
    let f = (minorRoot - 4 + 12) % 12;
    if (f === 0) f = 12;
    const frets = [f, f + 1, f + 2, f + 3];
    const shape = [[0, 3], [0, 3], [0, 2], [0, 2], [0, 2], [0, 3]]; // high e .. low E
    const open = [4, 11, 7, 2, 9, 4];
    const W = 420, H = 150, left = 34, right = 14, top = 18, bottom = 26;
    const colW = (W - left - right) / 4;
    const rowH = (H - top - bottom) / 5;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', C.scaleAdvice(k.pc, k.scale).main + ' shape starting at fret ' + f);
    const el = (name, attrs, text) => {
      const e = document.createElementNS(NS, name);
      for (const a in attrs) e.setAttribute(a, attrs[a]);
      if (text != null) e.textContent = text;
      svg.append(e);
      return e;
    };
    el('rect', { x: left, y: top, width: W - left - right, height: H - top - bottom, rx: 6, fill: 'var(--surface-2)' });
    for (let i = 0; i <= 4; i++) el('line', { x1: left + i * colW, y1: top, x2: left + i * colW, y2: H - bottom, stroke: 'var(--fret)', 'stroke-width': i === 0 ? 3 : 1.5 });
    for (let s = 0; s < 6; s++) {
      const y = top + s * rowH;
      el('line', { x1: left, y1: y, x2: W - right, y2: y, stroke: 'var(--muted)', 'stroke-width': 1 + s * 0.35 });
      el('text', { x: left - 12, y: y + 4, 'text-anchor': 'middle', 'font-size': 12, 'font-family': 'var(--mono)', fill: 'var(--muted)' }, ['e', 'B', 'G', 'D', 'A', 'E'][s]);
    }
    for (let i = 0; i < 4; i++) el('text', { x: left + (i + 0.5) * colW, y: H - 6, 'text-anchor': 'middle', 'font-size': 13, 'font-family': 'var(--mono)', fill: 'var(--muted)' }, String(frets[i]));
    for (let s = 0; s < 6; s++) {
      for (const d of shape[s]) {
        const fret = f + d;
        const pc = (open[s] + fret) % 12;
        const root = pc === k.pc;
        const cx = left + (d + 0.5) * colW;
        const cy = top + s * rowH;
        el('circle', { cx, cy, r: 9, fill: root ? 'var(--accent)' : 'var(--ink)', stroke: 'var(--surface)', 'stroke-width': 2 });
      }
    }
    $('fretboard').append(svg);
  }

  function renderTempo() {
    const bpm = effectiveBpm();
    const S = A.S;
    const el = $('bpm');
    el.textContent = '';
    el.append(bpm ? bpm.toFixed(1) : '–');
    const sm = document.createElement('small');
    sm.textContent = 'BPM';
    el.append(sm);
    const tag = $('tempoTag');
    if (S.tap) tag.textContent = 'tapped by you';
    else if (A.tempo) tag.textContent = A.tempo.source === 'beatmap' ? 'from a full beat map' : A.tempo.agree > 1 ? A.tempo.agree + ' sources agree' : 'one source';
    else tag.textContent = '';
    const note = $('tempoNote');
    const barSec = bpm ? (60 / bpm) * (S.bpb || 4) : 0;
    note.textContent = bpm ? (S.bpb === 3 ? '3/4' : '4/4') + ' · one bar ≈ ' + barSec.toFixed(1) + ' s' : A.query ? 'Working it out…' : '';
    $('halfT').setAttribute('aria-pressed', String((S.tf || 1) < 1));
    $('doubleT').setAttribute('aria-pressed', String((S.tf || 1) > 1));
    $('bpmVal').textContent = (S.tadj >= 0 ? '+' : '') + (S.tadj || 0).toFixed(1);
    $('beats34').textContent = S.bpb === 3 ? 'Back to 4/4' : '3/4 time';
    // bars segment hints
    document.querySelectorAll('#barsSeg button').forEach((b) => {
      const n = +b.dataset.bars;
      b.setAttribute('aria-pressed', String(n === (S.bars || 4)));
      const sm2 = b.querySelector('small');
      sm2.textContent = barSec ? '≈ ' + Math.round(n * barSec) + ' s' : 'bars';
    });
  }

  function renderSolo() {
    const P = A.plan;
    const head = $('soloHead');
    const sub = $('soloSub');
    const tag = $('soloTag');
    $('prevSpot').disabled = !(A.cands.length > 1 && A.candIdx > 0) || A.S.manualT != null;
    $('nextSpot').disabled = !(A.cands.length > 1 && A.candIdx < A.cands.length - 1) || A.S.manualT != null;
    $('goSolo').disabled = !P;
    renderTempo();
    if (!P) {
      head.textContent = A.query ? 'Finding the spot…' : '—';
      sub.textContent = A.query && !effectiveBpm() && !lookupsPending() ? "Couldn't get the tempo. Tap along with Tap tempo below." : '';
      sub.className = 'solosub';
      tag.textContent = '';
      drawTimeline();
      return;
    }
    head.textContent = cap(P.label) + ' · ' + C.fmtTime(P.tIns);
    tag.textContent = A.cands.length > 1 && A.S.manualT == null ? 'spot ' + (A.candIdx + 1) + ' of ' + A.cands.length : '';
    const secs = (P.re - P.rs) * P.n;
    let t;
    if (P.hasVocals && !(A.segs && A.segs.length) && !A.instrumental) {
      t = "Without vocal timing the loop may catch some singing. While the song plays, open Fine-tune timing and tap 'Put the solo here' just as a new section starts.";
      sub.className = 'solosub warn';
    } else if (P.hasVocals) {
      t = 'No singing-free bars near here, so you may hear some vocals in the loop.' + (A.cands.length > 1 ? ' Try an earlier or later spot.' : '');
      sub.className = 'solosub warn';
    } else {
      sub.className = 'solosub';
      if (!P.exit && P.n === 1) t = 'Repeats the ' + P.loopBars + ' bars before the vocals come back (' + secs.toFixed(1) + ' s).';
      else if (!P.exit) t = 'Repeats the ' + P.loopBars + ' bars before the vocals come back, ' + P.n + ' times (' + secs.toFixed(1) + ' s).';
      else t = 'Borrows ' + P.loopBars + ' instrumental bars from ' + C.fmtTime(P.rs) + (P.n > 1 ? ', ' + P.n + ' times' : '') + ' (' + secs.toFixed(1) + ' s).';
      if (P.soloBars > P.loopBars * P.n) t += '';
    }
    sub.textContent = t;
    renderEditWarn();
    drawTimeline();
  }

  function renderEditWarn() {
    const box = $('editWarn');
    const st = syncStatus();
    if (!st || st.kind !== 'mismatch' || !A.query) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    $('editWarnText').textContent = 'This video is ' + Math.abs(st.diff).toFixed(0) + ' s ' + (st.diff > 0 ? 'longer' : 'shorter') + ' than the album version, so the vocal timing may drift. The official audio upload lines up exactly.';
    const q = (A.query.artist ? A.query.artist + ' ' : '') + A.query.track + ' official audio';
    $('findAudio').href = 'https://www.youtube.com/results?search_query=' + enc(q);
  }

  function cap(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function renderSync() {
    const st = syncStatus();
    const note = $('syncNote');
    $('syncVal').textContent = (syncOffset() >= 0 ? '+' : '') + syncOffset().toFixed(1) + ' s';
    if (!st) note.textContent = A.lyrics ? 'No sung lines to sync for this song.' : 'Sync becomes available once vocal timing is found.';
    else if (st.kind === 'set') note.textContent = 'Synced by you. Tap again any time the first line starts.';
    else if (st.kind === 'match') note.textContent = 'This upload matches the album timing, so no sync is needed.';
    else if (st.kind === 'mismatch') note.textContent = 'This upload is ' + Math.abs(st.diff).toFixed(0) + ' s ' + (st.diff > 0 ? 'longer' : 'shorter') + ' than the album version. While it plays, tap the button the moment the singing first starts.';
    else note.textContent = 'Play the video to check the timing.';
    renderEditWarn();
    const tuneOpen = st && st.kind === 'mismatch';
    if (tuneOpen && !A._autoOpened) {
      $('tuneCard').open = true;
      A._autoOpened = true;
    }
    $('syncTap').disabled = !(A.segs && A.segs.length);
    $('ptVal').textContent = (A.S.nudge >= 0 ? '+' : '') + (A.S.nudge || 0).toFixed(1) + ' s';
    $('soloHere').textContent = A.S.manualT != null ? 'Back to automatic spot' : 'Put the solo here';
  }

  function renderDelayNote() {
    const d = store.get('delay', null);
    const f = store.get('delayFar', null);
    $('delayNote').textContent = d == null ? 'Jump timing on this phone is learned automatically during your first solo.' : 'Learned jump delay on this device: ' + Math.round(d * 1000) + ' ms' + (f != null ? ' (long jumps ' + Math.round(f * 1000) + ' ms)' : '') + '.';
  }

  function renderSources() {
    const s = $('sources');
    s.textContent = '';
    const parts = ['Vocal timing: LRCLIB.', 'Key and tempo: AcousticBrainz audio analysis plus 30-second previews from Apple Music and Deezer, analyzed on this phone.'];
    s.textContent = parts.join(' ');
  }

  // ---------- timeline ----------
  function drawTimeline() {
    const cv = $('tl');
    const box = cv.getBoundingClientRect();
    if (!box.width) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(box.width * dpr);
    const H = Math.round(box.height * dpr);
    if (cv.width !== W || cv.height !== H) {
      cv.width = W;
      cv.height = H;
    }
    const ctx = cv.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    const col = (v) => css.getPropertyValue(v).trim() || '#888';
    ctx.clearRect(0, 0, W, H);
    const dur = targetDuration();
    const trackY = H * 0.3;
    const trackH = H * 0.4;
    ctx.fillStyle = col('--surface-2');
    roundRect(ctx, 0, trackY, W, trackH, 4 * dpr);
    ctx.fill();
    if (!dur) return;
    const x = (t) => Math.max(0, Math.min(W, (t / dur) * W));
    const off = syncOffset();
    if (A.segs) {
      ctx.fillStyle = col('--vocal');
      for (const sgm of A.segs) {
        const x0 = x(sgm.start + off);
        const x1 = Math.max(x0 + 1, x(sgm.end + off));
        ctx.fillRect(x0, trackY, x1 - x0, trackH);
      }
    }
    // candidate ticks
    ctx.fillStyle = col('--muted');
    A.cands.forEach((c, i) => {
      if (i === A.candIdx) return;
      const cx = x(c.tIns + off);
      ctx.fillRect(cx - dpr, trackY + trackH + 3 * dpr, 2 * dpr, 6 * dpr);
    });
    const P = A.plan;
    if (P) {
      ctx.fillStyle = col('--accent-soft');
      ctx.fillRect(x(P.rs), trackY - 4 * dpr, Math.max(2 * dpr, x(P.re) - x(P.rs)), trackH + 8 * dpr);
      ctx.fillStyle = col('--accent');
      const px = x(P.tIns);
      ctx.fillRect(px - 1.5 * dpr, 2 * dpr, 3 * dpr, H - 4 * dpr);
      ctx.beginPath();
      ctx.moveTo(px - 6 * dpr, 2 * dpr);
      ctx.lineTo(px + 6 * dpr, 2 * dpr);
      ctx.lineTo(px, 10 * dpr);
      ctx.closePath();
      ctx.fill();
    }
    if (yt.anchor) {
      ctx.fillStyle = col('--ink');
      const hx = x(posNow());
      ctx.fillRect(hx - dpr, trackY - 6 * dpr, 2 * dpr, trackH + 12 * dpr);
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------- dock ----------
  let lastDock = '';
  function renderDock() {
    const led = $('led');
    const main = $('dockMain');
    const sub = $('dockSub');
    const barsEl = $('dockBars');
    const dock = $('dock');
    const P = A.plan;
    let state = 'idle';
    let m = 'Ready when you are';
    let s = 'Paste a YouTube link to start';
    let prog = null;
    if (A.vid) {
      m = 'Loading…';
      s = 'Getting the song ready';
      if (P) {
        const pos = posNow();
        const playing = yt.state === 1 || yt.state === 3;
        const sp = engine.soloProgress(pos);
        if (sp && playing) {
          state = 'live';
          m = sp.bars ? 'Solo · bar ' + Math.min(sp.bar, sp.bars) + ' of ' + sp.bars : 'Solo · looping';
          s = 'Vocals return after this';
          prog = sp;
        } else if (engine.state === 'armed') {
          const until = P.tIns - pos;
          state = playing ? 'wait' : 'idle';
          m = playing ? 'Solo in ' + C.fmtTime(Math.max(0, until)) : yt.state === 2 ? 'Paused' : 'Tap the video to start';
          s = cap(P.label) + ' · ' + P.soloBars + ' bars';
        } else if (engine.state === 'done') {
          m = playing ? 'Solo done' : 'Paused';
          s = 'Drag back before ' + C.fmtTime(P.tIns) + ' or tap "Play from just before" for another take';
        }
      } else if (A.query) {
        s = 'Working out the key and solo spot';
      }
    }
    const sig = state + '|' + m + '|' + s + '|' + (prog ? prog.bar : '');
    led.className = 'led' + (state === 'live' ? ' live' : state === 'wait' ? ' wait' : '');
    dock.classList.toggle('solo', state === 'live');
    if (sig !== lastDock) {
      main.textContent = m;
      sub.textContent = s;
      lastDock = sig;
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
        const isDone = i < prog.bar - 1;
        sp.className = isDone ? 'done' : '';
        let fill = sp.firstChild;
        if (i === prog.bar - 1) {
          if (!fill) {
            fill = document.createElement('i');
            sp.append(fill);
          }
          fill.style.width = Math.round(prog.barFrac * 100) + '%';
        } else if (fill) fill.remove();
      }
    }
  }

  function frame() {
    renderDock();
    if (A.vid && yt.state === 1) drawTimeline();
    requestAnimationFrame(frame);
  }
  // keep the dock fresh even when animation frames are paused
  setInterval(renderDock, 150);

  // ---------- song form ----------
  function openSongForm() {
    const f = $('songForm');
    f.hidden = false;
    $('fArtist').value = (A.query && A.query.artist) || '';
    $('fTrack').value = (A.query && A.query.track) || '';
  }

  // ---------- events ----------
  function bind() {
    const link = $('link');
    $('pasteBtn').addEventListener('click', async () => {
      let txt = '';
      try {
        if (navigator.clipboard && navigator.clipboard.readText) txt = await navigator.clipboard.readText();
      } catch (e) {}
      if (txt && C.parseYouTubeId(txt)) {
        link.value = txt.trim();
        loadLink(txt);
      } else if (link.value && C.parseYouTubeId(link.value)) {
        loadLink(link.value);
      } else {
        link.focus();
        const msg = $('linkMsg');
        msg.textContent = txt ? "Your clipboard doesn't have a YouTube link. Copy it from YouTube's Share button first." : 'Long-press the box above and choose Paste.';
        msg.className = 'msg';
      }
    });
    link.addEventListener('input', () => {
      if (C.parseYouTubeId(link.value)) loadLink(link.value);
    });
    link.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loadLink(link.value);
    });

    $('editSong').addEventListener('click', () => {
      const f = $('songForm');
      if (f.hidden) openSongForm();
      else f.hidden = true;
    });
    $('cancelSong').addEventListener('click', () => ($('songForm').hidden = true));
    $('songForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const artist = $('fArtist').value.trim();
      const track = $('fTrack').value.trim();
      if (!track) return;
      $('songForm').hidden = true;
      const vid = A.vid;
      const S = A.S;
      const meta = A.meta;
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
      replan();
    });
    const pickCand = (delta) => {
      if (!A.cands.length) return;
      const i = Math.max(0, Math.min(A.cands.length - 1, A.candIdx + delta));
      A.S.candT = A.cands[i].tIns;
      A.S.nudge = 0;
      saveS();
      replan();
      renderSync();
    };
    $('prevSpot').addEventListener('click', () => pickCand(-1));
    $('nextSpot').addEventListener('click', () => pickCand(1));
    $('goSolo').addEventListener('click', () => {
      const P = A.plan;
      if (!P || !yt.player) return;
      const lead = Math.max(6, ((P.re - P.rs) / P.loopBars) * 2 + 2);
      const t = Math.max(0, P.tIns - lead);
      try {
        yt.player.seekTo(t, true);
        yt.anchor = { ct: t, wall: Date.now() };
        engine.setPlan(P, t);
        yt.player.playVideo();
      } catch (e) {}
    });
    $('repeatSolo').addEventListener('change', (e) => {
      A.S.repeat = e.target.checked;
      engine.repeatForever = A.S.repeat;
      saveS();
    });
    $('tl').addEventListener('click', (e) => {
      const dur = targetDuration();
      if (!dur || !yt.player) return;
      const r = e.currentTarget.getBoundingClientRect();
      const t = ((e.clientX - r.left) / r.width) * dur;
      try {
        yt.player.seekTo(t, true);
        yt.anchor = { ct: t, wall: Date.now() };
        if (A.plan) engine.setPlan(A.plan, t);
      } catch (err) {}
    });

    $('halfT').addEventListener('click', () => {
      A.S.tap = null;
      A.S.tf = (A.S.tf || 1) < 1 ? 1 : 0.5;
      saveS();
      replan();
    });
    $('doubleT').addEventListener('click', () => {
      A.S.tap = null;
      A.S.tf = (A.S.tf || 1) > 1 ? 1 : 2;
      saveS();
      replan();
    });
    let taps = [];
    $('tapT').addEventListener('click', () => {
      const now = performance.now();
      if (taps.length && now - taps[taps.length - 1] > 2500) taps = [];
      taps.push(now);
      if (taps.length >= 4) {
        const d = [];
        for (let i = 1; i < taps.length; i++) d.push(taps[i] - taps[i - 1]);
        d.sort((a, b) => a - b);
        const med = d[d.length >> 1];
        A.S.tap = Math.round((60000 / med) * 10) / 10;
        A.S.tadj = 0;
        saveS();
        replan();
      }
      $('tapT').textContent = taps.length < 4 ? 'Tap ' + (4 - taps.length) + ' more' : 'Tap tempo';
    });
    $('bpmMinus').addEventListener('click', () => {
      A.S.tadj = Math.round(((A.S.tadj || 0) - 0.1) * 10) / 10;
      saveS();
      replan();
    });
    $('bpmPlus').addEventListener('click', () => {
      A.S.tadj = Math.round(((A.S.tadj || 0) + 0.1) * 10) / 10;
      saveS();
      replan();
    });
    $('beats34').addEventListener('click', () => {
      A.S.bpb = A.S.bpb === 3 ? 4 : 3;
      saveS();
      replan();
    });
    $('syncTap').addEventListener('click', () => {
      if (!A.segs || !A.segs.length || !yt.anchor) return;
      const first = A.segs[0].start;
      A.S.sync = Math.round((posNow() - 0.2 - first) * 10) / 10;
      saveS();
      renderSync();
      replan();
    });
    const bumpSync = (d) => {
      A.S.sync = Math.round((syncOffset() + d) * 10) / 10;
      saveS();
      renderSync();
      replan();
    };
    $('syncMinus').addEventListener('click', () => bumpSync(-0.1));
    $('syncPlus').addEventListener('click', () => bumpSync(0.1));
    const bumpPt = (d) => {
      A.S.nudge = Math.round(((A.S.nudge || 0) + d) * 10) / 10;
      saveS();
      renderSync();
      replan();
    };
    $('ptMinus').addEventListener('click', () => bumpPt(-0.1));
    $('ptPlus').addEventListener('click', () => bumpPt(0.1));
    $('soloHere').addEventListener('click', () => {
      if (!yt.anchor) return;
      if (A.S.manualT != null) A.S.manualT = null;
      else A.S.manualT = Math.round(posNow() * 10) / 10;
      A.S.nudge = 0;
      saveS();
      replan();
      renderSync();
    });
    $('resetSong').addEventListener('click', () => {
      if (!A.vid) return;
      store.del('v:' + A.vid);
      A.S = DEF();
      renderAll();
      updateKey();
      replan();
      renderSync();
    });
    window.addEventListener('resize', drawTimeline);
    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    if (mq && mq.addEventListener) mq.addEventListener('change', () => { drawTimeline(); renderKey(); });
  }

  function boot() {
    bind();
    renderDelayNote();
    renderSources();
    requestAnimationFrame(frame);
    const m = location.hash.match(/v=([A-Za-z0-9_-]{11})/);
    const id = m ? m[1] : null;
    if (id) {
      $('link').value = 'https://youtu.be/' + id;
      loadLink(id);
    }
  }

  // test hook
  window.__solo = { A, yt, engine, replan, loadLink, posNow };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
