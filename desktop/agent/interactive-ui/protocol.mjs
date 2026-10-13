import { EXECUTION_ENGINES } from '../../web/execution-traces.mjs';
import { MATH_SPECS, validMathState } from '../../web/math-models.mjs';
import { validSortInput } from '../../web/quicksort-trace.mjs';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const keys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const line = (value, max = 160) => typeof value === 'string' && value.length > 0 && value.length <= max;
const number = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isInteger(value);
const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
const fail = message => { throw new Error(`交互作品格式无效：${message}`); };
const bounded = (value, min, max) => number(value) && value >= min && value <= max;
const stateRef = (schema, name) => identifier(name) && Object.hasOwn(schema, name);
const enumValues = (schema, name) => stateRef(schema, name) ? schema[name] : null;
const exactState = (schema, state) => plain(state) && Object.keys(state).length === Object.keys(schema).length &&
  Object.entries(schema).every(([name, spec]) => Object.hasOwn(state, name) && integer(state[name]) && state[name] >= spec.min && state[name] <= spec.max);

export function initialArtifactState(document) {
  if (document.mode === 'algorithm') return {step:0,input:[...document.input]};
  if (document.mode === 'math') return {...document.initialState};
  return document.mode === 'fixture' ? {step:0} : {...document.initialState};
}

export function validateState(document, state) {
  if (document.mode === 'algorithm') return plain(state) && keys(state,['step','input']) && Object.keys(state).length===2 && validSortInput(state.input) && integer(state.step) && state.step>=0 && state.step<EXECUTION_ENGINES[document.algorithm].trace(state.input).length;
  if (document.mode === 'math') return validMathState(document.math,state);
  if (document.mode === 'fixture') return plain(state) && Object.keys(state).length === 1 && integer(state.step) && state.step >= 0 && state.step < document.steps.length;
  return document.mode === 'components' && exactState(document.stateSchema, state);
}

export function validateDocument(document) {
  if (!plain(document) || document.schemaVersion !== 1 || !line(document.title, 120)) fail('标题或版本');
  if (Buffer.byteLength(JSON.stringify(document), 'utf8') > 32768) fail('大小超过 32 KiB');
  if (document.mode === 'algorithm') {
    if (!keys(document,['schemaVersion','mode','algorithm','title','question','source','input']) || !Object.hasOwn(EXECUTION_ENGINES,document.algorithm) || !line(document.question,300) ||
      !plain(document.source) || !keys(document.source,['kind','label']) || document.source.kind!=='illustrative' || !line(document.source.label,80) || !validSortInput(document.input)) fail('算法版本或输入');
    return document;
  }
  if(document.mode === 'math') {
    if(!keys(document,['schemaVersion','mode','math','title','question','source','initialState']) || !Object.hasOwn(MATH_SPECS,document.math) || !line(document.question,300) || !plain(document.source) || !keys(document.source,['kind','label']) || document.source.kind!=='illustrative' || !line(document.source.label,80) || !plain(document.initialState) || !validMathState(document.math,document.initialState))fail('数学模型或参数');
    return document;
  }
  if (document.mode === 'fixture') {
    if (!keys(document, ['schemaVersion', 'mode', 'title', 'steps']) || !Array.isArray(document.steps) || document.steps.length < 2 || document.steps.length > 16 ||
      document.steps.some(step => !plain(step) || !keys(step, ['title', 'body']) || !line(step.title, 120) || !line(step.body, 1000))) fail('固定作品步骤');
    return document;
  }
  if (document.mode !== 'components') fail('模式');
  if (!keys(document, ['schemaVersion', 'mode', 'title', 'question', 'source', 'initialState', 'stateSchema', 'nodes']) || !line(document.question, 300) ||
    !plain(document.source) || !keys(document.source, ['kind', 'label']) || document.source.kind !== 'illustrative' || !line(document.source.label, 80)) fail('讲解信息');
  const schema = document.stateSchema;
  if (!plain(schema) || Object.keys(schema).length < 1 || Object.keys(schema).length > 8 || Object.entries(schema).some(([name, spec]) =>
    !identifier(name) || !plain(spec) || !keys(spec, ['min', 'max']) || !integer(spec.min) || !integer(spec.max) || spec.min < -100 || spec.max > 100 || spec.max < spec.min || spec.max - spec.min > 20)) fail('状态范围');
  if (!exactState(schema, document.initialState)) fail('初始状态');
  if (!Array.isArray(document.nodes) || document.nodes.length < 2 || document.nodes.length > 24) fail('组件数量');
  const ids = new Set();
  for (const node of document.nodes) {
    if (!plain(node) || !keys(node, ['id', 'type', 'props']) || !identifier(node.id) || ids.has(node.id) || !plain(node.props)) fail('组件结构或 ID');
    ids.add(node.id);
    const p = node.props;
    switch (node.type) {
      case 'StringTracks':
        if (!keys(p, ['text', 'pattern', 'offsetState', 'knownThrough', 'knownByState']) || !line(p.text, 40) || !line(p.pattern, 20) || !stateRef(schema, p.offsetState) ||
          (p.knownThrough !== undefined && (!integer(p.knownThrough) || p.knownThrough < 0 || p.knownThrough > p.pattern.length)) ||
          (p.knownThrough !== undefined && p.knownByState !== undefined)) fail('字符轨道');
        if (p.knownByState !== undefined) {
          const spec = schema[p.offsetState];
          if (!plain(p.knownByState) || Object.keys(p.knownByState).length !== spec.max - spec.min + 1 ||
            Array.from({ length: spec.max - spec.min + 1 }, (_, i) => String(spec.min + i)).some(key => !Object.hasOwn(p.knownByState, key) || !integer(p.knownByState[key]) || p.knownByState[key] < 0 || p.knownByState[key] > p.pattern.length)) fail('字符轨道已知区间');
        }
        break;
      case 'ArrayTrack':
        if (!keys(p, ['values', 'highlightState', 'pivotIndex', 'label']) || !Array.isArray(p.values) || p.values.length < 2 || p.values.length > 20 || p.values.some(value => !bounded(value, -999, 999)) ||
          (p.highlightState !== undefined && !stateRef(schema, p.highlightState)) || (p.pivotIndex !== undefined && (!integer(p.pivotIndex) || p.pivotIndex < 0 || p.pivotIndex >= p.values.length)) ||
          (p.label !== undefined && !line(p.label, 80))) fail('数组轨道');
        break;
      case 'Pointer':
        if (!keys(p, ['label', 'index', 'indexState']) || !line(p.label, 80) || (p.index === undefined) === (p.indexState === undefined) ||
          (p.index !== undefined && !integer(p.index)) || (p.indexState !== undefined && !stateRef(schema, p.indexState))) fail('指针');
        break;
      case 'HighlightRange':
        if (!keys(p, ['label', 'start', 'end', 'startState', 'endState']) || !line(p.label, 80) || (p.start === undefined) === (p.startState === undefined) ||
          (p.end === undefined) === (p.endState === undefined) || (p.start !== undefined && !integer(p.start)) || (p.end !== undefined && !integer(p.end)) ||
          (p.startState !== undefined && !stateRef(schema, p.startState)) || (p.endState !== undefined && !stateRef(schema, p.endState))) fail('高亮区间');
        break;
      case 'NodeGraph': {
        if (!keys(p, ['nodes', 'edges', 'activeState', 'label']) || !Array.isArray(p.nodes) || p.nodes.length < 2 || p.nodes.length > 10 ||
          p.nodes.some(item => !plain(item) || !keys(item, ['id', 'label']) || !identifier(item.id) || !line(item.label, 60)) ||
          new Set(p.nodes.map(item => item.id)).size !== p.nodes.length || !Array.isArray(p.edges) || p.edges.length > 16 ||
          p.edges.some(edge => !plain(edge) || !keys(edge, ['from', 'to', 'label']) || !p.nodes.some(item => item.id === edge.from) || !p.nodes.some(item => item.id === edge.to) || (edge.label !== undefined && !line(edge.label, 50))) ||
          (p.activeState !== undefined && !stateRef(schema, p.activeState)) || (p.label !== undefined && !line(p.label, 80))) fail('节点图');
        break;
      }
      case 'Plot': {
        if (!keys(p, ['label', 'values', 'valuesByState', 'variantState', 'max']) || !line(p.label, 80) || !bounded(p.max, 0.001, 1000) ||
          (p.values === undefined) === (p.valuesByState === undefined)) fail('数值图');
        const validBars = bars => Array.isArray(bars) && bars.length >= 1 && bars.length <= 8 && bars.every(bar => plain(bar) && keys(bar, ['label', 'value']) && line(bar.label, 40) && bounded(bar.value, 0, p.max));
        if (p.values !== undefined && !validBars(p.values)) fail('数值图数据');
        if (p.valuesByState !== undefined) {
          const spec = enumValues(schema, p.variantState);
          if (!spec || !plain(p.valuesByState) || Object.keys(p.valuesByState).length !== spec.max - spec.min + 1 ||
            Array.from({ length: spec.max - spec.min + 1 }, (_, i) => String(spec.min + i)).some(key => !Object.hasOwn(p.valuesByState, key) || !validBars(p.valuesByState[key]))) fail('数值图状态');
        }
        break;
      }
      case 'DiscreteSlider':
        if (!keys(p, ['label', 'state', 'labels']) || !line(p.label, 80) || !stateRef(schema, p.state) ||
          (p.labels !== undefined && (!Array.isArray(p.labels) || p.labels.length !== schema[p.state].max - schema[p.state].min + 1 || p.labels.some(label => !line(label, 40))))) fail('离散滑块');
        break;
      case 'DragHandle':
        if (!keys(p, ['label', 'state', 'choices']) || !line(p.label, 80) || !stateRef(schema, p.state) || !Array.isArray(p.choices) ||
          p.choices.length !== schema[p.state].max - schema[p.state].min + 1 || p.choices.some((choice, i) => !plain(choice) || !keys(choice, ['value', 'label']) || choice.value !== schema[p.state].min + i || !line(choice.label, 40))) fail('拖动柄');
        break;
      case 'ChoiceFeedback':
        if (!keys(p, ['state', 'cases']) || !stateRef(schema, p.state) || !Array.isArray(p.cases) || p.cases.length !== schema[p.state].max - schema[p.state].min + 1 ||
          p.cases.some((item, i) => !plain(item) || !keys(item, ['value', 'reason', 'correct']) || item.value !== schema[p.state].min + i || !line(item.reason, 500) || (item.correct !== undefined && typeof item.correct !== 'boolean'))) fail('选择反馈');
        break;
      case 'StageReveal':
        if (!keys(p, ['state', 'equals', 'title', 'body']) || !stateRef(schema, p.state) || !integer(p.equals) || p.equals < schema[p.state].min || p.equals > schema[p.state].max || !line(p.title, 100) || !line(p.body, 500)) fail('阶段揭示');
        break;
      case 'Reset':
        if (!keys(p, ['label']) || (p.label !== undefined && !line(p.label, 40))) fail('重置');
        break;
      default: fail(`未知组件 ${String(node.type).slice(0, 40)}`);
    }
  }
  return document;
}
