/* Background vocal removal with the UVR MDX-Net model (runs off the main thread). */
/* global ort, SoloDSP */
const ORT_VER = '1.22.0';
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_VER + '/dist/';
importScripts(ORT_BASE + 'ort.webgpu.min.js');
importScripts('dsp.js?v=' + (self.location.search.match(/v=([\w]+)/) || [0, '1'])[1]);

let session = null;
let engine = null;
let loading = null;
const post = (m, t) => self.postMessage(m, t || []);

async function fetchModel(url, bytes) {
  let cache = null;
  try {
    cache = await caches.open('solo-spot-models-v1');
    const hit = await cache.match(url);
    if (hit) {
      post({ type: 'progress', stage: 'download', frac: 1, cached: true });
      return await hit.arrayBuffer();
    }
  } catch (e) {
    cache = null;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error('Model download failed (HTTP ' + r.status + ')');
  const total = +r.headers.get('content-length') || bytes || 0;
  const reader = r.body.getReader();
  const parts = [];
  let got = 0;
  let lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    const now = Date.now();
    if (now - lastPost > 200) {
      lastPost = now;
      post({ type: 'progress', stage: 'download', frac: total ? got / total : 0 });
    }
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  if (cache) {
    try {
      await cache.put(url, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } }));
    } catch (e) {}
  }
  post({ type: 'progress', stage: 'download', frac: 1 });
  return buf.buffer;
}

async function load(cfg, preferGpu) {
  if (session) return;
  if (loading) return loading;
  loading = (async () => {
    ort.env.wasm.wasmPaths = ORT_BASE;
    ort.env.wasm.numThreads = 1;
    const buf = await fetchModel(cfg.file, cfg.bytes);
    post({ type: 'progress', stage: 'prepare' });
    if (preferGpu && self.navigator && self.navigator.gpu) {
      try {
        session = await ort.InferenceSession.create(buf, { executionProviders: ['webgpu'] });
        engine = 'webgpu';
      } catch (e) {
        session = null;
      }
    }
    if (!session) {
      session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
      engine = 'wasm';
    }
  })();
  try {
    await loading;
  } finally {
    loading = null;
  }
}

async function runChunks(L, R, cfg) {
  const { chunks } = SoloDSP.mdxChunks(L, R, cfg);
  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    const [a, b] = chunks[i];
    const data = SoloDSP.mdxInput(a, b, cfg);
    const t0 = Date.now();
    let out;
    try {
      out = await session.run({ input: new ort.Tensor('float32', data, [1, 4, cfg.dimF, cfg.dimT]) });
    } catch (e) {
      if (engine === 'webgpu') {
        // fall back to the CPU engine if the graphics path fails mid-way
        const buf = await fetchModel(cfg.file, cfg.bytes);
        session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
        engine = 'wasm';
        out = await session.run({ input: new ort.Tensor('float32', data, [1, 4, cfg.dimF, cfg.dimT]) });
      } else throw e;
    }
    const outData = out[session.outputNames[0]].data;
    parts.push(SoloDSP.mdxOutput(outData, cfg));
    post({ type: 'progress', stage: 'separate', done: i + 1, total: chunks.length, ms: Date.now() - t0, engine });
  }
  return SoloDSP.mdxFinish(L, R, parts, cfg);
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'separate') {
      const cfg = SoloDSP.MDX[m.model || 'small'];
      await load(cfg, m.gpu !== false);
      const res = await runChunks(m.L, m.R, cfg);
      post({ type: 'done', id: m.id, engine, instL: res.instL, instR: res.instR, vocL: res.vocL, vocR: res.vocR }, [res.instL.buffer, res.instR.buffer, res.vocL.buffer, res.vocR.buffer]);
    }
  } catch (err) {
    post({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
