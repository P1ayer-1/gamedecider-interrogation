// "The Interrogation" in pure JS: a line-for-line port of local/prototype/interrogation/game.py (DM5.0/DM5.2).
// Suspect, secret, the 7 questions (exactly as game.make_question builds them from repo/bench/categories.json), the
// authored lines and every tunable rule (meters, topics, retraction regex) come from data/game_data.json, which
// tools/ref_dump.py writes from game.py itself. Line choice reproduces Python's
// random.Random(f"{seed}:{turn}:{key}").choice bit-exactly (pyrandom.js), so a seeded session replays game.py.
//
// decider(rows) -> Promise<{results, ms}>: results[i] maps each question name of rows[i] to {label, probs}.
import { PyRandom } from "./pyrandom.js";

// Python str.split() whitespace (str.isspace): tab to CR, x1c-x1f, space, x85, xa0, Zs, u2028, u2029
const PY_WS = new RegExp("[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+", "u");
const pyLen = s => Array.from(s).length; // len() counts code points

export function cleanText(t) {
  return String(t ?? "").split(PY_WS).filter(Boolean).join(" ");
}

export function newSeed() {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return a[0] & 0x7fffffff;
}

export function newGame(data, seed = null) {
  return { composure: 80, cooperation: 30, turn: 0, threats: 0, contradictions: 0,
    history: [[data.suspect.name, data.lines.opening[0]]], ended: false, ending: null,
    seed: seed === null || seed === undefined ? newSeed() : Math.trunc(seed), caught: [] };
}

export function meters(gs) {
  return { composure: gs.composure, cooperation: gs.cooperation, turn: gs.turn, threats: gs.threats,
    contradictions: gs.contradictions };
}

const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));
const recent = (gs, data) => gs.history.slice(-data.rules.RECENT_LINES).map(([who, text]) => `${who}: ${text}`);

export function buildState(gs, data, playerText, withRecent = true) {
  const st = { npc: pick(data.suspect, ["name", "role", "facts", "likes", "dislikes"]) };
  if (withRecent) st.recent = recent(gs, data);
  st.player_said = playerText;
  return st;
}

export function buildRows(gs, data, playerText) {
  const R = data.rules, t = gs.turn + 1, q = c => data.questions[c];
  return [
    { id: `turn${t}-a`, source: "interrogation", state: buildState(gs, data, playerText, false),
      questions: R.DECIDE_CATS.filter(c => R.RECENT_FREE.includes(c)).map(q) },
    { id: `turn${t}-b`, source: "interrogation", state: buildState(gs, data, playerText, true),
      questions: R.DECIDE_CATS.filter(c => !R.RECENT_FREE.includes(c)).map(q) },
  ];
}

export function guardRows(gs, data, reply) {
  const state = { npc: pick(data.suspect, ["name", "role", "facts"]), npc_reply: reply, quest_secret: data.secret };
  return [{ id: `turn${gs.turn + 1}-guard`, source: "interrogation", state, questions: [data.questions[data.rules.GUARD_CAT]] }];
}

export function textLimitNotice(text, limit) {
  const n = pyLen(text);
  if (n <= limit) return null;
  return `That message is ${n} characters; the limit is ${limit}. Nothing was sent. ` +
    `Shorten it by ${n - limit} characters and ask again.`;
}

const countSub = (s, k) => s.split(k).length - 1; // str.count: non-overlapping

export function topicOf(data, text) {
  const t = ` ${text.toLowerCase()} `;
  let best = "general", bestN = 0;
  for (const [name, kws] of Object.entries(data.rules.TOPICS)) {
    const n = kws.reduce((a, k) => a + countSub(t, k), 0);
    if (n > bestN) { best = name; bestN = n; }
  }
  return best;
}

function stripChars(s, chars) {
  let a = 0, b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

export function retractedTail(data, text) {
  const re = new RegExp(data.rules.RETRACTION.pattern, "gi");
  let last = null;
  for (const m of text.matchAll(re)) last = m;
  if (!last) return null;
  const tail = stripChars(text.slice(last.index + last[0].length), " .,;:!-");
  return tail || null;
}

const clamp = v => Math.max(0, Math.min(100, Math.trunc(v)));
const isTrue = (data, d) => (d.probs.true ?? 0) >= data.rules.THRESHOLD;
const conf = d => (d.label in d.probs ? d.probs[d.label] : Math.max(...Object.values(d.probs)));

export function linePool(lines, key) {
  let node = lines;
  for (const part of key.split(".")) node = node[part];
  return node;
}

export function pickLine(gs, data, key) {
  const opts = linePool(data.lines, key);
  const rng = new PyRandom(`${gs.seed}:${gs.turn}:${key}`);
  const used = new Set(gs.history.filter(([who]) => who === data.suspect.name).map(([, t]) => t));
  const fresh = opts.filter(o => !used.has(o));
  return rng.choice(fresh.length ? fresh : opts);
}

export function applyDecisions(gs, data, dec, topic = "general") {
  const R = data.rules, effects = [];
  const bump = (meter, delta, why) => {
    if (delta) {
      const old = gs[meter];
      gs[meter] = clamp(old + delta);
      effects.push({ meter, delta: gs[meter] - old, why });
    }
  };
  if (isTrue(data, dec.injection)) {
    bump("cooperation", -2, "meta / jailbreak attempt: she stays in character");
    return ["injection", effects];
  }
  if (isTrue(data, dec.threat)) {
    gs.threats += 1;
    bump("cooperation", -25, "threat");
    bump("composure", -5, "threat");
    effects.push({ note: `threats so far: ${gs.threats} (2 = lawyer)` });
    return ["threat", effects];
  }
  const closure = dec.conversation_closure.label;
  if (closure === "end") return ["closure_end", effects];
  let outcome = null;
  if (isTrue(data, dec.contradiction)) {
    gs.contradictions += 1;
    if (topic !== "general" && gs.caught.includes(topic)) {
      bump("composure", R.CONTRADICTION_REPEAT, `caught again on the same evidence (${topic})`);
    } else {
      bump("composure", R.CONTRADICTION_NEW, "caught contradicting her account" + (topic !== "general" ? ` (${topic})` : ""));
      if (topic !== "general") gs.caught.push(topic);
    }
    outcome = "contradiction";
  }
  const pers = dec.persuasion.label;
  bump("cooperation", R.PERSUASION_COOP[pers] ?? 0, `persuasion: ${pers}`);
  bump("composure", R.PERSUASION_COMPOSURE[pers] ?? 0, "the appeal gets to her");
  const att = dec.attitude.label;
  bump("cooperation", R.ATTITUDE_COOP[att] ?? 0, `attitude: ${att}`);
  if (att === "hostile") bump("composure", 3, "hostility hardens her");
  if (outcome === null) {
    if (pers === "strong" || pers === "moderate") outcome = `persuasion_${pers}`;
    else if (att === "hostile") outcome = "hostile";
    else if (closure === "pause") outcome = "pause";
    else if (att === "friendly" || att === "devoted") outcome = "friendly";
    else if (pers === "weak") outcome = "deflect";
    else outcome = "answer";
  }
  return [outcome, effects];
}

export function checkEnd(gs, data, outcome) {
  const R = data.rules;
  if (outcome === "closure_end") return "lawyer_closure";
  if (gs.threats >= 2 || gs.cooperation <= 0) return "lawyer";
  if ((gs.composure <= R.CONFESS_COMPOSURE && gs.cooperation >= R.CONFESS_COOPERATION) || gs.composure <= R.BREAK_COMPOSURE) return "confession";
  if (gs.turn >= R.MAX_TURNS) return "timeout";
  return null;
}

function summarize(results, call = "decide") {
  return Object.entries(results).map(([name, d]) => ({ name, label: d.label, conf: conf(d), probs: d.probs, call }));
}

const r1 = x => Math.round(x * 10) / 10;

export async function playTurn(gs, data, playerText, decider) {
  const R = data.rules;
  if (gs.ended) {
    return { decisions: [], effects: [], npc_line: "(The interview is over. Press Restart.)", outcome: "over",
      meters: meters(gs), ended: true, ending: gs.ending, ms: {} };
  }
  const text = cleanText(playerText);
  const notice = textLimitNotice(text, R.MAX_TEXT);
  if (notice) {
    return { decisions: [], effects: [], npc_line: null, outcome: "too_long", notice, limit: R.MAX_TEXT,
      length: pyLen(text), meters: meters(gs), ended: false, ending: null, ms: {} };
  }
  if (!text) {
    return { decisions: [], effects: [], npc_line: pickLine(gs, data, "silence"), outcome: "silence",
      meters: meters(gs), ended: false, ending: null, ms: {} };
  }
  const decide = async t => {
    const { results, ms } = await decider(buildRows(gs, data, t));
    const all = Object.assign({}, ...results);
    return [Object.fromEntries(R.DECIDE_CATS.map(c => [c, all[c]])), ms];
  };
  let [dec, msDecide] = await decide(text);
  const ms = { decide: r1(msDecide) };
  let retractNote = null, decisionsPre = [];
  const tail = isTrue(data, dec.injection) ? retractedTail(data, text) : null;
  if (tail) {
    const [tailDec, msTail] = await decide(tail);
    ms.retracted = r1(msTail);
    if (!isTrue(data, tailDec.injection)) {
      decisionsPre = summarize(dec, "full");
      dec = tailDec;
      retractNote = { note: `meta request taken back; played the rest: "${tail}"` };
    }
  }
  gs.turn += 1;
  const topic = topicOf(data, retractNote ? tail : text);
  const [outcome, effects] = applyDecisions(gs, data, dec, topic);
  if (retractNote) effects.unshift(retractNote);
  const end = checkEnd(gs, data, outcome);
  let decisions = decisionsPre.concat(summarize(dec));
  let lineKey;
  if (end) {
    lineKey = end;
    gs.ended = true;
    gs.ending = end === "confession" ? "confession" : "lawyer";
  } else if (gs.composure < 45 && (outcome === "contradiction" || outcome === "persuasion_strong")) {
    lineKey = "slip";
  } else if (["answer", "friendly", "deflect"].includes(outcome) && (outcome === "answer" || topic !== "general")) {
    lineKey = `answer.${topic}`;
  } else {
    lineKey = outcome;
  }
  let line = pickLine(gs, data, lineKey);
  if (end !== "confession") {
    const { results: gres, ms: msGuard } = await decider(guardRows(gs, data, line));
    ms.guard = r1(msGuard);
    const g = gres[0][R.GUARD_CAT];
    decisions = decisions.concat(summarize(gres[0], "guard"));
    if (isTrue(data, g) && !end) {
      line = pickLine(gs, data, "slip_caught");
      gs.composure = clamp(gs.composure - 5);
      effects.push({ meter: "composure", delta: -5, why: "llm_guard flagged a leak; she stops herself" });
      lineKey = "slip_caught";
    }
  }
  gs.history.push(["Detective", text]);
  gs.history.push([data.suspect.name, line]);
  return { decisions, effects, npc_line: line, outcome, line_key: lineKey, topic, meters: meters(gs), ended: gs.ended,
    ending: gs.ending, ms };
}
