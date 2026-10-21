// 阅读目录按用户轮次聚合：工具/思考之间的多段回答属于同一轮。
// 目录在宽窗出现；窄窗由 CSS 收起，避免和正文抢空间。

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
  let selectedTurn = null;
  let groups = [];

  function collectTurns() {
    const result = []; let group;
    for (const row of messages.querySelectorAll('.message-row.user,.message-row.assistant')) {
      if (row.classList.contains('user')) {
        group = { row, id: row.dataset.messageId || row.dataset.turnId, prose: [] };
        result.push(group);
      } else if (group) {
        const prose = row.querySelector('.prose-chat'); if (prose) group.prose.push(prose);
      }
    }
    return result;
  }
  function visibleTurn() {
    const line = transcript.getBoundingClientRect().top + 78;
    let current = groups[0];
    for (const group of groups) if (group.row.getBoundingClientRect().top <= line) current = group;
    return current || null;
  }

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
    const text = prose.map(node=>node.textContent).join(' ').replace(/\s+/g, " ").trim();
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
    groups = collectTurns();
    const group = groups.find(item=>item.row===selectedTurn) || visibleTurn();
    selectedTurn = group?.row || null;
    rail.dataset.turnId = group?.id || '';
    const prose = group?.prose || [];
    headings = prose.flatMap(node=>[...node.querySelectorAll('h1,h2,h3')]).filter(heading=>heading.textContent.trim());

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
    requestAnimationFrame(()=>{
      const group=visibleTurn();
      if(group?.row!==selectedTurn){selectedTurn=group?.row||null;scan();}
      else updateActive();
      scrollScheduled=false;
    });
  }

  goalButton.addEventListener("click", () => onOpenGoals?.());
  new MutationObserver(schedule).observe(messages, { childList: true, subtree: true, characterData: true });
  new ResizeObserver(schedule).observe(transcript);
  transcript.addEventListener("scroll", scheduleActive, { passive: true });
  schedule();

  return {
    selectTurn(row) { selectedTurn=row; scan(); },
    setGoal(summary) {
      goal = summary || null;
      renderGoal();
      updateVisibility();
    },
  };
}
