// 模型经常把数学写成近似 LaTeX 却不加定界符：c = g^m r^n、E(m)^k → m·k、Z*_{n²}。
// 这里做一层保守的自动补全：
//   1. 整行以公式为主（数学字符占比高）→ 整行包成 $...$，适合「一行一条公式」的排版；
//   2. 否则把行内「带上下标或运算符的片段」各自包起来，普通叙述与中文不动。
// 只允许在原文里插入 $，不改动任何字符。
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const MATH_CHAR = /[A-Za-z0-9\\^_=<>≤≥≠≈×·⋅→⇒∈∉∑∏√∞∫±²³¹⁻⁰⁴⁵⁶⁷⁸⁹*/|+\-(){}\[\]]/;
const SIGNAL = /[\\^_=<>≤≥≠≈×·⋅→⇒∈∉∑∏√∞∫±*/|]/;
const SUPER = /[²³¹⁻⁰⁴⁵⁶⁷⁸⁹]/;
const SKIP = "```[\\s\\S]*?(?:```|$)|`[^`\\n]*`";
const TOKEN = "[A-Za-z]+|[0-9]+|[\\^_=<>≤≥≠≈×·⋅→⇒∈∉∑∏√∞∫±²³¹⁻⁰⁴⁵⁶⁷⁸⁹+*/|\\-]|(?<=[A-Za-z0-9\\^_=<>≤≥≠≈×·⋅→⇒∈∉∑∏√∞∫±²³¹⁻⁰⁴⁵⁶⁷⁸⁹])[()\\[\\]{}]|\\S";
const signalsIn = text => (text.match(new RegExp(SIGNAL.source, "g")) || []).length;
// 字母数字混排（c1c2c3、n2）算公式。
const alnumLike = text => /^[A-Za-z0-9]+$/.test(text) && text.length >= 3 && (text.match(/[0-9]/g) || []).length >= 2;
// 一行是否以公式为主。
export function formulaDominant(line) {
  const text = String(line || "").trim();
  if (!text || CJK.test(text) || text.startsWith("$") || text.startsWith("`")) return false;
  const withoutCode = text.replace(/`[^`]*`/g, " ");
  const meaningful = withoutCode.replace(/\s+/g, "");
  if (!meaningful) return false;
  const mathChars = (meaningful.match(new RegExp(MATH_CHAR.source, "g")) || []).length;
  const signals = signalsIn(withoutCode) + (SUPER.test(withoutCode) ? 1 : 0);
  const longWords = withoutCode.match(/[A-Za-z]{5,}/g) || [];
  if (signals >= 2 && mathChars / meaningful.length >= 0.55 && longWords.length === 0) return true;
  // 带括号的短表达式也当作整行公式，例如 E(m)^k → m·k
  return signals >= 2 && mathChars / meaningful.length >= 0.45 && /[()]/.test(withoutCode) && longWords.length === 0;
}
// 行内片段是否值得单独包成公式。
function runLike(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed || CJK.test(trimmed) || trimmed.startsWith("`") || trimmed.startsWith("$")) return false;
  const letters = (trimmed.match(/[A-Za-z]/g) || []).length;
  const signals = signalsIn(trimmed) + (SUPER.test(trimmed) ? 1 : 0);
  const parens = /[(){}[\]]/.test(trimmed);
  if (signals >= 1 && letters >= 1) return true;
  return alnumLike(trimmed) && letters >= 2 && (parens || signals >= 1);
}
// 把一行里连续的数学片段合并成 span（只记录位置，不改字符）。
function lineSpans(line) {
  const pattern = new RegExp(`${SKIP}|${TOKEN}`, "g");
  const spans = [];
  let cursor = 0, current = null;
  const flush = () => { if (current) { spans.push(current); current = null; } };
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    const token = match[0], start = match.index, end = start + token.length;
    if (token.startsWith("`")) { flush(); spans.push({ kind: "protected", start, end }); cursor = end; continue; }
    // 空白也并入当前片段：公式里常有空格（c = g^m r^n），但不能跨越中文。
    if (/^\s*$/.test(token) && current) { current.end = end; cursor = end; continue; }
    if (CJK.test(token)) { flush(); spans.push({ kind: "text", start, end }); cursor = end; continue; }
    if (current) current.end = end;
    else current = { kind: "math", start, end };
    cursor = end;
  }
  flush();
  return spans;
}
export function wrapUndelimitedMath(text) {
  const source = String(text || "");
  if (!source.trim()) return source;
  let fence = false;
  return source.split(/(\r?\n)/).map(line => {
    if (/^\s*$/.test(line)) return line;
    // 围栏代码块、缩进代码：原样保留，绝不插入定界符。
    const marker = /^\s*(?:```|~~~)/.test(line);
    if (marker) { fence = !fence; return line; }
    if (fence || /^(?: {4,}|\t)/.test(line)) return line;
    if (formulaDominant(line)) return "$" + line.trim() + "$";
    const spans = lineSpans(line);
    let out = "", cursor = 0;
    for (const span of spans) {
      if (span.start > cursor) out += line.slice(cursor, span.start);
      let start = span.start, end = span.end;
      // 片段末尾吸进来的中文标点与空白必须排除：它们是句子的一部分，不该进公式。
      if (span.kind === "math") while (end > start && /[\s，。；：！？、）】》”’…]/.test(line[end - 1])) end--;
      const raw = line.slice(start, end);
      out += span.kind === "math" && runLike(raw) ? "$" + raw.trim() + "$" : raw;
      if (end < span.end) out += line.slice(end, span.end);
      cursor = span.end;
    }
    out += line.slice(cursor);
    return out;
  }).join("");
}
// 只在整段确实出现数学特征时才处理，普通叙述直接返回原文。
export function normalizeMathDelimiters(text) {
  const source = String(text || "");
  if (!source.trim()) return source;
  if (!/[\\^_=<>≤≥≠≈×·⋅→⇒∈∉∑∏√∞∫±²³¹⁻⁰⁴⁵⁶⁷⁸⁹]/.test(source)) return source;
  return wrapUndelimitedMath(source);
}
