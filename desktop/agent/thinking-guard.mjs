import { createHash } from "node:crypto";

// Some reasoning models get stuck repeating one short line hundreds of times and
// never reach a tool call. Reed detects that locally and stops the attempt so the
// turn can ask for one concrete action. This is not a token or time limit: a long
// but healthy reasoning stream is never interrupted.

const cjk = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

export function estimateTokens(text) {
  let tokens = 0;
  for (const char of String(text)) tokens += cjk.test(char) ? 1 : 0.25;
  return tokens;
}

const MIN_LINE = 6;
const MAX_LINE = 120;

export function createThinkingGuard({ repeatLimit = 10, windowLines = 80, minTokensForRepetition = 800 } = {}) {
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
      return stop;
    },
  };
}