/* Solo Spot core logic: pure functions, no DOM. Works in browsers and Node (for tests). */
(function (root) {
  'use strict';

  // ---------- Music theory ----------
  const MAJOR_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const MINOR_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];

  function pcFromName(name) {
    if (!name) return -1;
    const s = String(name).trim();
    const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[s[0] && s[0].toUpperCase()];
    if (base === undefined) return -1;
    let pc = base;
    for (const ch of s.slice(1)) {
      if (ch === '#' || ch === '♯') pc += 1;
      else if (ch === 'b' || ch === '♭') pc -= 1;
      else break;
    }
    return ((pc % 12) + 12) % 12;
  }

  function keyName(pc, scale) {
    return (scale === 'minor' ? MINOR_NAMES : MAJOR_NAMES)[((pc % 12) + 12) % 12];
  }

  function keyLabel(pc, scale) {
    return keyName(pc, scale) + ' ' + (scale === 'minor' ? 'minor' : 'major');
  }

  function relativeKey(pc, scale) {
    return scale === 'minor' ? { pc: (pc + 3) % 12, scale: 'major' } : { pc: (pc + 9) % 12, scale: 'minor' };
  }

  function rootFrets(pc) {
    const low = (pc - 4 + 12) % 12; // low E string
    const a = (pc - 9 + 12) % 12; // A string
    const list = (f) => (f + 12 <= 15 ? [f, f + 12] : [f]);
    return { lowE: list(low), a: list(a) };
  }

  function scaleAdvice(pc, scale) {
    const n = keyName(pc, scale);
    if (scale === 'minor') {
      const rel = relativeKey(pc, scale);
      return {
        main: n + ' minor pentatonic',
        full: n + ' natural minor',
        extra: n + ' blues scale adds the ♭5 for grit',
        same: 'Same notes as ' + keyName(rel.pc, 'major') + ' major pentatonic',
      };
    }
    const rel = relativeKey(pc, scale);
    return {
      main: n + ' major pentatonic',
      full: n + ' major scale',
      extra: n + ' minor pentatonic over it for a bluesier sound',
      same: 'Same notes as ' + keyName(rel.pc, 'minor') + ' minor pentatonic',
    };
  }

  // ---------- YouTube link + title parsing ----------
  const ID_RE = /^[A-Za-z0-9_-]{11}$/;

  function parseTimeParam(t) {
    if (!t) return 0;
    if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
    const m = String(t).match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!m) return 0;
    return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
  }

  function parseYouTubeId(input) {
    if (!input) return null;
    let s = String(input).trim();
    if (ID_RE.test(s)) return { id: s, start: 0 };
    const urlMatch = s.match(/(?:https?:\/\/)?(?:[\w-]+\.)*(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\/[^\s<>"']*/i);
    if (urlMatch) s = urlMatch[0];
    let url = null;
    try {
      url = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
    } catch (e) {
      url = null;
    }
    let id = null;
    if (url) {
      const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
      if (host === 'youtu.be') id = url.pathname.split('/')[1] || null;
      else if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
        id = url.searchParams.get('v');
        if (!id) {
          const m = url.pathname.match(/\/(?:shorts|embed|live|v|e)\/([A-Za-z0-9_-]{11})/);
          if (m) id = m[1];
        }
      }
    }
    if (!id || !ID_RE.test(id)) {
      const m = s.match(/(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/);
      id = m ? m[1] : null;
    }
    if (!id || !ID_RE.test(id)) return null;
    let start = 0;
    if (url) start = parseTimeParam(url.searchParams.get('t') || url.searchParams.get('start'));
    return { id, start };
  }

  const JUNK_WORDS = /\b(official|video|audio|lyrics?|lyric video|visuali[sz]er|music video|mv|hd|hq|4k|8k|remaster(?:ed)?|\d{4} remaster|explicit|clean|color coded|full song|with lyrics|live|performance|version|edit|mono|stereo|single|album)\b/i;

  function stripJunk(t) {
    let s = String(t || '');
    // bracketed segments that look like junk
    s = s.replace(/[\(\[【「][^\)\]】」]*[\)\]】」]/g, (seg) => (JUNK_WORDS.test(seg) || /\b(ft\.?|feat\.?|featuring)\b/i.test(seg) ? ' ' : seg));
    s = s.replace(/\s+(ft\.?|feat\.?|featuring)\s+.*$/i, ' ');
    s = s.replace(/\s*[|｜].*$/, ' ');
    s = s.replace(/#\S+/g, ' ');
    s = s.replace(/["“”«»]/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/^[\s\-–—:~]+|[\s\-–—:~]+$/g, '');
    return s;
  }

  function splitCamel(s) {
    return s.replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  function cleanAuthor(author) {
    let a = String(author || '').trim();
    a = a.replace(/\s*-\s*Topic$/i, '');
    a = a.replace(/VEVO$/i, '');
    a = a.replace(/\s*(official|music|records|tv|channel)$/i, '');
    if (!/\s/.test(a)) a = splitCamel(a);
    return a.trim();
  }

  function cleanTitle(title, author) {
    const raw = String(title || '');
    const seps = [' - ', ' – ', ' — ', ' -- ', ' ~ ', ' | ', ': '];
    let artist = '';
    let track = '';
    const t = raw.replace(/\s+/g, ' ').trim();
    for (const sep of seps) {
      const i = t.indexOf(sep);
      if (i > 0) {
        artist = stripJunk(t.slice(0, i));
        track = stripJunk(t.slice(i + sep.length));
        break;
      }
    }
    if (!track) {
      track = stripJunk(t);
      artist = cleanAuthor(author);
    }
    if (!artist) artist = cleanAuthor(author);
    return { artist: artist.trim(), track: track.trim() };
  }

  function normText(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function similarity(a, b) {
    const A = new Set(normText(a).split(' ').filter(Boolean));
    const B = new Set(normText(b).split(' ').filter(Boolean));
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    return inter / Math.min(A.size, B.size) * 0.7 + inter / Math.max(A.size, B.size) * 0.3;
  }

  // ---------- Synced lyrics ----------
  const NONVOCAL_RE = /^[\s♪♫♬♩🎵🎶\-–—.…*·]*$|^[\(\[]\s*(instrumental|guitar solo|solo|music|interlude|outro|intro|break|bridge instrumental)\s*[\)\]]$/i;

  function parseLRC(text) {
    const out = [];
    let offset = 0;
    const lines = String(text || '').split(/\r?\n/);
    for (const raw of lines) {
      const off = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
      if (off) {
        offset = parseInt(off[1], 10) / 1000;
        continue;
      }
      let rest = raw;
      const tags = [];
      const re = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
      let m;
      while ((m = rest.match(re))) {
        const frac = m[3] ? parseFloat('0.' + m[3]) : 0;
        tags.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac);
        rest = rest.slice(m[0].length);
      }
      if (!tags.length) continue;
      const txt = rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
      for (const t of tags) out.push({ t: Math.max(0, t - offset), text: txt, nonvocal: NONVOCAL_RE.test(txt) });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  function syllables(text) {
    const s = String(text || '');
    const cjk = s.match(/[぀-ヿ㐀-鿿가-힯]/g);
    let n = cjk ? cjk.length : 0;
    const latin = s.toLowerCase().replace(/[぀-ヿ㐀-鿿가-힯]/g, ' ');
    const groups = latin.match(/[aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿœ]+/g);
    n += groups ? groups.length : 0;
    if (!n && /\p{L}/u.test(s)) n = Math.max(1, Math.round(s.length / 3));
    return n;
  }

  function estimateLineDuration(text) {
    const syl = syllables(text);
    return Math.min(7.5, Math.max(1.0, 0.55 + 0.3 * syl));
  }

  // lines -> vocal segments [{start,end,norm,text}]
  function vocalSegments(lines, duration) {
    const segs = [];
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      if (L.nonvocal || !L.text) continue;
      const next = lines[i + 1];
      const nextT = next ? next.t : (duration || L.t + 8);
      const est = estimateLineDuration(L.text);
      let end;
      if (next && (next.nonvocal || !next.text)) end = Math.min(next.t, L.t + est * 1.8);
      else end = Math.min(nextT, L.t + est);
      end = Math.max(end, L.t + 0.3);
      segs.push({ start: L.t, end, text: L.text, norm: normText(L.text) });
    }
    return segs;
  }

  // vocal-free intervals
  function vocalGaps(segs, duration) {
    const gaps = [];
    if (!segs.length) {
      if (duration) gaps.push({ start: 0, end: duration, kind: 'all' });
      return gaps;
    }
    if (segs[0].start > 0.2) gaps.push({ start: 0, end: segs[0].start, kind: 'intro', after: -1, before: 0 });
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i].end;
      const e = segs[i + 1].start;
      if (e - s > 0.05) gaps.push({ start: s, end: e, kind: 'mid', after: i, before: i + 1 });
    }
    const last = segs[segs.length - 1];
    if (duration && duration - last.end > 0.2) gaps.push({ start: last.end, end: duration, kind: 'outro', after: segs.length - 1, before: -1 });
    return gaps;
  }

  // Group lines into blocks, flag chorus-like blocks
  function sections(segs) {
    const blocks = [];
    let cur = null;
    for (let i = 0; i < segs.length; i++) {
      const g = i > 0 ? segs[i].start - segs[i - 1].end : Infinity;
      if (!cur || g >= 1.8) {
        cur = { first: i, last: i };
        blocks.push(cur);
      } else cur.last = i;
    }
    const counts = new Map();
    for (const s of segs) if (s.norm.length >= 6) counts.set(s.norm, (counts.get(s.norm) || 0) + 1);
    let occ = 0;
    let prevChorus = false;
    for (const b of blocks) {
      let rep = 0;
      let tot = 0;
      for (let i = b.first; i <= b.last; i++) {
        tot++;
        if ((counts.get(segs[i].norm) || 0) >= 2) rep++;
      }
      b.lines = tot;
      b.repeat = tot ? rep / tot : 0;
      b.chorus = tot >= 2 && b.repeat >= 0.5;
      if (b.chorus && !prevChorus) occ++;
      b.chorusN = b.chorus ? occ : 0;
      prevChorus = b.chorus;
    }
    const segBlock = new Array(segs.length);
    blocks.forEach((b, bi) => {
      for (let i = b.first; i <= b.last; i++) segBlock[i] = bi;
    });
    return { blocks, segBlock, chorusCount: occ };
  }

  function fmtTime(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  // Candidate insertion points (where vocals come back after a break)
  function insertionCandidates(segs, duration, barLen, soloBars) {
    const gaps = vocalGaps(segs, duration);
    const sec = sections(segs);
    const cands = [];
    const tailPad = 0.3;
    const entry = 0.3;
    for (const g of gaps) {
      if (g.kind !== 'mid') continue;
      const tIns = g.end - entry;
      const pos = tIns / duration;
      if (pos < 0.3 || pos > 0.92) continue;
      const usable = tIns - (g.start + tailPad);
      if (usable < 0.25) continue;
      const prevB = sec.blocks[sec.segBlock[g.after]];
      const nextB = sec.blocks[sec.segBlock[g.before]];
      const isBreak = prevB !== nextB;
      let label;
      let sStruct = 0.35;
      if (prevB && prevB.chorus && isBreak) {
        label = 'after chorus ' + prevB.chorusN;
        sStruct = prevB.chorusN >= 2 ? 1 : 0.6;
      } else if (nextB && nextB.chorus && isBreak) {
        label = 'before chorus ' + nextB.chorusN;
        sStruct = nextB.chorusN >= 2 ? 0.75 : 0.45;
      } else if (isBreak) {
        label = 'at the ' + fmtTime(tIns) + ' break';
        sStruct = 0.5;
      } else {
        label = 'mid-section at ' + fmtTime(tIns);
        sStruct = 0.15;
      }
      const sPos = Math.exp(-Math.pow(pos - 0.66, 2) / (2 * 0.13 * 0.13));
      const fitBars = barLen ? Math.floor(usable / barLen + 1e-6) : 0;
      const sGap = barLen ? (fitBars >= 1 ? Math.min(1, fitBars / Math.min(soloBars || 4, 4)) : 0.1) : Math.min(1, usable / 6);
      const score = 0.42 * sPos + 0.33 * sStruct + 0.25 * sGap;
      cands.push({ tIns, gapStart: g.start, gapEnd: g.end, label, score, pos, fitBars });
    }
    cands.sort((a, b) => a.tIns - b.tIns);
    return { cands, gaps, sections: sec };
  }

  function bestCandidateIndex(cands) {
    let bi = -1;
    let bs = -1;
    cands.forEach((c, i) => {
      if (c.score > bs) {
        bs = c.score;
        bi = i;
      }
    });
    return bi;
  }

  // ---------- Tempo grid ----------
  // A grid measures musical distance. With beat positions it uses the local beats; otherwise a constant period.
  function makeGrid(opts) {
    const period = opts.period; // seconds per beat
    const beats = opts.beats && opts.beats.length > 16 ? opts.beats : null;
    const off = opts.beatOffset || 0; // ytTime = beatTime + off
    function nearestIdx(t) {
      const x = t - off;
      let lo = 0;
      let hi = beats.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (beats[mid] < x) lo = mid;
        else hi = mid;
      }
      return Math.abs(beats[lo] - x) <= Math.abs(beats[hi] - x) ? lo : hi;
    }
    return {
      period,
      hasBeats: !!beats,
      // time of the point nBeats away from t (negative = earlier)
      shift(t, nBeats) {
        if (beats) {
          const j = nearestIdx(t);
          const k = j + nBeats;
          if (k >= 0 && k < beats.length && Math.abs(beats[j] - (t - off)) < period * 0.75) {
            const d = beats[k] - beats[j];
            // sanity: keep within 6% of constant tempo
            if (Math.abs(d - nBeats * period) <= Math.abs(nBeats) * period * 0.06) return t + d;
          }
        }
        return t + nBeats * period;
      },
    };
  }

  // Plan where the extra bars come from
  // returns {tIns, rs, re, loopBars, n, exit, hasVocals}
  function planSolo(opts) {
    const { tIns, gaps, grid, soloBars, bpb } = opts;
    const tailPad = opts.tailPad == null ? 0.3 : opts.tailPad;
    const headPad = opts.headPad == null ? 0.2 : opts.headPad;
    const minStart = opts.minStart == null ? 0.8 : opts.minStart;
    const sizes = [];
    for (let L = soloBars; L >= 1; L = Math.floor(L / 2)) {
      sizes.push(L);
      if (L === 1) break;
    }
    let best = null;
    const consider = (p) => {
      if (!best || p.jumps < best.jumps || (p.jumps === best.jumps && p.dist < best.dist)) best = p;
    };
    // the gap that ends at tIns
    const home = gaps.find((g) => g.start <= tIns - 0.05 && g.end >= tIns - 0.05);
    for (const L of sizes) {
      const n = soloBars / L;
      if (home) {
        const rs = grid.shift(tIns, -L * bpb);
        if (rs >= home.start + tailPad && rs >= minStart) {
          consider({ tIns, rs, re: tIns, loopBars: L, n, exit: false, jumps: n, dist: tIns - rs, hasVocals: false });
        }
      }
      // other vocal-free stretches earlier in the song
      for (const g of gaps) {
        if (g === home || g.end > tIns + 0.01) continue;
        const lo = Math.max(g.start + tailPad, minStart);
        const hi = g.end - headPad;
        if (hi - lo < L * bpb * grid.period * 0.98) continue;
        // smallest k such that region fits
        const kMin = L;
        const kMax = Math.floor((tIns - lo) / (bpb * grid.period)) + 1;
        for (let k = kMin; k <= kMax; k++) {
          const rs = grid.shift(tIns, -k * bpb);
          const re = grid.shift(rs, L * bpb);
          if (rs >= lo && re <= hi) {
            consider({ tIns, rs, re, loopBars: L, n, exit: true, jumps: n + 1, dist: tIns - rs, hasVocals: false });
            break;
          }
          if (rs < lo) break;
        }
      }
      if (best) break; // biggest loop size that works anywhere
    }
    if (!best) {
      const L = soloBars;
      const rs = grid.shift(tIns, -L * bpb);
      best = { tIns, rs: Math.max(0, rs), re: tIns, loopBars: L, n: 1, exit: false, jumps: 1, dist: tIns - rs, hasVocals: true };
    }
    best.barLen = (best.re - best.rs) / best.loopBars;
    best.soloBars = soloBars;
    return best;
  }

  // Robust tempo from beat positions
  function refineFromBeats(beats) {
    if (!beats || beats.length < 16) return null;
    const d = [];
    for (let i = 1; i < beats.length; i++) d.push(beats[i] - beats[i - 1]);
    const sorted = d.slice().sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    if (!(med > 0.2 && med < 1.6)) return null;
    // integer beat index, tolerating dropped/extra beats
    const idx = [0];
    for (let i = 1; i < beats.length; i++) idx.push(idx[i - 1] + Math.max(1, Math.round(d[i - 1] / med)));
    let use = beats.map((t, i) => [idx[i], t]);
    let a = 0;
    let p = med;
    for (let iter = 0; iter < 3; iter++) {
      const n = use.length;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const [x, y] of use) {
        sx += x; sy += y; sxx += x * x; sxy += x * y;
      }
      const den = n * sxx - sx * sx;
      if (!den) break;
      p = (n * sxy - sx * sy) / den;
      a = (sy - p * sx) / n;
      const res = use.map(([x, y]) => Math.abs(y - (a + p * x)));
      const tol = Math.max(p * 0.12, 0.03);
      const next = use.filter((_, i) => res[i] <= tol * (iter === 0 ? 3 : 1.5));
      if (next.length < 16) break;
      use = next;
    }
    return { period: p, bpm: 60 / p };
  }

  // Combine AcousticBrainz documents into one answer
  function aggregateAcoustic(entries, targetDur) {
    const votes = new Array(24).fill(0);
    let total = 0;
    const scored = [];
    for (const e of entries) {
      let w = 1;
      if (targetDur && e.length) {
        const dd = Math.abs(e.length - targetDur);
        w *= dd <= 2.5 ? 1.6 : dd <= 8 ? 1 : dd <= 25 ? 0.6 : 0.3;
      }
      const pc = pcFromName(e.key);
      if (pc >= 0 && (e.scale === 'major' || e.scale === 'minor')) {
        const v = w * (0.6 + (isFinite(e.strength) ? e.strength : 0.5));
        votes[pc * 2 + (e.scale === 'minor' ? 1 : 0)] += v;
        total += v;
      }
      const cpc = pcFromName(e.chordsKey);
      if (cpc >= 0 && (e.chordsScale === 'major' || e.chordsScale === 'minor')) {
        const v = w * 0.35;
        votes[cpc * 2 + (e.chordsScale === 'minor' ? 1 : 0)] += v;
        total += v;
      }
      scored.push({ e, w });
    }
    let bi = -1;
    let bv = 0;
    votes.forEach((v, i) => {
      if (v > bv) {
        bv = v;
        bi = i;
      }
    });
    const key = bi >= 0 ? { pc: bi >> 1, scale: bi & 1 ? 'minor' : 'major', confidence: total ? bv / total : 0 } : null;
    // tempo cluster
    let tempo = null;
    const withBpm = scored.filter((s) => s.e.bpm > 30 && s.e.bpm < 260);
    if (withBpm.length) {
      let bestC = null;
      for (const c of withBpm) {
        let sup = 0;
        for (const o of withBpm) if (Math.abs(o.e.bpm / c.e.bpm - 1) < 0.02) sup += o.w;
        if (!bestC || sup > bestC.sup) bestC = { bpm: c.e.bpm, sup };
      }
      let sw = 0;
      let sb = 0;
      for (const o of withBpm) {
        if (Math.abs(o.e.bpm / bestC.bpm - 1) < 0.02) {
          sw += o.w;
          sb += o.w * o.e.bpm;
        }
      }
      tempo = { bpm: sb / sw, support: sw };
    }
    // best single recording to pull beats from
    let pick = null;
    for (const s of scored) {
      let q = s.w;
      if (tempo && s.e.bpm && Math.abs(s.e.bpm / tempo.bpm - 1) < 0.02) q *= 1.5;
      if (key && pcFromName(s.e.key) === key.pc && s.e.scale === key.scale) q *= 1.3;
      if (!pick || q > pick.q) pick = { q, mbid: s.e.mbid, length: s.e.length };
    }
    return { key, tempo, pick, count: entries.length };
  }

  // Pull our fields out of an AcousticBrainz bulk low-level response
  function parseAcousticBulk(json) {
    const out = [];
    if (!json || typeof json !== 'object') return out;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const k of Object.keys(json)) {
      if (!uuid.test(k)) continue;
      const v = json[k];
      const docs = [];
      if (v && (v.tonal || v.rhythm)) docs.push(v);
      else if (v && typeof v === 'object') for (const d of Object.values(v)) if (d && (d.tonal || d.rhythm)) docs.push(d);
      for (const d of docs) {
        const t = d.tonal || {};
        const r = d.rhythm || {};
        const ap = (d.metadata && d.metadata.audio_properties) || {};
        out.push({
          mbid: k.toLowerCase(),
          key: t.key_key,
          scale: t.key_scale,
          strength: typeof t.key_strength === 'number' ? t.key_strength : NaN,
          chordsKey: t.chords_key,
          chordsScale: t.chords_scale,
          bpm: typeof r.bpm === 'number' ? r.bpm : NaN,
          length: typeof ap.length === 'number' ? ap.length : NaN,
        });
      }
    }
    return out;
  }

  // Pick the best LRCLIB result
  function pickLyrics(results, artist, track, duration) {
    let best = null;
    for (const r of results || []) {
      if (!r) continue;
      const synced = !!(r.syncedLyrics && r.syncedLyrics.trim());
      if (!synced && !r.instrumental) continue;
      const sT = similarity(r.trackName || r.name, track);
      const sA = artist ? similarity(r.artistName, artist) : 0.5;
      let sD = 0.5;
      if (duration && r.duration) {
        const dd = Math.abs(r.duration - duration);
        sD = dd <= 2 ? 1 : dd <= 6 ? 0.75 : dd <= 20 ? 0.45 : 0.15;
      }
      const score = sT * 0.45 + sA * 0.3 + sD * 0.25 + (synced ? 0.02 : 0);
      if (sT < 0.34) continue;
      if (!best || score > best.score) best = { r, score };
    }
    return best ? best.r : null;
  }

  // ---------- Audio analysis (fallback when no database data) ----------
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang);
      const wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < len / 2; j++) {
          const a = i + j;
          const b = a + len / 2;
          const xr = re[b] * cr - im[b] * ci;
          const xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = t;
        }
      }
    }
  }

  function downsampleTo(samples, sr, target) {
    const f = Math.max(1, Math.round(sr / target));
    if (f === 1) return { x: samples, sr };
    const n = Math.floor(samples.length / f);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < f; k++) s += samples[i * f + k];
      x[i] = s / f;
    }
    return { x, sr: sr / f };
  }

  const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function corr(a, b) {
    const n = a.length;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
      const x = a[i] - ma, y = b[i] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    return da && db ? num / Math.sqrt(da * db) : 0;
  }

  function chromaFromPCM(samples, sr) {
    const { x, sr: r } = downsampleTo(samples, sr, 11025);
    const N = 4096;
    const hop = 2048;
    const chroma = new Float64Array(12);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    const binPc = new Int8Array(N / 2);
    const binW = new Float32Array(N / 2);
    for (let k = 1; k < N / 2; k++) {
      const f = (k * r) / N;
      if (f < 65 || f > 2100) { binPc[k] = -1; continue; }
      const midi = 69 + 12 * Math.log2(f / 440);
      const nearest = Math.round(midi);
      const dev = Math.abs(midi - nearest);
      binPc[k] = ((nearest % 12) + 12) % 12;
      binW[k] = dev < 0.35 ? 1 - dev * 1.5 : 0;
    }
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let s = 0; s + N <= x.length; s += hop) {
      let energy = 0;
      for (let i = 0; i < N; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; energy += re[i] * re[i]; }
      if (energy < 1e-6) continue;
      fft(re, im);
      const frame = new Float64Array(12);
      for (let k = 1; k < N / 2; k++) {
        if (binPc[k] < 0 || !binW[k]) continue;
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        frame[binPc[k]] += Math.log(1 + 10 * mag) * binW[k];
      }
      let mx = 0;
      for (let i = 0; i < 12; i++) mx = Math.max(mx, frame[i]);
      if (mx > 0) for (let i = 0; i < 12; i++) chroma[i] += frame[i] / mx;
    }
    return Array.from(chroma);
  }

  function keyFromChroma(chroma) {
    const scores = [];
    for (let pc = 0; pc < 12; pc++) {
      const rot = (prof) => prof.map((_, i) => prof[(i - pc + 12) % 12]);
      scores.push({ pc, scale: 'major', r: corr(chroma, rot(KK_MAJOR)) });
      scores.push({ pc, scale: 'minor', r: corr(chroma, rot(KK_MINOR)) });
    }
    scores.sort((a, b) => b.r - a.r);
    const top = scores[0];
    const second = scores[1];
    return { pc: top.pc, scale: top.scale, confidence: Math.max(0, Math.min(1, (top.r - second.r) * 4 + 0.35)), r: top.r };
  }

  function onsetEnvelope(samples, sr) {
    const { x, sr: r } = downsampleTo(samples, sr, 11025);
    const N = 1024;
    const hop = 256;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    let prev = null;
    const env = [];
    for (let s = 0; s + N <= x.length; s += hop) {
      for (let i = 0; i < N; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
      fft(re, im);
      const mag = new Float64Array(N / 2);
      for (let k = 0; k < N / 2; k++) mag[k] = Math.log(1 + 100 * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
      let flux = 0;
      if (prev) for (let k = 1; k < N / 2; k++) { const d = mag[k] - prev[k]; if (d > 0) flux += d; }
      env.push(flux);
      prev = mag;
    }
    // remove slow trend
    const out = new Float64Array(env.length);
    const w = 16;
    for (let i = 0; i < env.length; i++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - w); j <= Math.min(env.length - 1, i + w); j++) { s += env[j]; c++; }
      out[i] = Math.max(0, env[i] - s / c);
    }
    return { env: out, rate: r / hop };
  }

  function tempoFromPCM(samples, sr) {
    const { env, rate } = onsetEnvelope(samples, sr);
    const n = env.length;
    const ac = (lag) => {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += env[i] * env[i + lag];
      return s / (n - lag);
    };
    const minLag = Math.floor((rate * 60) / 200);
    const maxLag = Math.ceil((rate * 60) / 60);
    let best = null;
    const vals = [];
    for (let lag = minLag; lag <= maxLag; lag++) {
      const bpm = (60 * rate) / lag;
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.6, 2));
      // reward lags whose multiples also line up
      const v = (ac(lag) + 0.5 * ac(lag * 2) + 0.25 * ac(lag * 4)) * prior;
      vals[lag] = v;
      if (!best || v > best.v) best = { lag, v };
    }
    if (!best) return null;
    // sub-sample refine on the longest multiple that fits
    let mult = 1;
    while (best.lag * mult * 2 < n / 3 && mult < 16) mult *= 2;
    const L = best.lag * mult;
    let peak = L;
    let pv = ac(L);
    for (let l = L - mult; l <= L + mult; l++) { const v = ac(l); if (v > pv) { pv = v; peak = l; } }
    const a = ac(peak - 1), b = ac(peak), c = ac(peak + 1);
    const denom = a - 2 * b + c;
    const delta = denom ? (0.5 * (a - c)) / denom : 0;
    const lagBeat = (peak + Math.max(-0.5, Math.min(0.5, delta))) / mult;
    return { bpm: (60 * rate) / lagBeat };
  }

  // ---------- Playback engine ----------
  // tick(pos, wallMs, playing) -> null or {target, from, to}
  class SoloEngine {
    constructor(opts) {
      opts = opts || {};
      this.lead = opts.lead == null ? 0.045 : opts.lead;
      this.delayEst = opts.delayEst == null ? 0.15 : opts.delayEst;
      this.plan = null;
      this.state = 'idle';
      this.k = 0;
      this.repeatForever = false;
      this.pending = null;
      this.prev = null;
    }
    setPlan(plan, pos) {
      this.plan = plan;
      this.pending = null;
      this.k = 0;
      this.prev = null;
      this.state = plan ? 'armed' : 'idle';
      if (plan && pos != null) this.resync(pos);
    }
    resync(pos) {
      const P = this.plan;
      if (!P) return;
      if (pos < P.tIns - this.lead - 0.05) this.state = 'armed';
      else this.state = 'done';
      this.k = 0;
    }
    soloProgress(pos) {
      const P = this.plan;
      if (!P || this.state !== 'region') return null;
      const loopLen = P.re - P.rs;
      const inLoop = Math.min(loopLen, Math.max(0, pos - P.rs));
      const elapsed = (this.k - 1) * loopLen + inLoop;
      const total = this.repeatForever ? Infinity : P.n * loopLen;
      const barLen = loopLen / P.loopBars;
      return { elapsed, total, bar: Math.floor(elapsed / barLen) + 1, bars: this.repeatForever ? null : P.soloBars, barFrac: (elapsed % barLen) / barLen };
    }
    jump(from, to, pos, wall) {
      const aPrime = from - pos;
      const target = Math.max(0, to + this.delayEst - aPrime);
      this.pending = { wall, target, from, to };
      return { target, from, to };
    }
    tick(pos, wall, playing) {
      const P = this.plan;
      if (!P || !playing) {
        this.prev = null;
        return null;
      }
      if (this.pending) {
        const el = (wall - this.pending.wall) / 1000;
        const tg = this.pending.target;
        const landed = el > 0.03 && pos >= tg - 0.3 && pos <= tg + el + 0.3;
        if (!landed && el < 1.5) return null;
        this.pending = null;
        this.prev = { pos, wall };
        if (!landed) this.resync(pos);
        return null;
      }
      const prev = this.prev;
      this.prev = { pos, wall };
      if (!prev) {
        if (this.state !== 'region') this.resync(pos);
        return null;
      }
      const dt = (wall - prev.wall) / 1000;
      const dp = pos - prev.pos;
      if (!(dp >= -0.05 && dp <= dt + 0.35)) {
        this.resync(pos);
        return null;
      }
      const lead = this.lead;
      if (this.state === 'armed') {
        const trig = P.tIns - lead;
        if (pos >= trig && pos < trig + 0.35) {
          this.k = 1;
          this.state = 'region';
          return this.jump(P.tIns, P.rs, pos, wall);
        }
        if (pos >= trig + 0.35) this.state = 'done';
        return null;
      }
      if (this.state === 'region') {
        const trig = P.re - lead;
        if (pos >= trig && pos < trig + 0.35) {
          if (this.repeatForever || this.k < P.n) {
            this.k++;
            return this.jump(P.re, P.rs, pos, wall);
          }
          this.state = 'done';
          if (P.exit) return this.jump(P.re, P.tIns, pos, wall);
          return null;
        }
        if (pos < P.rs - 0.6 || pos >= trig + 0.35) this.resync(pos);
        return null;
      }
      if (this.state === 'done') {
        if (pos < P.tIns - 1.0) this.state = 'armed';
      }
      return null;
    }
  }

  const api = {
    MAJOR_NAMES, MINOR_NAMES, pcFromName, keyName, keyLabel, relativeKey, rootFrets, scaleAdvice,
    parseYouTubeId, parseTimeParam, cleanTitle, cleanAuthor, stripJunk, normText, similarity,
    parseLRC, syllables, estimateLineDuration, vocalSegments, vocalGaps, sections, insertionCandidates,
    bestCandidateIndex, fmtTime, makeGrid, planSolo, refineFromBeats, aggregateAcoustic, parseAcousticBulk,
    pickLyrics, fft, chromaFromPCM, keyFromChroma, tempoFromPCM, onsetEnvelope, SoloEngine,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SoloCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
