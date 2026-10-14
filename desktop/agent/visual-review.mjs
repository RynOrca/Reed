import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

export const VISUAL_TOOLS = ["visual_review"];
const visualExtensions = new Set([".html", ".htm", ".css", ".svg", ".jsx", ".tsx", ".vue", ".svelte"]);
const digest = value => createHash("sha256").update(value).digest("hex");
const text = value => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: value });

// A review is the model's assessment of real screenshots, not a claim of objective perfection.
// The gate keeps the artifact, screenshots and assessments tied to the same revision.
export function createVisualReview({ scope, send = () => {}, enabled = () => true, maxRounds = 6, maxNudges = 8 }) {
  let state;
  const reset = prompt => { state = { prompt, files: new Map(), captures: [], reviews: [], nudges: 0, lastStop: null, blocked: null, browserFailures:0, browserFailureStreak:0, browserStopped:false, changedAt: 0 }; };
  reset("");
  const revisions = () => [...state.files].map(([path, hash]) => ({ path, hash }));
  const revisionId = () => digest(JSON.stringify(revisions()));
  const pending = () => state.files.size > 0 && !state.reviews.some(r => r.revision === revisionId() && r.passed);
  function limitReason() {
    if (state.reviews.length >= maxRounds) return "视觉验收达到本轮次数上限，仍有问题需要处理";
    if (state.nudges >= maxNudges) return "视觉验收多次未取得有效进展";
    if (state.blocked) return state.blocked;
    return null;
  }
  function snapshot() {
    return { required: state.files.size > 0, passed: state.files.size > 0 && !pending(), rounds: state.reviews.length,
      maxRounds, browserFailures:state.browserFailures, browserStopped:state.browserStopped, revisions: revisions(), screenshots: state.captures.map(c => ({ ...c })), reviews: state.reviews, reason: limitReason() };
  }
  async function refresh() {
    for (const path of state.files.keys()) {
      try { const hash = digest(await readFile(await scope.check(path))); if (hash !== state.files.get(path)) state.changedAt = Date.now(); state.files.set(path, hash); }
      catch { state.blocked = "产物文件无法读取，不能确认最新版本的视觉验收"; }
    }
  }
  function instruction() {
    return `browser失败时先核对参数和错误，只允许一次纠正后重试；连续两次或本轮累计三次失败必须停止浏览器验收并如实报告，不能反复换参数重试或声称验收通过。网页产物验收规则：写入/修改网页后，必须使用 browser 预览，再 screenshot 获取真实图片；桌面宽度至少 900px、窄屏宽度至多 480px各一次。动画还需等待至少 1000ms后再次截图。仔细查看图片，按用户要求检查裁切、布局、可读性、运动和交互，调用 visual_review 记录逐项检查与问题。发现问题应修复并重新截图；修改后旧截图无效。最多 ${maxRounds} 次评审，停滞时明确报告剩余问题。不得把写文件成功或未经截图的猜测当作验收通过。当前验收状态：${JSON.stringify(snapshot())}`;
  }
  return {
    begin: reset,
    snapshot,
    outcome(base) {
      if(base.status==="complete" && state.browserStopped)return {...base,status:"unverified",message:state.blocked,visualReview:snapshot()};
      if (base.status !== "complete" || !pending()) return base;
      return { ...base, status: "unverified", message: limitReason() || "文件已生成，但视觉验收尚未通过", visualReview: snapshot() };
    },
    extension(pi) {
      pi.registerTool(defineTool({ name: "visual_review", label: "视觉验收", description: "查看本轮真实 browser 截图后提交验收：逐项记录用户需求检查、剩余问题和结论。文件修改后必须重新截图；至少桌面和窄屏，动画另有延迟截图。通过表示模型基于证据的评审，不保证没有缺陷。",
        parameters: Type.Object({ screenshotPaths: Type.Array(Type.String(), { minItems: 2, maxItems: 12 }), checks: Type.Array(Type.Object({ requirement: Type.String({ minLength: 1, maxLength: 500 }), passed: Type.Boolean(), evidence: Type.String({ minLength: 1, maxLength: 1200 }) }), { minItems: 1, maxItems: 30 }), issues: Type.Array(Type.Object({ severity: Type.Union(["critical", "major", "minor"].map(v => Type.Literal(v))), description: Type.String({ minLength: 1, maxLength: 1500 }) }), { maxItems: 30 }), passed: Type.Boolean() }),
        async execute(_id, input) {
          await refresh();
          if (!state.files.size) throw new Error("本轮没有已修改的网页产物需要验收");
          if (state.reviews.length >= maxRounds) throw new Error(limitReason());
          const revision = revisionId();
          const captures = input.screenshotPaths.map(path => state.captures.find(c => c.artifactPath === path && c.revision === revision));
          if (captures.some(c => !c)) throw new Error("必须使用本轮最新产物的真实截图；修改后请重新截图");
          if (!captures.some(c => (c.viewport?.width ?? c.width) >= 900) || !captures.some(c => (c.viewport?.width ?? c.width) <= 480)) throw new Error("需要桌面（至少900px）和窄屏（至多480px）截图");
          if (/动画|公转|animation|animate/i.test(state.prompt) && !captures.some(c => c.waitMs >= 1000)) throw new Error("动画还需要等待至少1000ms后截图，检查运行后的画面");
          for (const file of state.files.keys()) {
            if ([".html", ".htm"].includes(extname(file).toLowerCase()) && !captures.some(c => c.sourcePath === file)) throw new Error("每个修改的HTML产物都需要对应截图");
          }
          if (input.passed && (input.issues.length || input.checks.some(c => !c.passed))) throw new Error("仍有问题或检查未通过时，不能宣称验收通过");
          const review = { ...input, revision, round: state.reviews.length + 1, reviewedAt: new Date().toISOString() };
          state.reviews.push(review);
          pi.appendEntry("reed_visual_review", review);
          send({ type: "visual_review", ...snapshot(), message: input.passed ? "视觉评审已通过" : "视觉评审发现问题，继续修复并复查" });
          return text({ ...review, next: input.passed ? "可以总结已验证的结果" : "修复问题后重新截图与评审；如无法解决，明确报告剩余问题" });
        } }));
      pi.on("before_agent_start", event => {
        event.systemPromptOptions.sections.reed_visual_review = instruction();
      });
      pi.on("input", event => { if (event.streamingBehavior && event.text) state.prompt += `\n用户补充：${event.text}`; });
      pi.on("tool_call", event => {
        if(event.toolName==="browser" && state.browserStopped)return {block:true,terminate:true,reason:state.blocked};
        if (pending() && state.reviews.length >= maxRounds) return { block: true, terminate: true, reason: limitReason() };
      });
      pi.on("context_with_system", event => ({ messages: [...event.messages, { role: "system", content: "", sections: { reed_visual_review: instruction() } }] }));
      pi.on("tool_result", async event => {
        if (event.isError) {
          if(event.toolName==="browser"){
            state.browserFailures++;state.browserFailureStreak++;
            state.browserStopped=state.browserFailureStreak>=2||state.browserFailures>=3;
            state.blocked=state.browserStopped?"browser多次失败，本轮已停止重试；请报告实际错误和未验收项目":"浏览器验收失败：请先核对错误，最多纠正后重试一次";
          }
          return;
        }
        if(event.toolName==="browser"){
          state.browserFailureStreak=0;
          if(!state.browserStopped && /^浏览器验收失败/.test(state.blocked||""))state.blocked=null;
        }
        if (["write", "edit"].includes(event.toolName) && visualExtensions.has(extname(event.input.path || "").toLowerCase())) {
          const path = await scope.check(event.input.path);
          state.files.set(path, digest(await readFile(path)));
          state.changedAt = Date.now();
          if(!state.browserStopped)state.blocked = null;
        }
        if (event.toolName === "browser" && event.input.action === "screenshot" && event.content.some(c => c.type === "image")) {
          await refresh();
          const c = event.details;
          if (c?.artifactPath && c?.width && c?.height) {
            if (c.loadedAt && Date.parse(c.loadedAt) < state.changedAt) return;
            const sourcePath = c.sourcePath ? resolve(c.sourcePath) : null;
            // Reject stale local pages even if the screenshot is newly captured.
            if (sourcePath && state.files.has(sourcePath) && c.sourceHash !== state.files.get(sourcePath)) return;
            state.captures.push({ ...c, sourcePath, revision: revisionId() });
            state.captures = state.captures.slice(-24);
            if(!state.browserStopped)state.blocked = null;
          }
        }
      });
      pi.on("turn_end", event => { if (event.message.role === "assistant") state.lastStop = event.message.stopReason; });
      pi.on("agent_before_settle", async (event, ctx) => {
        if (!pending() || event.continue || event.outcome !== "completed" || state.lastStop !== "stop" || ctx.hasPendingMessages?.()) return;
        await refresh();
        if (!enabled()) state.blocked = "浏览器能力已关闭，网页产物尚未视觉验收";
        if (!ctx.model?.input?.includes("image")) state.blocked = "当前模型未启用图片输入，网页产物尚未视觉验收";
        const reason = limitReason();
        if (reason) { send({ type: "visual_review", ...snapshot(), message: reason }); return; }
        state.nudges++;
        const message = "网页产物尚未通过最新版本的视觉验收。请继续预览、桌面/窄屏截图、逐项评审，修复后复查。";
        send({ type: "recovery", message: "产物已生成，正在继续截图与视觉验收…" });
        return { entries: [{ type: "custom_message", customType: "reed_visual_review_required", content: message, display: false, details: { round: state.nudges } }], continue: true };
      });
    },
  };
}
