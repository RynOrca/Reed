export function createLearningMode(root){
  root.innerHTML='<label><input id="role-learning-enabled" type="checkbox">学习模式</label><small id="learning-mode-hint">启用学习目标、学习画像与教学记忆；关闭后保留已有数据，工作经验记忆仍可用。</small><div class="learning-mode-child"><label><input id="role-canvas-enabled" type="checkbox">对话画布</label><small>打开画布后，每轮结束自动整理问题关系；使用当前对话模型，会产生额外请求。</small></div>';
  const mode=root.querySelector('#role-learning-enabled'),canvas=root.querySelector('#role-canvas-enabled'),hint=root.querySelector('#learning-mode-hint');let mixed=false,changed=false;
  function update(){canvas.disabled=mode.indeterminate||!mode.checked;hint.textContent=mode.indeterminate?'此角色沿用旧版部分学习权限；不修改开关则保持原权限。点击可统一启用或关闭。':'启用学习目标、学习画像与教学记忆；关闭后保留已有数据，工作经验记忆仍可用。';}
  mode.onchange=()=>{changed=true;update();};
  update();
  return {set(role={}){changed=false;const goals=role.learningGoalsEnabled===true,profile=role.learnerProfileEnabled===true;mixed=role.learningModeEnabled===null||(role.learningModeEnabled===undefined&&goals!==profile);mode.checked=role.learningModeEnabled===true||(role.learningModeEnabled===undefined&&goals&&profile);mode.indeterminate=mixed;canvas.checked=role.canvasEnabled===true;update();},get(){return {...(mixed&&!changed?{}:{learningModeEnabled:mode.checked}),canvasEnabled:canvas.checked};}};
}
