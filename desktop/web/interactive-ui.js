import { createMathExplorer } from './math-explorer.js';
import { createAlgorithmPlayer } from './algorithm-player.js';
import { createComponentExperience } from './interactive-components.js';

export function createInteractiveCard(summary, { load, save }) {
  const card = document.createElement('section');
  card.className = 'interactive-card';
  card.setAttribute('aria-label', '交互讲解作品');
  const header = document.createElement('div'); header.className = 'interactive-card-header';
  const heading = document.createElement('div'); heading.className = 'interactive-card-heading';
  const eyebrow = document.createElement('span'); eyebrow.className = 'interactive-card-eyebrow'; eyebrow.textContent = '交互讲解 · 教学样例';
  const title = document.createElement('strong'); title.textContent = summary.title || '交互讲解作品';
  heading.append(eyebrow, title);
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.textContent = '展开'; toggle.setAttribute('aria-expanded', 'false');
  header.append(heading, toggle); card.append(header);
  const detail = document.createElement('div'); detail.className = 'interactive-card-detail'; detail.hidden = true; card.append(detail);
  if (summary.status === 'missing') {
    toggle.disabled = true;
    const notice = document.createElement('p'); notice.className = 'interactive-card-error'; notice.textContent = '作品文件不可用，聊天文字仍可查看。'; card.append(notice);
    return card;
  }
  let artifact = null;
  let saving = Promise.resolve();
  let loading = false;
  let experience = null;
  const persist = state => {
    artifact.state = { ...state };
    saving = saving.catch(() => {}).then(() => save(summary.artifactId, state)).catch(error => {
      const note = document.createElement('p'); note.className = 'interactive-card-error'; note.textContent = `进度未保存：${error.message || error}`; detail.append(note);
    });
  };
  const render = () => {
    experience?.pause?.();
    detail.replaceChildren();
    if (!artifact) return;
    if (artifact.stateWarning) { const warning = document.createElement('p'); warning.className = 'interactive-card-error'; warning.textContent = artifact.stateWarning; detail.append(warning); }
    if (artifact.document.mode === 'math') {
      experience=createMathExplorer(artifact.document,artifact.state,persist);detail.append(experience);
      if(summary.parentArtifactId){const version=document.createElement('p');version.className='interactive-card-version';version.textContent=`新版本 · 前一作品 ${summary.parentArtifactId.slice(0,8)}`;detail.append(version);}
      return;
    }
    if (artifact.document.mode === 'algorithm') {
      experience = createAlgorithmPlayer(artifact.document, artifact.state, persist);
      detail.append(experience);
      if (summary.parentArtifactId) { const version = document.createElement('p'); version.className = 'interactive-card-version'; version.textContent = `新版本 · 前一作品 ${summary.parentArtifactId.slice(0, 8)}`; detail.append(version); }
      return;
    }
    if (artifact.document.mode === 'components') {
      detail.append(createComponentExperience(artifact.document, artifact.state, persist));
      if (summary.parentArtifactId) { const version = document.createElement('p'); version.className = 'interactive-card-version'; version.textContent = `新版本 · 前一作品 ${summary.parentArtifactId.slice(0, 8)}`; detail.append(version); }
      return;
    }
    const steps = artifact.document.steps;
    const index = Number.isInteger(artifact.state?.step) && artifact.state.step >= 0 && artifact.state.step < steps.length ? artifact.state.step : 0;
    const progress = document.createElement('p'); progress.className = 'interactive-card-progress'; progress.textContent = `步骤 ${index + 1} / ${steps.length}`;
    const stepTitle = document.createElement('h4'); stepTitle.textContent = steps[index].title;
    const body = document.createElement('p'); body.textContent = steps[index].body;
    const actions = document.createElement('div'); actions.className = 'interactive-card-actions';
    const previous = document.createElement('button'); previous.type = 'button'; previous.textContent = '上一步'; previous.disabled = index === 0;
    const next = document.createElement('button'); next.type = 'button'; next.textContent = '下一步'; next.disabled = index === steps.length - 1;
    const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = '重置'; reset.disabled = index === 0;
    const move = step => {
      artifact.state = { step }; render(); persist({ step });
    };
    previous.onclick = () => move(index - 1); next.onclick = () => move(index + 1); reset.onclick = () => move(0);
    actions.append(previous, next, reset); detail.append(progress, stepTitle, body, actions);
    if (summary.parentArtifactId) {
      const version = document.createElement('p'); version.className = 'interactive-card-version'; version.textContent = `新版本 · 前一作品 ${summary.parentArtifactId.slice(0, 8)}`; detail.append(version);
    }
  };
  toggle.onclick = async () => {
    if (!detail.hidden) { experience?.pause?.(); detail.hidden = true; toggle.textContent = '展开'; toggle.setAttribute('aria-expanded', 'false'); return; }
    detail.hidden = false; toggle.textContent = '收起'; toggle.setAttribute('aria-expanded', 'true');
    if (artifact || loading) return;
    loading = true; detail.textContent = '正在读取作品…';
    try { artifact = await load(summary.artifactId); render(); }
    catch (error) { detail.replaceChildren(); const note = document.createElement('p'); note.className = 'interactive-card-error'; note.textContent = error.message || '作品文件不可用'; detail.append(note); }
    finally { loading = false; }
  };
  return card;
}
