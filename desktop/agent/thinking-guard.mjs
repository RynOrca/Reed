import { createHash } from "node:crypto";

// A reasoning model can spend its entire output budget planning and never emit a
// tool call. The model service does not bound that; Reed owns both bounds here so
// one turn cannot silently burn ten minutes and stop short of doing the work.
//
//   budget     – stop once the reasoning stream exceeds a token budget
//   repetition – stop once the same short line repeats inside a sliding window
//
// Both run locally on the streamed deltas. They report only counts, never the
// model's words, so diagnostics stay free of prompts and user text.

const cjk = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

export function estimateTokens(text) {
  let tokens = 0;
  for (const char of String(text)) tokens += cjk.test(char) ? 1 : 0.25;
  return tokens;
}

// `null` means auto: leave a real answer room, but never let planning own the
// whole output budget. `0` explicitly disables the budget (repetition still runs).
export function thinkingBudgetFor(configured, maxTokens) {
  if (configured === 0) return 0;
  if (Number.isSafeInteger(configured) && configured > 0) return configured;
  if (Number.isSafeInteger(maxTokens) && maxTokens > 0) return Math.min(8192, Math.max(1024, Math.floor(maxTokens * 0.6)));
  return 8192;
}

const MIN_LINE = 6;
const MAX_LINE = 120;

export function createThinkingGuard({ budgetTokens = 0, repeatLimit = 10, windowLines = 80, minTokensForRepetition = 800 } = {}) {
  let pending = "";
  let tokens = 0;
  let stop = null;
  const counts = new Map();
  const window = [];
  const lineHash = line => createHash("sha256").update(line).digest("hex").slice(0, 12);
  const record = line => {
    const key = line.trim().replace(/\s+/g, " ");
    if (key.length < MIN_LINE || key.length > MAX_LINE) return;
    counts.set(key, (counts.get(key) || 0) + 1);
    window.push(key);
    if (window.length > windowLines) {
      const removed = window.shift();
      const next = counts.get(removed) - 1;
      if (next > 0) counts.set(removed, next);
      else counts.delete(removed);
    }
    const repeats = counts.get(key) || 0;
    if (!stop && repeats >= repeatLimit && tokens >= minTokensForRepetition) {
      stop = { reason: "repetition", tokens: Math.round(tokens), repeats, lineHash: lineHash(key) };
    }
  };
  return {
    get tokens() { return Math.round(tokens); },
    get verdict() { return stop; },
    push(delta) {
      if (stop || typeof delta !== "string" || !delta) return stop;
      tokens += estimateTokens(delta);
      pending += delta;
      let index;
      while (!stop && (index = pending.indexOf("\n")) >= 0) {
        record(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
      if (pending.length > 4096) pending = pending.slice(-4096);
      if (!stop && budgetTokens > 0 && tokens >= budgetTokens) stop = { reason: "budget", tokens: Math.round(tokens), limit: budgetTokens };
      return stop;
    },
  };
}
