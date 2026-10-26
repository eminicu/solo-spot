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

  // Find chorus occurrences from repeated lines. A run of chorus lines (back-to-back repeats included) is one occurrence.
  function sections(segs) {
    const counts = new Map();
    for (const sg of segs) if (sg.norm.length >= 6) counts.set(sg.norm, (counts.get(sg.norm) || 0) + 1);
    let maxC = 0;
    for (const v of counts.values()) maxC = Math.max(maxC, v);
    const thr = Math.max(2, Math.ceil(maxC * 0.5));
    const isCh = segs.map((sg) => maxC >= 2 && (counts.get(sg.norm) || 0) >= thr);
    const runs = [];
    let cur = null;
    for (let i = 0; i < segs.length; i++) {
      if (isCh[i]) {
        const bridgeable = cur && i - cur.last <= 2 && segs[i].start - segs[cur.last].end < 6;
        if (cur && bridgeable) cur.last = i;
        else {
          cur = { first: i, last: i };
          runs.push(cur);
        }
      }
    }
    // a "run" needs at least two chorus lines unless the chorus is a single repeated line
    const real = runs.filter((r) => r.last > r.first || maxC >= 3);
    real.forEach((r, k) => (r.n = k + 1));
    const firstOf = new Map();
    const lastOf = new Map();
    for (const r of real) {
      firstOf.set(r.first, r);
      lastOf.set(r.last, r);
    }
    return { runs: real, firstOf, lastOf, isChorus: isCh, chorusCount: real.length };
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
    const total = sec.chorusCount;
    const all = [];
    const tailPad = 0.3;
    const entry = 0.3;
    for (const g of gaps) {
      if (g.kind !== 'mid') continue;
      const tIns = g.end - entry;
      const pos = tIns / duration;
      if (pos < 0.3 || pos > 0.92) continue;
      const usable = tIns - (g.start + tailPad);
      if (usable < 0.25) continue;
      const after = sec.lastOf.get(g.after);
      const before = sec.firstOf.get(g.before);
      const gapLen = g.end - g.start;
      let label;
      let sStruct;
      let meaningful = true;
      if (after) {
        label = 'after chorus ' + after.n;
        sStruct = after.n === 2 ? 1 : after.n === 1 ? 0.5 : after.n < total ? 0.7 : 0.3;
      } else if (before) {
        label = before.n === total && total >= 3 ? 'before the last chorus' : 'before chorus ' + before.n;
        sStruct = before.n === total && total >= 3 ? 0.85 : before.n >= 2 ? 0.55 : 0.35;
      } else if (gapLen >= 1.5) {
        label = 'at the ' + fmtTime(tIns) + ' break';
        sStruct = 0.5;
      } else {
        label = 'between lines at ' + fmtTime(tIns);
        sStruct = 0.1;
        meaningful = false;
      }
      const sPos = Math.exp(-Math.pow(pos - 0.66, 2) / (2 * 0.13 * 0.13));
      const fitBars = barLen ? Math.floor(usable / barLen + 1e-6) : 0;
      const sGap = barLen ? (fitBars >= 1 ? Math.min(1, fitBars / Math.min(soloBars || 4, 4)) : 0.1) : Math.min(1, usable / 6);
      const score = 0.42 * sPos + 0.33 * sStruct + 0.25 * sGap;
      all.push({ tIns, gapStart: g.start, gapEnd: g.end, label, score, pos, fitBars, meaningful });
    }
    let cands = all.filter((c) => c.meaningful);
    if (cands.length < 2) {
      // few clear section breaks: offer the roomiest in-between spots too
      const extra = all.filter((c) => !c.meaningful).sort((a, b) => b.gapEnd - b.gapStart - (a.gapEnd - a.gapStart)).slice(0, 4 - cands.length);
      cands = cands.concat(extra);
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
    const ratio = Math.max(1, Math.round(opts.ratio || 1)); // database beats per counted beat
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
          const k = j + nBeats * ratio;
          if (k >= 0 && k < beats.length && Math.abs(beats[j] - (t - off)) < (period / ratio) * 0.75) {
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
    // drop spurious extra beats, then give each beat an integer index (tolerates dropped beats)
    const kept = [beats[0]];
    for (let i = 1; i < beats.length; i++) if (beats[i] - kept[kept.length - 1] >= 0.6 * med) kept.push(beats[i]);
    const idx = [0];
    for (let i = 1; i < kept.length; i++) idx.push(idx[i - 1] + Math.max(1, Math.round((kept[i] - kept[i - 1]) / med)));
    let use = kept.map((t, i) => [idx[i], t]);
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

  // Shaath profiles (worked best in testing on 30 real song previews)
  const PROF_MAJOR = [6.6, 2.0, 3.5, 2.3, 4.6, 4.0, 2.5, 5.2, 2.4, 3.7, 2.3, 3.4];
  const PROF_MINOR = [6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 5.2, 4.0, 2.7, 4.3, 3.2];

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

  function hann(N) {
    const w = new Float32Array(N);
    for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    return w;
  }

  // Estimate how far the recording sits from A440, in cents (-50..50)
  function estimateTuning(x, r) {
    const N = 4096;
    const win = hann(N);
    const re = new Float64Array(N), im = new Float64Array(N);
    let sx = 0, sy = 0;
    for (let s = 0; s + N <= x.length; s += N) {
      for (let i = 0; i < N; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
      fft(re, im);
      const mag = new Float64Array(N / 2);
      for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
      for (let k = 8; k < N / 2 - 1; k++) {
        const fq = (k * r) / N;
        if (fq < 100 || fq > 2000) continue;
        if (!(mag[k] > mag[k - 1] && mag[k] >= mag[k + 1])) continue;
        const a = Math.log(mag[k - 1] + 1e-9), b = Math.log(mag[k] + 1e-9), c = Math.log(mag[k + 1] + 1e-9);
        const d = (0.5 * (a - c)) / (a - 2 * b + c || 1);
        const pf = ((k + d) * r) / N;
        const midi = 69 + 12 * Math.log2(pf / 440);
        const dev = midi - Math.round(midi);
        const w = mag[k] * mag[k];
        sx += w * Math.cos(2 * Math.PI * dev);
        sy += w * Math.sin(2 * Math.PI * dev);
      }
    }
    return (Math.atan2(sy, sx) / (2 * Math.PI)) * 100;
  }

  // Harmonic pitch-class profile: spectral peaks credited to the notes they could be harmonics of
  function keyFeatures(samples, sr) {
    const { x, sr: r } = downsampleTo(samples, sr, 11025);
    const tuning = estimateTuning(x, r);
    const ref = 440 * Math.pow(2, tuning / 1200);
    const N = 4096;
    const hop = 2048;
    const win = hann(N);
    const re = new Float64Array(N), im = new Float64Array(N);
    const chroma = new Float64Array(12), bass = new Float64Array(12);
    const LO = 60, HI = 3000, HARM = 4, HW = 0.6, BASS_HI = 200;
    for (let s = 0; s + N <= x.length; s += hop) {
      let energy = 0;
      for (let i = 0; i < N; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; energy += re[i] * re[i]; }
      if (energy < 1e-7) continue;
      fft(re, im);
      const mag = new Float64Array(N / 2);
      for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
      const fr = new Float64Array(12), fb = new Float64Array(12);
      for (let k = 2; k < N / 2 - 1; k++) {
        const fq = (k * r) / N;
        if (fq < LO || fq > HI) continue;
        if (!(mag[k] > mag[k - 1] && mag[k] >= mag[k + 1])) continue;
        const a = mag[k - 1], b = mag[k], c = mag[k + 1];
        const d = (0.5 * (a - c)) / (a - 2 * b + c || 1);
        const pf = ((k + d) * r) / N;
        const m = b * b;
        for (let h = 1; h <= HARM; h++) {
          const f0 = pf / h;
          if (f0 < LO * 0.5) break;
          const midi = 69 + 12 * Math.log2(f0 / ref);
          const near = Math.round(midi);
          const dev = Math.abs(midi - near);
          const w = Math.pow(Math.cos(Math.PI * dev), 2) * Math.pow(HW, h - 1);
          const pc = ((near % 12) + 12) % 12;
          fr[pc] += m * w;
          if (f0 < BASS_HI) fb[pc] += m * w;
        }
      }
      let mx = 0, mb = 0;
      for (let i = 0; i < 12; i++) { mx = Math.max(mx, fr[i]); mb = Math.max(mb, fb[i]); }
      if (mx > 0) for (let i = 0; i < 12; i++) chroma[i] += fr[i] / mx;
      if (mb > 0) for (let i = 0; i < 12; i++) bass[i] += fb[i] / mb;
    }
    return { chroma: Array.from(chroma), bass: Array.from(bass), tuning };
  }

  // Rank all 24 keys from one or more feature sets (e.g. two different 30-second previews)
  function rankKeys(featureList) {
    const ch = new Array(12).fill(0);
    const bs = new Array(12).fill(0);
    let used = 0;
    for (const f of featureList || []) {
      if (!f) continue;
      const sa = f.chroma.reduce((x, y) => x + y, 0);
      const sb = f.bass.reduce((x, y) => x + y, 0);
      if (!sa) continue;
      used++;
      for (let i = 0; i < 12; i++) {
        ch[i] += f.chroma[i] / sa;
        if (sb) bs[i] += f.bass[i] / sb;
      }
    }
    if (!used) return [];
    const s1 = ch.reduce((x, y) => x + y, 0);
    const s2 = bs.reduce((x, y) => x + y, 0) || 1;
    const c2 = ch.map((v, i) => v + (0.5 * bs[i] * s1) / s2);
    const out = [];
    for (let pc = 0; pc < 12; pc++) {
      for (const scale of ['major', 'minor']) {
        const p = scale === 'major' ? PROF_MAJOR : PROF_MINOR;
        const rot = p.map((_, i) => p[(i - pc + 12) % 12]);
        out.push({ pc, scale, r: corr(c2, rot) });
      }
    }
    out.sort((a, b) => b.r - a.r);
    return out;
  }

  // Backwards-compatible helpers
  function chromaFromPCM(samples, sr) {
    return keyFeatures(samples, sr).chroma;
  }
  function keyFromChroma(chroma) {
    const rk = rankKeys([{ chroma, bass: new Array(12).fill(0) }]);
    const top = rk[0], second = rk[1];
    return { pc: top.pc, scale: top.scale, confidence: Math.max(0, Math.min(1, (top.r - second.r) * 4 + 0.35)), r: top.r };
  }

  const sameKey = (a, b) => a && b && a.pc === b.pc && a.scale === b.scale;

  // Merge the audio-database answer with our own preview analysis
  // returns {main:{pc,scale}, alts:[...], sure:boolean, sources:[...]} or null
  function combineKeys(ranked, ab) {
    const abKey = ab && ab.key ? { pc: ab.key.pc, scale: ab.key.scale } : null;
    let main = null;
    let sure = false;
    if (ranked && ranked.length) {
      main = { pc: ranked[0].pc, scale: ranked[0].scale };
      if (abKey) {
        const idx = ranked.slice(0, 2).findIndex((k) => sameKey(k, abKey));
        if (idx >= 0) main = abKey;
        sure = sameKey(main, abKey) && (ab.key.confidence || 0) >= 0.5;
      }
    } else if (abKey) {
      main = abKey;
      sure = (ab.key.confidence || 0) >= 0.75;
    }
    if (!main) return null;
    const rel = relativeKey(main.pc, main.scale);
    const alts = [];
    const push = (k) => {
      if (!k || sameKey(k, main) || sameKey(k, rel) || alts.some((a) => sameKey(a, k))) return;
      alts.push({ pc: k.pc, scale: k.scale });
    };
    if (abKey) push(abKey);
    for (const k of ranked || []) {
      if (alts.length >= 2) break;
      push(k);
    }
    return { main, alts: alts.slice(0, 2), sure };
  }

  // Pick a tempo from several estimates. sources: [{bpm, w, name, rank}] (lower rank = more precise)
  function foldTempo(b) {
    if (!(b > 0)) return b;
    while (b >= 152) b /= 2;
    while (b < 72) b *= 2;
    return b;
  }
  function chooseTempo(sources) {
    const s = (sources || []).filter((x) => x && x.bpm > 30 && x.bpm < 300).map((x) => Object.assign({}, x, { f: foldTempo(x.bpm) }));
    if (!s.length) return null;
    let best = null;
    for (const c of s) {
      let sup = 0;
      for (const o of s) if (Math.abs(o.f / c.f - 1) < 0.025) sup += o.w || 1;
      if (!best || sup > best.sup + 1e-9 || (Math.abs(sup - best.sup) < 1e-9 && c.rank < best.c.rank)) best = { c, sup };
    }
    const cluster = s.filter((o) => Math.abs(o.f / best.c.f - 1) < 0.025).sort((a, b) => a.rank - b.rank);
    const pick = cluster[0];
    return { bpm: pick.f, raw: pick.bpm, source: pick.name, agree: cluster.length, total: s.length };
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
    const o = onsetEnvelope(samples, sr);
    // light smoothing so peaks have a shape we can interpolate
    let env = o.env;
    for (let pass = 0; pass < 2; pass++) {
      const sm = new Float64Array(env.length);
      for (let i = 0; i < env.length; i++) sm[i] = 0.25 * (env[i - 1] || 0) + 0.5 * env[i] + 0.25 * (env[i + 1] || 0);
      env = sm;
    }
    const rate = o.rate;
    const n = env.length;
    const ac = (lag) => {
      if (lag < 1 || lag >= n - 8) return 0;
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += env[i] * env[i + lag];
      return s / (n - lag);
    };
    const peakNear = (center, half) => {
      let bi = Math.round(center), bv = -Infinity;
      for (let l = Math.round(center) - half; l <= Math.round(center) + half; l++) {
        const v = ac(l);
        if (v > bv) { bv = v; bi = l; }
      }
      const a = ac(bi - 1), b = ac(bi), c = ac(bi + 1);
      const den = a - 2 * b + c;
      const d = den ? (0.5 * (a - c)) / den : 0;
      return bi + Math.max(-0.5, Math.min(0.5, d));
    };
    const minLag = Math.floor((rate * 60) / 200);
    const maxLag = Math.ceil((rate * 60) / 60);
    let best = null;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const bpm = (60 * rate) / lag;
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.6, 2));
      const v = (ac(lag) + 0.5 * ac(lag * 2) + 0.25 * ac(lag * 4)) * prior;
      if (!best || v > best.v) best = { lag, v };
    }
    if (!best) return null;
    // refine step by step on longer and longer multiples of the beat
    let lagEst = peakNear(best.lag, 1);
    for (let mult = 2; lagEst * mult < n / 3 && mult <= 32; mult *= 2) {
      lagEst = peakNear(lagEst * mult, 2) / mult;
    }
    return { bpm: (60 * rate) / lagEst };
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
      // small backward corrections are normal right after a jump; only real seeks change state
      if (this.state === 'region' && pos >= P.rs - 0.6 && pos < P.re + 0.35) return;
      if (this.state === 'done' && pos >= P.tIns - 1.0 && !(P.exit && pos >= P.rs - 0.6 && pos < P.re)) return;
      this.state = pos < P.tIns - this.lead - 0.05 ? 'armed' : 'done';
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
      if (dp < -0.5 || dp > dt + 0.6) {
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
    pickLyrics, fft, chromaFromPCM, keyFromChroma, keyFeatures, rankKeys, combineKeys, estimateTuning, foldTempo, chooseTempo,
    tempoFromPCM, onsetEnvelope, SoloEngine,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SoloCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
