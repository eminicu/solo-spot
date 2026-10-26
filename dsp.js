/* Solo Spot audio processing: FFT/STFT, vocal removal (quick + AI pre/post), beats, downbeats, alignment.
   Works in browsers, Web Workers and Node. */
(function (root) {
  'use strict';

  // ---------- FFT (sizes 2^k and 3*2^k) ----------
  const fftCache = new Map();

  function radix2(N) {
    const rev = new Uint32Array(N);
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      rev[i] = j;
    }
    const cosT = new Float64Array(N / 2);
    const sinT = new Float64Array(N / 2);
    for (let i = 0; i < N / 2; i++) {
      cosT[i] = Math.cos((2 * Math.PI * i) / N);
      sinT[i] = -Math.sin((2 * Math.PI * i) / N);
    }
    return {
      N,
      forward(re, im) {
        for (let i = 1; i < N; i++) {
          const j = rev[i];
          if (i < j) {
            let t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
          }
        }
        for (let size = 2; size <= N; size <<= 1) {
          const half = size >> 1;
          const step = N / size;
          for (let i = 0; i < N; i += size) {
            for (let j = 0, k = 0; j < half; j++, k += step) {
              const a = i + j;
              const b = a + half;
              const wr = cosT[k], wi = sinT[k];
              const xr = re[b] * wr - im[b] * wi;
              const xi = re[b] * wi + im[b] * wr;
              re[b] = re[a] - xr; im[b] = im[a] - xi;
              re[a] += xr; im[a] += xi;
            }
          }
        }
      },
    };
  }

  function radix3x2(N) {
    const M = N / 3;
    const sub = radix2(M);
    const ar = [new Float64Array(M), new Float64Array(M), new Float64Array(M)];
    const ai = [new Float64Array(M), new Float64Array(M), new Float64Array(M)];
    const cosT = new Float64Array(N);
    const sinT = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      cosT[k] = Math.cos((2 * Math.PI * k) / N);
      sinT[k] = -Math.sin((2 * Math.PI * k) / N);
    }
    return {
      N,
      forward(re, im) {
        for (let r = 0; r < 3; r++) {
          const R = ar[r], I = ai[r];
          for (let m = 0; m < M; m++) { R[m] = re[3 * m + r]; I[m] = im[3 * m + r]; }
          sub.forward(R, I);
        }
        for (let k = 0; k < N; k++) {
          const km = k % M;
          const k2 = (2 * k) % N;
          const w1r = cosT[k], w1i = sinT[k], w2r = cosT[k2], w2i = sinT[k2];
          const b1r = ar[1][km], b1i = ai[1][km], b2r = ar[2][km], b2i = ai[2][km];
          re[k] = ar[0][km] + (b1r * w1r - b1i * w1i) + (b2r * w2r - b2i * w2i);
          im[k] = ai[0][km] + (b1r * w1i + b1i * w1r) + (b2r * w2i + b2i * w2r);
        }
      },
    };
  }

  function getFFT(N) {
    let f = fftCache.get(N);
    if (!f) {
      if ((N & (N - 1)) === 0) f = radix2(N);
      else if (N % 3 === 0 && ((N / 3) & (N / 3 - 1)) === 0) f = radix3x2(N);
      else throw new Error('FFT size not supported: ' + N);
      fftCache.set(N, f);
    }
    return f;
  }

  function periodicHann(N) {
    const w = new Float64Array(N);
    for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    return w;
  }

  // ---------- STFT matching torch.stft(center=True, reflect pad, periodic Hann) ----------
  // Returns {re, im} Float32Array laid out [f * T + t] for f < dimF.
  function stft(x, nfft, hop, T, dimF) {
    const L = x.length;
    const pad = nfft / 2;
    const win = periodicHann(nfft);
    const fft = getFFT(nfft);
    const re = new Float64Array(nfft);
    const im = new Float64Array(nfft);
    const outRe = new Float32Array(dimF * T);
    const outIm = new Float32Array(dimF * T);
    const refl = (j) => {
      if (L === 1) return 0;
      const p = 2 * (L - 1);
      j = ((j % p) + p) % p;
      return j < L ? j : p - j;
    };
    for (let t = 0; t < T; t++) {
      const start = t * hop - pad;
      for (let n = 0; n < nfft; n++) {
        const j = start + n;
        re[n] = (j >= 0 && j < L ? x[j] : x[refl(j)]) * win[n];
        im[n] = 0;
      }
      fft.forward(re, im);
      for (let f = 0; f < dimF; f++) {
        outRe[f * T + t] = re[f];
        outIm[f * T + t] = im[f];
      }
    }
    return { re: outRe, im: outIm };
  }

  // Inverse of the above (missing bins above dimF are zero). Output length = hop * (T - 1).
  function istft(specRe, specIm, nfft, hop, T, dimF, outLen) {
    const pad = nfft / 2;
    const win = periodicHann(nfft);
    const fft = getFFT(nfft);
    const total = (T - 1) * hop + nfft;
    const y = new Float64Array(total);
    const ws = new Float64Array(total);
    const re = new Float64Array(nfft);
    const im = new Float64Array(nfft);
    const half = nfft / 2;
    for (let t = 0; t < T; t++) {
      re.fill(0);
      im.fill(0);
      for (let f = 0; f < Math.min(dimF, half + 1); f++) {
        re[f] = specRe[f * T + t];
        im[f] = specIm[f * T + t];
      }
      for (let f = 1; f < half; f++) {
        re[nfft - f] = re[f];
        im[nfft - f] = -im[f];
      }
      // inverse via conjugate trick
      for (let i = 0; i < nfft; i++) im[i] = -im[i];
      fft.forward(re, im);
      const off = t * hop;
      for (let n = 0; n < nfft; n++) {
        const v = (re[n] / nfft) * win[n];
        y[off + n] += v;
        ws[off + n] += win[n] * win[n];
      }
    }
    const L = outLen == null ? (T - 1) * hop : outLen;
    const out = new Float32Array(L);
    for (let i = 0; i < L; i++) {
      const w = ws[i + pad];
      out[i] = w > 1e-11 ? y[i + pad] / w : 0;
    }
    return out;
  }

  // ---------- AI separation (UVR MDX-Net) ----------
  const MDX = {
    small: { file: 'models/mdx-vocals-9703.onnx', nfft: 6144, hop: 1024, dimF: 2048, dimT: 256, compensate: 1.03, primary: 'vocals', bytes: 29704436 },
  };

  function mdxSizes(cfg) {
    const trim = cfg.nfft / 2;
    const chunk = cfg.hop * (cfg.dimT - 1);
    const gen = chunk - 2 * trim;
    return { trim, chunk, gen };
  }

  // Split a stereo segment into model-sized chunks: returns {chunks: [[L,R],...], pad, n}
  function mdxChunks(L, R, cfg) {
    const { trim, chunk, gen } = mdxSizes(cfg);
    const n = L.length;
    const pad = gen - (n % gen);
    const total = trim + n + pad + trim;
    const mixL = new Float32Array(total);
    const mixR = new Float32Array(total);
    mixL.set(L, trim);
    mixR.set(R, trim);
    const chunks = [];
    for (let i = 0; i < n + pad; i += gen) chunks.push([mixL.subarray(i, i + chunk), mixR.subarray(i, i + chunk)]);
    return { chunks, pad, n };
  }

  // Build the model input tensor data [1, 4, dimF, dimT]
  function mdxInput(chL, chR, cfg) {
    const F = cfg.dimF, T = cfg.dimT;
    const a = stft(chL, cfg.nfft, cfg.hop, T, F);
    const b = stft(chR, cfg.nfft, cfg.hop, T, F);
    const data = new Float32Array(4 * F * T);
    data.set(a.re, 0);
    data.set(a.im, F * T);
    data.set(b.re, 2 * F * T);
    data.set(b.im, 3 * F * T);
    for (let c = 0; c < 4; c++) for (let f = 0; f < 3; f++) data.fill(0, c * F * T + f * T, c * F * T + (f + 1) * T);
    return data;
  }

  // Model output -> stereo waveform for the chunk, trimmed to the 'gen' middle part
  function mdxOutput(out, cfg) {
    const F = cfg.dimF, T = cfg.dimT;
    const { trim, chunk } = mdxSizes(cfg);
    const L = istft(out.subarray(0, F * T), out.subarray(F * T, 2 * F * T), cfg.nfft, cfg.hop, T, F, chunk);
    const R = istft(out.subarray(2 * F * T, 3 * F * T), out.subarray(3 * F * T, 4 * F * T), cfg.nfft, cfg.hop, T, F, chunk);
    return [L.subarray(trim, chunk - trim), R.subarray(trim, chunk - trim)];
  }

  // Combine chunk outputs and turn the vocal stem into an instrumental
  function mdxFinish(L, R, parts, cfg) {
    const n = L.length;
    const vL = new Float32Array(n), vR = new Float32Array(n);
    let pos = 0;
    for (const [a, b] of parts) {
      const m = Math.min(a.length, n - pos);
      if (m <= 0) break;
      vL.set(a.subarray(0, m), pos);
      vR.set(b.subarray(0, m), pos);
      pos += m;
    }
    const iL = new Float32Array(n), iR = new Float32Array(n);
    if (cfg.primary === 'vocals') {
      for (let i = 0; i < n; i++) {
        iL[i] = L[i] - vL[i] * cfg.compensate;
        iR[i] = R[i] - vR[i] * cfg.compensate;
      }
      return { instL: iL, instR: iR, vocL: vL, vocR: vR };
    }
    for (let i = 0; i < n; i++) {
      iL[i] = vL[i];
      iR[i] = vR[i];
      vL[i] = L[i] - iL[i];
      vR[i] = R[i] - iR[i];
    }
    return { instL: iL, instR: iR, vocL: vL, vocR: vR };
  }

  // ---------- Quick vocal removal: subtract what sits dead-center in the vocal range ----------
  function centerRemove(L, R, sr, opts) {
    opts = opts || {};
    const nfft = 4096, hop = 1024;
    const lo = opts.lo || 140, hi = opts.hi || 9000, power = opts.power || 6;
    const n = L.length;
    const T = Math.floor(n / hop) + 1;
    const half = nfft / 2;
    const F = half + 1;
    const a = stft(L, nfft, hop, T, F);
    const b = stft(R, nfft, hop, T, F);
    const cRe = new Float32Array(F * T), cIm = new Float32Array(F * T);
    const k0 = Math.floor((lo * nfft) / sr), k1 = Math.ceil((hi * nfft) / sr);
    for (let f = k0; f <= Math.min(k1, half); f++) {
      for (let t = 0; t < T; t++) {
        const i = f * T + t;
        const lr = a.re[i], li = a.im[i], rr = b.re[i], ri = b.im[i];
        const pl = lr * lr + li * li, pr = rr * rr + ri * ri;
        if (pl + pr < 1e-12) continue;
        const crossRe = lr * rr + li * ri, crossIm = li * rr - lr * ri;
        const sim = (2 * Math.sqrt(crossRe * crossRe + crossIm * crossIm)) / (pl + pr);
        const s2 = sim * sim;
        const m = power === 6 ? s2 * s2 * s2 : Math.pow(sim, power);
        cRe[i] = 0.5 * (lr + rr) * m;
        cIm[i] = 0.5 * (li + ri) * m;
      }
    }
    const subRe = (s) => { const o = new Float32Array(F * T); for (let i = 0; i < o.length; i++) o[i] = s.re[i] - cRe[i]; return o; };
    const subIm = (s) => { const o = new Float32Array(F * T); for (let i = 0; i < o.length; i++) o[i] = s.im[i] - cIm[i]; return o; };
    const outL = istft(subRe(a), subIm(a), nfft, hop, T, F, n);
    const outR = istft(subRe(b), subIm(b), nfft, hop, T, F, n);
    // center energy in the vocal band, per frame: a rough "is someone singing" curve
    const act = new Float32Array(T);
    const v0 = Math.floor((300 * nfft) / sr), v1 = Math.ceil((3500 * nfft) / sr);
    for (let t = 0; t < T; t++) {
      let s = 0;
      for (let f = v0; f <= v1; f++) { const i = f * T + t; s += cRe[i] * cRe[i] + cIm[i] * cIm[i]; }
      act[t] = Math.log(1 + s);
    }
    return { L: outL, R: outR, activity: act, activityRate: sr / hop };
  }

  // Fast "is someone singing" curve for the whole preview: dead-center energy in the vocal band (~43 frames/s)
  function vocalActivity(L, R, sr) {
    const a = resample(L, sr, 11025), b = resample(R, sr, 11025);
    const r = a.sr;
    const N = 1024, hop = 256;
    const win = periodicHann(N);
    const fft = getFFT(N);
    const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
    const k0 = Math.floor((300 * N) / r), k1 = Math.ceil((3500 * N) / r);
    const out = [];
    for (let s = 0; s + N <= a.x.length; s += hop) {
      for (let i = 0; i < N; i++) { ar[i] = a.x[s + i] * win[i]; ai[i] = 0; br[i] = b.x[s + i] * win[i]; bi[i] = 0; }
      fft.forward(ar, ai);
      fft.forward(br, bi);
      let e = 0;
      for (let k = k0; k <= k1; k++) {
        const pl = ar[k] * ar[k] + ai[k] * ai[k], pr = br[k] * br[k] + bi[k] * bi[k];
        const tot = pl + pr;
        if (tot < 1e-12) continue;
        const cr = ar[k] * br[k] + ai[k] * bi[k], ci = ai[k] * br[k] - ar[k] * bi[k];
        const sim = (2 * Math.sqrt(cr * cr + ci * ci)) / tot;
        const s2 = sim * sim;
        e += tot * s2 * s2 * s2;
      }
      out.push(Math.log(1 + 1000 * e));
    }
    return { activity: Float32Array.from(out), rate: r / hop };
  }

  // ---------- onsets, beats, downbeats ----------
  function mono(L, R) {
    const n = L.length;
    const m = new Float32Array(n);
    for (let i = 0; i < n; i++) m[i] = 0.5 * (L[i] + (R ? R[i] : L[i]));
    return m;
  }

  function resample(x, sr, target) {
    const f = Math.max(1, Math.round(sr / target));
    const n = Math.floor(x.length / f);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < f; k++) s += x[i * f + k];
      y[i] = s / f;
    }
    return { x: y, sr: sr / f };
  }

  // spectral-flux onset envelope (~86 frames/s), plus a low-band (kick/bass) version
  function onsets(m, sr) {
    const { x, sr: r } = resample(m, sr, 11025);
    const N = 1024, hop = 128;
    const win = periodicHann(N);
    const fft = getFFT(N);
    const re = new Float64Array(N), im = new Float64Array(N);
    let prev = null;
    const env = [], low = [];
    const kLow = Math.ceil((180 * N) / r);
    for (let s = 0; s + N <= x.length; s += hop) {
      for (let i = 0; i < N; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
      fft.forward(re, im);
      const mag = new Float64Array(N / 2);
      for (let k = 0; k < N / 2; k++) mag[k] = Math.log(1 + 100 * Math.hypot(re[k], im[k]));
      let fl = 0, fll = 0;
      if (prev) for (let k = 1; k < N / 2; k++) { const d = mag[k] - prev[k]; if (d > 0) { fl += d; if (k <= kLow) fll += d; } }
      env.push(fl);
      low.push(fll);
      prev = mag;
    }
    const detrend = (a) => {
      const out = new Float64Array(a.length);
      const w = 20;
      let mean = 0;
      for (let i = 0; i < a.length; i++) mean += a[i];
      for (let i = 0; i < a.length; i++) {
        let s = 0, c = 0;
        for (let j = Math.max(0, i - w); j <= Math.min(a.length - 1, i + w); j++) { s += a[j]; c++; }
        out[i] = Math.max(0, a[i] - s / c);
      }
      let sd = 0;
      for (let i = 0; i < out.length; i++) sd += out[i] * out[i];
      sd = Math.sqrt(sd / Math.max(1, out.length)) || 1;
      for (let i = 0; i < out.length; i++) out[i] /= sd;
      return out;
    };
    // frames are stamped at their start; onsets register ~72 ms later than that (measured on synthetic drums)
    return { env: detrend(env), low: detrend(low), rate: r / hop, hopSec: hop / r, winSec: N / r, latency: 0.072 };
  }

  // Dynamic-programming beat tracker (Ellis 2007) given a tempo; returns a straight beat grid
  function trackBeats(env, rate, bpm, latency) {
    latency = latency || 0;
    const P = (60 / bpm) * rate;
    const n = env.length;
    const score = new Float64Array(n);
    const back = new Int32Array(n).fill(-1);
    const alpha = 120;
    for (let t = 0; t < n; t++) {
      let best = -Infinity, arg = -1;
      const lo = Math.max(0, Math.round(t - 2 * P)), hi = Math.round(t - P / 2);
      for (let s = lo; s <= hi; s++) {
        const v = score[s] - alpha * Math.pow(Math.log((t - s) / P), 2);
        if (v > best) { best = v; arg = s; }
      }
      score[t] = env[t] + (arg >= 0 ? Math.max(0, best) : 0);
      back[t] = arg;
    }
    let end = n - 1, bv = -Infinity;
    for (let t = Math.max(0, Math.floor(n - P)); t < n; t++) if (score[t] > bv) { bv = score[t]; end = t; }
    const beats = [];
    for (let t = end; t >= 0; t = back[t]) {
      beats.push(t);
      if (back[t] < 0) break;
    }
    beats.reverse();
    // straight-line fit: index vs time, dropping outliers
    let pts = beats.map((t, i) => [i, t]);
    let a = 0, p = P;
    for (let it = 0; it < 3; it++) {
      const m = pts.length;
      if (m < 4) break;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
      p = (m * sxy - sx * sy) / (m * sxx - sx * sx);
      a = (sy - p * sx) / m;
      const keep = pts.filter(([x, y]) => Math.abs(y - (a + p * x)) < P * 0.15);
      if (keep.length < 4) break;
      pts = keep;
    }
    // refine phase on the onset curve: shift the grid to where onsets line up best
    let bestOff = 0, bestS = -Infinity;
    for (let off = -3; off <= 3; off += 0.25) {
      let s = 0;
      for (let k = 0; ; k++) {
        const pos = a + off + p * k;
        if (pos >= n - 1) break;
        if (pos < 0) continue;
        const i = Math.floor(pos), fr = pos - i;
        s += env[i] * (1 - fr) + env[i + 1] * fr;
      }
      if (s > bestS) { bestS = s; bestOff = off; }
    }
    a += bestOff;
    const periodSec = p / rate;
    const grid = [];
    let k0 = Math.ceil(-a / p);
    for (let k = k0; a + p * k < n; k++) grid.push((a + p * k) / rate + latency);
    return { beats: grid, period: periodSec, bpm: 60 / periodSec, raw: beats.map((t) => t / rate + latency) };
  }

  // Which beat in each group of 4 is the "1"? Chords change and the kick lands on downbeats.
  function findDownbeat(m, sr, beats, ons) {
    const { x, sr: r } = resample(m, sr, 11025);
    const N = 4096;
    const win = periodicHann(N);
    const fft = getFFT(N);
    const re = new Float64Array(N), im = new Float64Array(N);
    const chromaAt = (t0, t1) => {
      const c = new Float64Array(12);
      for (let t = t0; t + N / r <= t1 + 1e-9; t += 0.06) {
        const s = Math.floor(t * r);
        if (s < 0 || s + N > x.length) continue;
        for (let i = 0; i < N; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
        fft.forward(re, im);
        for (let k = 3; k < N / 2; k++) {
          const f = (k * r) / N;
          if (f < 60 || f > 2000) continue;
          const midi = 69 + 12 * Math.log2(f / 440);
          const pc = ((Math.round(midi) % 12) + 12) % 12;
          c[pc] += Math.hypot(re[k], im[k]);
        }
      }
      let nrm = 0;
      for (let i = 0; i < 12; i++) nrm += c[i] * c[i];
      nrm = Math.sqrt(nrm) || 1;
      for (let i = 0; i < 12; i++) c[i] /= nrm;
      return c;
    };
    const ch = [];
    for (let i = 0; i + 1 < beats.length; i++) ch.push(chromaAt(beats[i], beats[i + 1]));
    const nov = [0];
    for (let i = 1; i < ch.length; i++) {
      let d = 0;
      for (let k = 0; k < 12; k++) d += ch[i][k] * ch[i - 1][k];
      nov.push(1 - d);
    }
    const lowAt = (t) => {
      const i = Math.round((t - (ons.latency || 0)) * ons.rate);
      let s = 0;
      for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < ons.low.length) s = Math.max(s, ons.low[j]);
      return s;
    };
    const scores = [0, 0, 0, 0];
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < nov.length; i++) {
      const ph = i % 4;
      scores[ph] += nov[i] * 3 + 0.25 * lowAt(beats[i]);
      counts[ph]++;
    }
    let best = 0;
    for (let ph = 1; ph < 4; ph++) if (scores[ph] / (counts[ph] || 1) > scores[best] / (counts[best] || 1)) best = ph;
    return { phase: best, scores: scores.map((s, i) => s / (counts[i] || 1)) };
  }

  // ---------- line up the preview with the song's lyric timing ----------
  // activity: per-frame vocal activity of the preview; segs: [{start,end}] sung lines in song time
  function alignToLyrics(activity, rate, segs, songDur) {
    const step = 0.1;
    const nP = Math.floor(activity.length / rate / step);
    const a = new Float64Array(nP);
    for (let i = 0; i < nP; i++) {
      const j0 = Math.floor(i * step * rate), j1 = Math.max(j0 + 1, Math.floor((i + 1) * step * rate));
      let s = 0;
      for (let j = j0; j < j1 && j < activity.length; j++) s += activity[j];
      a[i] = s / (j1 - j0);
    }
    // standardize
    let mu = 0;
    for (let i = 0; i < nP; i++) mu += a[i];
    mu /= nP || 1;
    let sd = 0;
    for (let i = 0; i < nP; i++) sd += (a[i] - mu) * (a[i] - mu);
    sd = Math.sqrt(sd / (nP || 1)) || 1;
    for (let i = 0; i < nP; i++) a[i] = (a[i] - mu) / sd;
    const nS = Math.ceil(songDur / step) + 1;
    const s = new Float64Array(nS);
    for (const g of segs) for (let i = Math.max(0, Math.floor(g.start / step)); i < Math.min(nS, Math.ceil(g.end / step)); i++) s[i] = 1;
    const results = [];
    for (let off = 0; off + nP <= nS; off++) {
      let sm = 0, sm2 = 0, cross = 0;
      for (let i = 0; i < nP; i++) { const v = s[off + i]; sm += v; sm2 += v * v; cross += v * a[i]; }
      const mean = sm / nP;
      const varS = sm2 / nP - mean * mean;
      if (varS < 1e-6) continue;
      results.push({ offset: off * step, r: cross / nP / Math.sqrt(varS) });
    }
    results.sort((p, q) => q.r - p.r);
    return results.slice(0, 5);
  }

  // A 4- or 8-bar loop that starts on the first beat of a phrase
  function chooseLoop(beats, downPhase, bars, opts) {
    opts = opts || {};
    const minStart = opts.minStart == null ? 0.5 : opts.minStart;
    const maxEnd = opts.maxEnd;
    const period = opts.period;
    const downs = [];
    for (let i = downPhase; i < beats.length; i += 4) downs.push(beats[i]);
    const len = bars * 4 * period;
    const ok = downs.filter((d) => d >= minStart && d + len <= maxEnd);
    if (!ok.length) return null;
    let pick = ok[0];
    if (opts.prefer != null) {
      pick = ok.reduce((b, d) => (Math.abs(d - opts.prefer) < Math.abs(b - opts.prefer) ? d : b), ok[0]);
    }
    return { start: pick, end: pick + len, bars, period };
  }

  const api = { vocalActivity, getFFT, periodicHann, stft, istft, MDX, mdxSizes, mdxChunks, mdxInput, mdxOutput, mdxFinish, centerRemove, mono, resample, onsets, trackBeats, findDownbeat, alignToLyrics, chooseLoop };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SoloDSP = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
