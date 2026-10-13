const el = (tag, className, value) => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (value !== undefined) item.textContent = String(value);
  return item;
};
const valueOf = (state, fixed, key) => key === undefined ? fixed : state[key];

export function createComponentExperience(document, savedState, onChange) {
  let state = { ...document.initialState, ...savedState };
  const root = el('div', 'interactive-experience');
  root.append(el('p', 'interactive-question', document.question));
  const updates = [];
  const setValue = (name, value, commit = true) => {
    if (state[name] !== value) { state = { ...state, [name]: value }; for (const update of updates) update(); }
    if (commit) onChange({ ...state });
  };
  for (const node of document.nodes) {
    const p = node.props;
    let container;
    let update = () => {};
    switch (node.type) {
      case 'StringTracks': {
        container = el('div', 'interactive-tracks');
        const renderRow = (label, chars, offset, knownThrough) => {
          const row = el('div', 'interactive-track-row');
          row.append(el('span', 'interactive-track-label', label));
          for (let i = 0; i < offset; i++) row.append(el('span', 'interactive-track-cell empty', ''));
          [...chars].forEach((char, i) => row.append(el('span', `interactive-track-cell${knownThrough !== undefined && i < knownThrough ? ' known' : ''}`, char)));
          return row;
        };
        update = () => container.replaceChildren(renderRow('文本', p.text, 0), renderRow('模式', p.pattern, state[p.offsetState], p.knownByState ? p.knownByState[state[p.offsetState]] : p.knownThrough));
        break;
      }
      case 'ArrayTrack': {
        container = el('div', 'interactive-array');
        if (p.label) container.append(el('p', 'interactive-node-label', p.label));
        const row = el('div', 'interactive-array-row'); container.append(row);
        update = () => {
          row.replaceChildren();
          p.values.forEach((value, index) => {
            const cell = el('span', `interactive-array-cell${index === p.pivotIndex ? ' pivot' : ''}${p.highlightState !== undefined && index < state[p.highlightState] ? ' selected' : ''}`, value);
            cell.setAttribute('aria-label', `索引 ${index}，值 ${value}${index === p.pivotIndex ? '，枢轴' : ''}`);
            row.append(cell);
          });
        };
        break;
      }
      case 'Pointer':
        container = el('p', 'interactive-pointer');
        update = () => { container.textContent = `${p.label} → 索引 ${valueOf(state, p.index, p.indexState)}`; };
        break;
      case 'HighlightRange':
        container = el('p', 'interactive-range');
        update = () => { container.textContent = `${p.label}：${valueOf(state, p.start, p.startState)}–${valueOf(state, p.end, p.endState)}`; };
        break;
      case 'NodeGraph': {
        container = el('div', 'interactive-graph');
        if (p.label) container.append(el('p', 'interactive-node-label', p.label));
        const graph = el('div', 'interactive-graph-row'); container.append(graph);
        const vertices = p.nodes.map(item => { const vertex = el('span', 'interactive-vertex', item.label); graph.append(vertex); return vertex; });
        const edges = el('p', 'interactive-edges', p.edges.map(edge => `${p.nodes.find(item => item.id === edge.from).label} → ${p.nodes.find(item => item.id === edge.to).label}${edge.label ? `（${edge.label}）` : ''}`).join(' · '));
        container.append(edges);
        update = () => vertices.forEach((vertex, index) => vertex.classList.toggle('active', p.activeState !== undefined && state[p.activeState] === index));
        break;
      }
      case 'Plot': {
        container = el('div', 'interactive-plot');
        container.append(el('p', 'interactive-node-label', p.label));
        const bars = el('div', 'interactive-bars'); container.append(bars);
        update = () => {
          bars.replaceChildren();
          const data = p.valuesByState ? p.valuesByState[state[p.variantState]] : p.values;
          for (const item of data) {
            const line = el('div', 'interactive-bar-line');
            const label = el('span', 'interactive-bar-label', item.label);
            const track = el('span', 'interactive-bar-track');
            const fill = el('span', 'interactive-bar-fill'); fill.style.width = `${Math.max(0, Math.min(100, item.value / p.max * 100))}%`; track.append(fill);
            line.append(label, track, el('span', 'interactive-bar-value', Number(item.value).toFixed(item.value < 1 ? 3 : 1)));
            bars.append(line);
          }
        };
        break;
      }
      case 'DiscreteSlider': {
        container = el('label', 'interactive-slider');
        const heading = el('span', 'interactive-node-label', p.label);
        const output = el('output', 'interactive-slider-value');
        const input = el('input'); input.type = 'range'; input.min = document.stateSchema[p.state].min; input.max = document.stateSchema[p.state].max; input.step = '1';
        input.setAttribute('aria-label', p.label);
        input.addEventListener('input', () => setValue(p.state, Number(input.value), false));
        input.addEventListener('change', () => setValue(p.state, Number(input.value), true));
        container.append(heading, input, output);
        update = () => { input.value = state[p.state]; output.textContent = p.labels ? p.labels[state[p.state] - document.stateSchema[p.state].min] : String(state[p.state]); };
        break;
      }
      case 'DragHandle': {
        container = el('div', 'interactive-drag');
        container.append(el('p', 'interactive-node-label', p.label));
        const rail = el('div', 'interactive-drag-rail');
        const fill = el('span', 'interactive-drag-fill'); const knob = el('span', 'interactive-drag-knob'); rail.append(fill, knob);
        const handle = el('div', 'interactive-drag-target'); handle.setAttribute('role', 'slider'); handle.tabIndex = 0;
        handle.setAttribute('aria-label', p.label); handle.setAttribute('aria-valuemin', document.stateSchema[p.state].min); handle.setAttribute('aria-valuemax', document.stateSchema[p.state].max);
        handle.append(rail); container.append(handle);
        const choices = el('div', 'interactive-drag-choices'); p.choices.forEach(choice => choices.append(el('span', '', choice.label))); container.append(choices);
        const spec = document.stateSchema[p.state];
        const fromPointer = event => {
          const rect = rail.getBoundingClientRect();
          return Math.max(spec.min, Math.min(spec.max, spec.min + Math.round((event.clientX - rect.left) / Math.max(1, rect.width) * (spec.max - spec.min))));
        };
        let dragging = false;
        handle.addEventListener('pointerdown', event => { dragging = true; handle.setPointerCapture(event.pointerId); setValue(p.state, fromPointer(event), false); });
        handle.addEventListener('pointermove', event => { if (dragging) setValue(p.state, fromPointer(event), false); });
        handle.addEventListener('pointerup', event => { if (!dragging) return; dragging = false; setValue(p.state, fromPointer(event), true); });
        handle.addEventListener('pointercancel', () => { dragging = false; setValue(p.state, state[p.state], true); });
        handle.addEventListener('keydown', event => {
          const target = event.key === 'Home' ? spec.min : event.key === 'End' ? spec.max : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? state[p.state] - 1 : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? state[p.state] + 1 : null;
          if (target === null) return;
          event.preventDefault(); setValue(p.state, Math.max(spec.min, Math.min(spec.max, target)), true);
        });
        update = () => { const percent = (state[p.state] - spec.min) / Math.max(1, spec.max - spec.min) * 100; fill.style.width = `${percent}%`; knob.style.left = `${percent}%`; handle.setAttribute('aria-valuenow', state[p.state]); handle.setAttribute('aria-valuetext', p.choices[state[p.state] - spec.min].label); };
        break;
      }
      case 'ChoiceFeedback':
        container = el('p', 'interactive-feedback');
        update = () => { const item = p.cases[state[p.state] - document.stateSchema[p.state].min]; container.textContent = item.reason; container.classList.toggle('correct', item.correct === true); };
        break;
      case 'StageReveal':
        container = el('div', 'interactive-reveal');
        container.append(el('strong', '', p.title), el('p', '', p.body));
        update = () => { container.hidden = state[p.state] !== p.equals; };
        break;
      case 'Reset': {
        container = el('button', 'interactive-reset', p.label || '重置'); container.type = 'button';
        container.onclick = () => { state = { ...document.initialState }; for (const refresh of updates) refresh(); onChange({ ...state }); };
        break;
      }
      default: throw new Error(`不支持的组件：${node.type}`);
    }
    root.append(container); updates.push(update);
  }
  for (const update of updates) update();
  const source = el('p', 'interactive-source', `来源：${document.source.label} · 用于观察机制，不代表学习掌握度`);
  root.append(source);
  return root;
}
