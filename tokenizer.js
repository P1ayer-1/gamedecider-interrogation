// Minimal port of the Hugging Face `tokenizers` pipeline used by answerdotai/ModernBERT-base (tokenizer.json):
// added tokens (non-normalized split first, then normalized, leftmost-longest, lstrip/rstrip) -> NFC -> ByteLevel
// pre-tokenizer (GPT-2 regex, no prefix space) -> byte-level BPE (no dropout, no unk). Encodes with
// add_special_tokens=false, which is how dm/model/layout.py calls the tokenizer. Checked id-for-id against the Python
// tokenizer by tests/run_tests.mjs (tests/tok_ref.json).

// Unicode White_Space (what Rust char::is_whitespace and Oniguruma's \s use; JS \s differs on U+0085 and U+FEFF).
const WS = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WS_RE = new RegExp(`^[${WS}]$`, "u");
const PRE_RE = new RegExp(
  `'s|'t|'re|'ve|'m|'ll|'d| ?\\p{L}+| ?\\p{N}+| ?[^${WS}\\p{L}\\p{N}]+|[${WS}]+(?![^${WS}])|[${WS}]+`, "gu");

function bytesToUnicode() {
  const bs = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
  const m = new Array(256);
  bs.forEach((b, i) => { m[b] = String.fromCharCode(cs[i]); });
  return m;
}

export class Tokenizer {
  constructor(json) {
    if (json.model.type !== "BPE") throw new Error("only BPE tokenizers are supported");
    if (json.normalizer && json.normalizer.type !== "NFC") throw new Error("unsupported normalizer");
    if (json.pre_tokenizer?.type !== "ByteLevel" || json.pre_tokenizer.add_prefix_space) throw new Error("unsupported pre_tokenizer");
    this.vocab = new Map(Object.entries(json.model.vocab));
    this.ranks = new Map();
    json.model.merges.forEach((m, i) => this.ranks.set(Array.isArray(m) ? m.join(" ") : m, i));
    this.added = json.added_tokens.map(t => ({ ...t, content: t.content }));
    for (const t of this.added) this.vocab.set(t.content, t.id);
    this.rawAdded = this.added.filter(t => !t.normalized);
    this.normAdded = this.added.filter(t => t.normalized);
    this.byteMap = bytesToUnicode();
    this.enc = new TextEncoder();
    this.cache = new Map();
    this.byId = new Map();
    for (const [k, v] of this.vocab) this.byId.set(v, k);
  }

  // Split text on added tokens. -> [{text, id|null}]
  static splitAdded(text, toks) {
    if (!toks.length || !text) return [{ text, id: null }];
    const byFirst = new Map();
    for (const t of toks) {
      const c = t.content[0];
      if (!byFirst.has(c)) byFirst.set(c, []);
      byFirst.get(c).push(t);
    }
    const matches = [];
    let i = 0;
    while (i < text.length) {
      let best = null;
      for (const t of byFirst.get(text[i]) || []) {
        if (text.startsWith(t.content, i) && (!best || t.content.length > best.content.length)) best = t;
      }
      if (best) { matches.push({ start: i, end: i + best.content.length, tok: best }); i += best.content.length; }
      else i++;
    }
    const out = [];
    let pos = 0;
    for (const m of matches) {
      let { start, end } = m;
      if (m.tok.lstrip) while (start > pos && WS_RE.test(text[start - 1])) start--;
      if (m.tok.rstrip) while (end < text.length && WS_RE.test(text[end])) end++;
      if (start > pos) out.push({ text: text.slice(pos, start), id: null });
      out.push({ text: text.slice(start, end), id: m.tok.id });
      pos = end;
    }
    if (pos < text.length) out.push({ text: text.slice(pos), id: null });
    return out;
  }

  bpe(piece) {
    let hit = this.cache.get(piece);
    if (hit) return hit;
    let word = Array.from(piece);
    while (word.length > 1) {
      let bestRank = Infinity, bestI = -1;
      for (let i = 0; i < word.length - 1; i++) {
        const r = this.ranks.get(word[i] + " " + word[i + 1]);
        if (r !== undefined && r < bestRank) { bestRank = r; bestI = i; }
      }
      if (bestI < 0) break;
      const a = word[bestI], b = word[bestI + 1];
      const nw = [];
      for (let i = 0; i < word.length;) {
        if (i < word.length - 1 && word[i] === a && word[i + 1] === b) { nw.push(a + b); i += 2; }
        else { nw.push(word[i]); i++; }
      }
      word = nw;
    }
    hit = [];
    for (const w of word) { const id = this.vocab.get(w); if (id !== undefined) hit.push(id); }
    if (this.cache.size < 50000) this.cache.set(piece, hit);
    return hit;
  }

  encodePlain(text, out) {
    for (const m of text.matchAll(PRE_RE)) {
      let s = "";
      for (const b of this.enc.encode(m[0])) s += this.byteMap[b];
      for (const id of this.bpe(s)) out.push(id);
    }
  }

  // ids for one text, no special tokens added
  encode(text) {
    const out = [];
    for (const p of Tokenizer.splitAdded(text, this.rawAdded)) {
      if (p.id !== null) { out.push(p.id); continue; }
      const norm = p.text.normalize("NFC");
      for (const q of Tokenizer.splitAdded(norm, this.normAdded)) {
        if (q.id !== null) out.push(q.id);
        else this.encodePlain(q.text, out);
      }
    }
    return out;
  }
}
