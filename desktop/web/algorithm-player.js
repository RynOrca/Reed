import { createQuicksortTrace, QUICKSORT_CODE, validSortInput } from './quicksort-trace.mjs';

export function createAlgorithmPlayer(documentData, savedState, onChange) {
  const make = (tag, cls, text) => { const item = document.createElement(tag); if (cls) item.className = cls; if (text !== undefined) item.textContent = text; return item; };
  let input = [...(validSortInput(savedState?.input) ? savedState.input : documentData.input)];
  let trace = createQuicksortTrace(input), step = Math.min(Math.max(0, savedState?.step || 0), trace.length - 1);
  let playing = false, timer = null, speed = 700;
  const root = make('div', 'algorithm-player');
  const intro = make('p', 'interactive-question', documentData.question);
  const convention = make('p', 'algorithm-convention', 'Lomuto 分区 · 末尾元素为枢轴 · 严格小于 · 索引从 0 开始');
  const controls = make('div', 'algorithm-controls');
  const button = (text, action) => { const b = make('button', '', text); b.type = 'button'; b.onclick = action; return b; };
  const persist = () => onChange({ step, input: [...input] });
  const stop = () => { playing = false; clearTimeout(timer); timer = null; play.textContent = '自动播放'; };
  const move = next => { step = Math.max(0, Math.min(trace.length - 1, next)); render(); persist(); };
  const previous = button('上一步', () => { stop(); move(step - 1); });
  const next = button('下一步', () => { stop(); move(step + 1); });
  const tick = () => {
    if (!playing) return;
    if (!root.isConnected || root.closest('[hidden]') || document.hidden) { stop(); return; }
    move(step + 1);
    if (step === trace.length - 1) stop();
    else timer = setTimeout(tick, speed);
  };
  const play = button('自动播放', () => { if (playing) { stop(); return; } if (step === trace.length - 1) move(0); playing = true; play.textContent = '暂停'; timer = setTimeout(tick, speed); });
  const reset = button('重置', () => { stop(); move(0); });
  const speedLabel = make('label', 'algorithm-speed', '速度 '), speedSelect = make('select');
  speedSelect.setAttribute('aria-label', '播放速度');
  for (const [value, label] of [[1400, '慢'], [700, '正常'], [180, '快']]) { const option = make('option', '', label); option.value = value; speedSelect.append(option); }
  speedSelect.value = speed; speedSelect.onchange = () => { speed = Number(speedSelect.value); if (playing) { clearTimeout(timer); timer = setTimeout(tick, speed); } };
  speedLabel.append(speedSelect); controls.append(previous, play, next, reset, speedLabel);
  const progress = make('input', 'algorithm-progress'); progress.type = 'range'; progress.min = '0'; progress.max = trace.length - 1; progress.step = '1'; progress.setAttribute('aria-label', '执行步骤');
  progress.oninput = () => { stop(); step = Number(progress.value); render(); };
  progress.onchange = persist;
  const status = make('div', 'algorithm-status'), action = make('strong'), count = make('span'); status.append(action, count);
  const explanation = make('p', 'algorithm-explanation'); explanation.setAttribute('aria-live', 'polite');
  const layout = make('div', 'algorithm-layout'), view = make('div', 'algorithm-view'), codePanel = make('div', 'algorithm-code-panel');
  view.append(make('h4', '', '数组与变量'));
  const array = make('div', 'algorithm-array'), variables = make('dl', 'algorithm-variables');
  const legend = make('p', 'algorithm-legend', '金色：枢轴　蓝色：本步涉及　绿色：最终位置　淡色：当前区间外');
  const stack = make('ol', 'algorithm-stack');
  view.append(array, legend, variables, make('h4', '', '调用栈 · 栈顶在下'), stack);
  codePanel.append(make('h4', '', '正在执行的 JavaScript'));
  const code = make('ol', 'algorithm-code');
  const codeLines = QUICKSORT_CODE.map(line => { const li = make('li'); li.append(make('code', '', line)); code.append(li); return li; }); codePanel.append(code);
  layout.append(view, codePanel);
  const form = make('form', 'algorithm-input-form'), label = make('label', '', '换一个输入数组');
  const field = make('input'); field.type = 'text'; field.value = input.join(', '); field.maxLength = 100; field.placeholder = '例如 7, 3, 9, 2, 5'; field.setAttribute('aria-label', '输入数组');
  label.append(field); const apply = make('button', '', '重新生成过程'); apply.type = 'submit';
  const error = make('p', 'interactive-card-error'); error.setAttribute('role', 'alert');
  form.append(label, apply, error);
  form.onsubmit = event => {
    event.preventDefault(); stop();
    const raw = field.value.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
    const parts = raw ? raw.split(/[,，\s]+/) : [];
    const candidate = parts.map(value => /^-?\d+$/.test(value) ? Number(value) : NaN);
    if (!validSortInput(candidate)) { error.textContent = '请输入 0–12 个 -999 至 999 的整数，以逗号或空格分隔。'; return; }
    error.textContent = ''; input = candidate; trace = createQuicksortTrace(input); step = 0; progress.max = trace.length - 1; render(); persist();
  };
  root.append(intro, convention, controls, progress, status, explanation, layout, form);
  function render() {
    const current = trace[step], vars = current.variables;
    progress.value = step; previous.disabled = step === 0; next.disabled = step === trace.length - 1;
    action.textContent = current.action; count.textContent = `${step + 1} / ${trace.length} 步 · 比较 ${current.comparisons} · 交换 ${current.swaps}`;
    explanation.textContent = current.explanation;
    array.replaceChildren();
    current.array.forEach((value, index) => {
      const cls = ['algorithm-cell', current.marks.includes(index) ? 'involved' : '', current.fixed.includes(index) ? 'settled' : '', vars.pivotIndex === index ? 'pivot' : '', vars.low !== undefined && (index < vars.low || index > vars.high) ? 'outside' : ''].filter(Boolean).join(' ');
      const cell = make('div', cls); cell.append(make('span', 'algorithm-value', value), make('small', '', index));
      const pointers = ['i', 'j'].filter(key => vars[key] === index).join(', ');
      if (pointers) cell.append(make('b', 'algorithm-cell-pointer', pointers)); array.append(cell);
    });
    if (!current.array.length) array.append(make('p', '', '空数组'));
    variables.replaceChildren();
    for (const key of ['low', 'high', 'pivot', 'i', 'j', 'p']) { variables.append(make('dt', '', key), make('dd', '', vars[key] === undefined ? '—' : String(vars[key]))); }
    stack.replaceChildren();
    current.stack.forEach((frame, index) => {
      const li = make('li', index === current.stack.length - 1 ? 'current' : '');
      li.textContent = `${frame.kind}(a, ${frame.low}, ${frame.high})${frame.p !== undefined ? ` · p=${frame.p}` : ''}`; stack.append(li);
    });
    if (!current.stack.length) stack.append(make('li', '', step === trace.length - 1 ? '调用栈已清空' : '尚未进入函数'));
    codeLines.forEach((line, index) => { line.classList.toggle('current', index + 1 === current.line); if (index + 1 === current.line) line.setAttribute('aria-current', 'step'); else line.removeAttribute('aria-current'); });
  }
  render();
  root.pause = stop;
  return root;
}
