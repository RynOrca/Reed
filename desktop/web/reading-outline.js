// 阅读目录：只跟随最后一条助手回答，不改变消息本身。
// 目录在宽窗出现；窄窗由 CSS 收起，避免和正文抢空间。
const MAX_ITEMS = 7;

export function createOutline({ transcript, messages, onOpenGoals }) {
  const shell = document.querySelector(".chat-shell");
  const host = document.querySelector(".chat-body");
  const rail = document.createElement("aside");
  rail.className = "outline-rail";
  rail.hidden = true;
  rail.setAttribute("aria-label", "本文目录");
  rail.innerHTML = `<div class="outline-label">本文目录</div>
    <div class="outline-list" role="navigation" aria-label="回答小标题"></div>
    <p class="outline-empty" hidden>当前回答还没有小标题</p>
    <div class="outline-meta" hidden></div>
    <button class="outline-goal" type="button" hidden>
      <span class="og-label">学习目标</span>
      <span class="og-title"></span>
      <span class="og-bar"><i></i></span>
      <span class="og-num"></span>
    </button>`;
  host.append(rail);

  const list = rail.querySelector(".outline-list");
  const empty = rail.querySelector(".outline-empty");
  const meta = rail.querySelector(".outline-meta");
  const goalButton = rail.querySelector(".outline-goal");
  const goalTitle = rail.querySelector(".og-title");
  const goalBar = rail.querySelector(".og-bar i");
  const goalNum = rail.querySelector(".og-num");

  let goal = null;
  let headings = [];
  let active = -1;
  let scheduled = false;
  let scrollScheduled = false;

  const currentProse = () => {
    const rows = [...messages.querySelectorAll(".message-row.assistant .prose-chat")];
    return rows.at(-1) || null;
  };

  function scrollTo(index) {
    const heading = headings[index];
    if (!heading) return;
    const top = heading.getBoundingClientRect().top - transcript.getBoundingClientRect().top + transcript.scrollTop - 26;
    transcript.scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }

  function updateActive() {
    scrollScheduled = false;
    if (!headings.length) return;
    const line = transcript.getBoundingClientRect().top + 78;
    let index = 0;
    headings.forEach((heading, i) => { if (heading.getBoundingClientRect().top <= line) index = i; });
    active = index;
    [...list.children].forEach((button, i) => {
      const selected = i === index;
      button.classList.toggle("active", selected);
      if (selected) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    });
  }

  function renderMeta(prose) {
    const text = prose?.textContent?.replace(/\s+/g, " ").trim() || "";
    if (!text) { meta.hidden = true; return; }
    const minutes = Math.max(1, Math.round(text.length / 360));
    meta.hidden = false;
    meta.textContent = `阅读约 ${minutes} 分钟`;
    const source = document.createElement("span");
    source.textContent = "Agent 整理";
    meta.append(source);
  }

  function renderGoal() {
    const enabled = goal?.enabled === true;
    goalButton.hidden = !enabled;
    if (!enabled) return;
    const total = Number(goal.total) || 0;
    const done = Math.min(total, Number(goal.done) || 0);
    goalTitle.textContent = goal.project ? (goal.title || "学习目标") : "选择项目后查看学习目标";
    goalBar.style.width = total ? `${Math.round(done / total * 100)}%` : "0%";
    goalNum.textContent = !goal.project ? "" : total ? `${done} / ${total} 已完成` : "尚无小目标";
  }

  function updateVisibility() {
    const show = headings.length >= 2 || (goal?.enabled === true && goal.project && headings.length > 0);
    rail.hidden = !show;
    shell.classList.toggle("outline-visible", show);
    if (!show) active = -1;
  }

  function scan() {
    scheduled = false;
    const prose = currentProse();
    headings = prose ? [...prose.querySelectorAll("h1,h2,h3")]
      .filter(heading => heading.textContent.trim())
      .slice(0, MAX_ITEMS) : [];
    headings.forEach((heading, index) => { if (!heading.id) heading.id = `reed-outline-${index + 1}`; });

    list.replaceChildren();
    headings.forEach((heading, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "outline-item";
      button.textContent = heading.textContent.trim();
      button.title = heading.textContent.trim();
      button.onclick = () => scrollTo(index);
      list.append(button);
    });
    empty.hidden = headings.length > 0;
    renderMeta(prose);
    updateVisibility();
    updateActive();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(scan);
  }

  function scheduleActive() {
    if (scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(updateActive);
  }

  goalButton.addEventListener("click", () => onOpenGoals?.());
  new MutationObserver(schedule).observe(messages, { childList: true, subtree: true, characterData: true });
  new ResizeObserver(schedule).observe(transcript);
  transcript.addEventListener("scroll", scheduleActive, { passive: true });
  schedule();

  return {
    setGoal(summary) {
      goal = summary || null;
      renderGoal();
      updateVisibility();
    },
  };
}
