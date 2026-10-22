// Port of dm/model/layout.py (layout "C": Encoder.encode / _question_block / _build, collate) and of the scoring in
// scripts/eval_ckpt.py (dm.train.engine.group_logits + dm.eval.calibration softmax/temperature_for).
// Checked array-for-array against the Python reference by tests/run_tests.mjs (tests/ref_rows.json).

export const QTYPE = { noul: 0, choice: 1, score: 2 };
export const STATE_RESERVE = 64;

// ---------------------------------------------------------------- render_state: json.dumps(state, ensure_ascii=False,
// separators=(", ", ": ")). Python float repr is reproduced for non-integral numbers; integral numbers are written as
// ints (JS cannot tell 1 from 1.0, so states must not carry integral floats; game states never do).
function pyFloat(x) {
  if (Number.isNaN(x)) return "NaN";
  if (!Number.isFinite(x)) return x > 0 ? "Infinity" : "-Infinity";
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return String(x);
  const [mant, expS] = x.toExponential().split("e");     // shortest round-trip digits, like Python repr
  const exp = Number(expS);
  const neg = mant.startsWith("-");
  const digits = mant.replace("-", "").replace(".", "");
  let s;
  if (exp < -4 || exp >= 16) {
    s = digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "") + "e" + (exp < 0 ? "-" : "+") +
      String(Math.abs(exp)).padStart(2, "0");
  } else if (exp < 0) {
    s = "0." + "0".repeat(-exp - 1) + digits;
  } else if (digits.length <= exp + 1) {
    s = digits + "0".repeat(exp + 1 - digits.length) + ".0";
  } else {
    s = digits.slice(0, exp + 1) + "." + digits.slice(exp + 1);
  }
  return (neg ? "-" : "") + s;
}

function pyStr(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

export function pyDumps(v) {
  if (v === null || v === undefined) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") return pyFloat(v);
  if (typeof v === "string") return pyStr(v);
  if (Array.isArray(v)) return "[" + v.map(pyDumps).join(", ") + "]";
  return "{" + Object.entries(v).map(([k, x]) => pyStr(k) + ": " + pyDumps(x)).join(", ") + "}";
}

export function renderState(state) {
  return typeof state === "string" ? state : pyDumps(state);
}

export function questionOptions(q) {
  if (q.type === "noul") return [["false", q.criteria_false || "no"], ["true", q.criteria_true || "yes"]];
  return q.options.map(o => [String(o.name), String(o.desc || "")]);
}

const floorDiv = (a, b) => Math.floor(a / b);

export class Encoder {
  constructor(tokenizer, specials, maxLen = 3072) {
    this.tok = tokenizer;
    this.sp = specials;           // {cls, sep, mask, pad}
    this.maxLen = maxLen;
  }

  ids(texts) { return texts.map(t => this.tok.encode(t)); }

  questionBlock(q, cap) {
    const opts = questionOptions(q);
    const parts = this.ids([q.instructions || "", ...opts.map(([n, d]) => (d ? `${n}: ${d}` : `${n}:`))]);
    let instr = parts[0], odesc = parts.slice(1);
    const k = opts.length;
    const fixed = k + 1;
    const total = instr.length + odesc.reduce((a, d) => a + d.length, 0) + fixed;
    if (total > cap) {
      const per = Math.max(1, floorDiv(cap - fixed - Math.min(instr.length, 8), k));
      odesc = odesc.map(d => d.slice(0, per));
      const room = Math.max(0, cap - fixed - odesc.reduce((a, d) => a + d.length, 0));
      instr = instr.slice(0, room);
    }
    const ids = instr.slice();
    const offs = [];
    for (const d of odesc) { offs.push(ids.length); ids.push(this.sp.mask); for (const x of d) ids.push(x); }
    ids.push(this.sp.sep);
    return [ids, offs];
  }

  encode(row) {
    const qs = row.questions;
    const cap = Math.max(this.maxLen - STATE_RESERVE, 8);
    const blocks = qs.map(q => this.questionBlock(q, cap));
    const stateFull = this.tok.encode(renderState(row.state));
    const budget = this.maxLen - STATE_RESERVE;
    const chunks = [];
    let cur = [], used = 0;
    blocks.forEach(([ids], qi) => {
      if (cur.length && used + ids.length > budget) { chunks.push(cur); cur = []; used = 0; }
      cur.push(qi); used += ids.length;
    });
    if (cur.length) chunks.push(cur);
    return chunks.map(ch => this.build(row, stateFull, blocks, qs, ch));
  }

  build(row, stateFull, blocks, qs, chunk) {
    const used = chunk.reduce((a, i) => a + blocks[i][0].length, 0);
    const limit = this.maxLen - used - 2;
    const state = [this.sp.cls, ...stateFull.slice(0, Math.max(0, limit)), this.sp.sep];
    const S = state.length;
    const ids = state.slice(), seg = new Array(S).fill(0), pos = [...Array(S).keys()];
    const mpos = [], mtype = [], mloc = [];
    chunk.forEach((qi, local) => {
      const [bids, offs] = blocks[qi];
      const start = ids.length;
      bids.forEach((x, j) => { ids.push(x); seg.push(local + 1); pos.push(S + j); });
      for (const o of offs) { mpos.push(start + o); mtype.push(QTYPE[qs[qi].type]); mloc.push(local); }
    });
    return {
      id: row.id, source: row.source || "", input_ids: ids, segment_ids: seg, position_ids: pos,
      marker_pos: mpos, marker_qtype: mtype, marker_local_q: mloc, q_orig: chunk.slice(),
      q_nopt: chunk.map(i => questionOptions(qs[i]).length), q_type: chunk.map(i => qs[i].type),
      q_name: chunk.map(i => qs[i].name || ""),
    };
  }
}

// collate: padded int arrays (row-major, flat) + group index. -> {B, L, K, input_ids, ..., group_idx, G, Km, groups}
export function collate(seqs, padId) {
  const B = seqs.length;
  const L = Math.max(...seqs.map(s => s.input_ids.length));
  const K = Math.max(1, ...seqs.map(s => s.marker_pos.length));
  const f = (n, v) => new Array(n).fill(v);
  const out = { B, L, K, input_ids: f(B * L, padId), segment_ids: f(B * L, -1), position_ids: f(B * L, 0),
    marker_pos: f(B * K, 0), marker_qtype: f(B * K, 0), marker_mask: f(B * K, 0) };
  const groups = [], meta = [];
  seqs.forEach((s, b) => {
    s.input_ids.forEach((x, j) => {
      out.input_ids[b * L + j] = x; out.segment_ids[b * L + j] = s.segment_ids[j]; out.position_ids[b * L + j] = s.position_ids[j];
    });
    s.marker_pos.forEach((x, j) => {
      out.marker_pos[b * K + j] = x; out.marker_qtype[b * K + j] = s.marker_qtype[j]; out.marker_mask[b * K + j] = 1;
    });
    const byQ = new Map();
    s.marker_local_q.forEach((lq, j) => { if (!byQ.has(lq)) byQ.set(lq, []); byQ.get(lq).push(b * K + j); });
    s.q_orig.forEach((qi, lq) => {
      groups.push(byQ.get(lq));
      meta.push({ id: s.id, source: s.source, qidx: qi, name: s.q_name[lq], type: s.q_type[lq], nopt: s.q_nopt[lq] });
    });
  });
  const G = groups.length;
  const Km = G ? Math.max(...groups.map(g => g.length)) : 1;
  out.group_idx = f(G * Km, -1);
  groups.forEach((g, i) => g.forEach((x, j) => { out.group_idx[i * Km + j] = x; }));
  out.G = G; out.Km = Km; out.groups = groups; out.group_meta = meta;
  return out;
}

export function bucket(n) { return n <= 2 ? "2" : n <= 5 ? "3-5" : n <= 10 ? "6-10" : "11+"; }

export function temperatureFor(cal, qtype, n) {
  const t = cal?.temperatures?.[`${qtype}|${bucket(n)}`];
  return t !== undefined ? t : (cal?.default ?? 1.0);
}

export function softmax(z, t = 1.0) {
  const s = z.map(x => x / t);
  const m = Math.max(...s);
  const e = s.map(x => Math.exp(x - m));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map(x => x / sum);
}

// logits: flat Float32Array [B*K] -> per question {meta, logits, probs (post-calibration)}
export function scoreGroups(logits, batch, cal) {
  return batch.groups.map((g, i) => {
    const m = batch.group_meta[i];
    const z = g.slice(0, m.nopt).map(j => logits[j]);
    const t = cal ? temperatureFor(cal, m.type, z.length) : 1.0;
    return { ...m, temperature: t, logits: z, probs: softmax(z, t) };
  });
}
