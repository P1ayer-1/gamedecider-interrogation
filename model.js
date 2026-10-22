// GameDecider in the browser: onnxruntime-web (WebGPU, falling back to WASM), the ported tokenizer and layout-C
// encoder, calibrated per-question probabilities. One session.run per decide() call (all rows in one padded batch).
import { Tokenizer } from "./tokenizer.js";
import { Encoder, collate, questionOptions, scoreGroups } from "./layout.js";

const now = () => (globalThis.performance ? performance.now() : Date.now());

export class Decider {
  constructor(ort, session, meta, tokenizer, backend) {
    this.ort = ort; this.session = session; this.meta = meta; this.backend = backend;
    this.encoder = new Encoder(tokenizer, meta.specials, meta.max_len);
    this.cal = meta.calibration;
  }

  // Exact feed the Python Encoder + collate build. -> {batch, seqs}
  feed(rows) {
    const seqs = rows.flatMap(r => this.encoder.encode(r));
    return { seqs, batch: collate(seqs, this.meta.specials.pad) };
  }

  async logits(batch) {
    const T = this.ort.Tensor;
    const t = (name, n) => new T("int64", BigInt64Array.from(batch[name], BigInt), [batch.B, n]);
    const feeds = {
      input_ids: t("input_ids", batch.L), segment_ids: t("segment_ids", batch.L), position_ids: t("position_ids", batch.L),
      marker_pos: t("marker_pos", batch.K), marker_qtype: t("marker_qtype", batch.K), marker_mask: t("marker_mask", batch.K),
    };
    const out = await this.session.run(feeds);
    return out.logits.data;
  }

  // rows: C-DM1 rows {id, source, state, questions}. -> {results, ms, scored}; results[i][qname] = {label, probs}
  async decide(rows) {
    const t0 = now();
    const { batch } = this.feed(rows);
    const z = await this.logits(batch);
    const scored = scoreGroups(z, batch, this.cal);
    const ms = now() - t0;
    const byId = new Map(rows.map((r, i) => [String(r.id), i]));
    const results = rows.map(() => ({}));
    for (const s of scored) {
      const i = byId.get(String(s.id));
      const q = rows[i].questions[s.qidx];
      const names = questionOptions(q).map(o => o[0]);
      let best = 0;
      s.probs.forEach((p, j) => { if (p > s.probs[best]) best = j; });
      results[i][q.name] = { label: names[best], probs: Object.fromEntries(names.map((n, j) => [n, s.probs[j]])) };
    }
    return { results, ms, scored, L: batch.L, B: batch.B };
  }
}

// Shared by the page and the node tests: build a session on the first backend that works.
export async function createDecider({ ort, modelBytes, meta, tokJson, backends = ["webgpu", "wasm"], log = () => {} }) {
  const tokenizer = new Tokenizer(tokJson);
  let lastErr = null;
  for (const be of backends) {
    try {
      const t0 = now();
      const session = await ort.InferenceSession.create(modelBytes, { executionProviders: [be], graphOptimizationLevel: "all" });
      const d = new Decider(ort, session, meta, tokenizer, be);
      // warm-up / smoke run: a backend that creates a session but cannot run the graph is skipped
      const w = await d.decide([{ id: "warmup", source: "warmup", state: { player_said: "hello" },
        questions: [{ name: "w", type: "noul", instructions: "Is this a greeting?" }] }]);
      if (!w.scored.every(s => s.probs.every(Number.isFinite))) throw new Error(`${be}: non-finite output`);
      d.loadMs = now() - t0;
      log(`backend ${be} ready in ${d.loadMs.toFixed(0)} ms`);
      return d;
    } catch (e) {
      lastErr = e;
      log(`backend ${be} unavailable: ${e?.message || e}`);
    }
  }
  throw new Error(`no ONNX Runtime backend worked: ${lastErr?.message || lastErr}`);
}

// ---------------------------------------------------------------- browser loading (fetch with progress + Cache API)
async function fetchWithProgress(url, onProgress, expectBytes) {
  const cacheName = "gamedecider-model-v2";
  let cache = null;
  try { if (globalThis.caches && globalThis.isSecureContext) cache = await caches.open(cacheName); } catch { cache = null; }
  let res = cache ? await cache.match(url) : null;
  const fromCache = !!res;
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  }
  const total = Number(res.headers.get("content-length")) || expectBytes || 0;
  const reader = res.clone().body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress?.(got, total, fromCache);
  }
  const buf = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  if (cache && !fromCache) { try { await cache.put(url, new Response(buf, { headers: { "content-length": String(got) } })); } catch { /* quota */ } }
  return buf;
}

export async function loadBrowserDecider({ base = new URL("./model/", import.meta.url).href, onProgress, log, backends, modelFile } = {}) {
  const ort = await import("./vendor/onnxruntime-web/ort.webgpu.bundle.min.js");
  // vendored .mjs files were renamed to .js so any static server sends a JavaScript MIME type (python -m http.server on
  // Windows sends text/plain for .mjs, which browsers refuse to import)
  ort.env.wasm.wasmPaths = { mjs: new URL("./vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.js", import.meta.url).href,
    wasm: new URL("./vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm", import.meta.url).href };
  ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(navigator.hardwareConcurrency || 4, 8) : 1;
  const meta = await (await fetch(base + "meta.json")).json();
  const tokJson = await (await fetch(base + "tokenizer.json")).json();
  const v = meta.onnx.sha256.slice(0, 16);
  let modelBytes;
  if (modelFile) {  // test override: one local file
    modelBytes = await fetchWithProgress(`${base}${modelFile}`, onProgress, 0);
  } else {          // the shipped model, in parts (static hosts cap file sizes); combined progress
    const total = meta.onnx.bytes, bufs = [];
    let done = 0;
    for (const pt of meta.onnx.parts) {
      const b = await fetchWithProgress(`${base}${pt.file}?v=${v}`, (got, _t, cached) => onProgress?.(done + got, total, cached), pt.bytes);
      if (b.length !== pt.bytes) throw new Error(`${pt.file}: got ${b.length} bytes, expected ${pt.bytes}`);
      bufs.push(b); done += b.length;
    }
    modelBytes = new Uint8Array(done);
    let off = 0;
    for (const b of bufs) { modelBytes.set(b, off); off += b.length; }
  }
  backends = backends || (globalThis.navigator?.gpu ? ["webgpu"] : []).concat(["wasm"]);
  const d = await createDecider({ ort, modelBytes, meta, tokJson, backends, log });
  d.threads = ort.env.wasm.numThreads;
  return d;
}
