// One queue owns all workspace transitions, including navigation into a panel.
export function createWorkspacePanels(){
  const panels=new Map();let tail=Promise.resolve();
  const run=operation=>{const task=tail.then(operation);tail=task.catch(()=>{});return task;};
  async function hide(name){const panel=panels.get(name);await panel.close();if(panel.isOpen())throw Error('面板尚未收起，请先完成保存后重试');}
  async function show(name,operation){
    for(const [other,panel]of panels)if(other!==name&&panel.isOpen())await hide(other);
    await (operation||panels.get(name).open)();
  }
  return {
    register(name,panel){panels.set(name,panel);},
    show:(name,operation)=>run(()=>show(name,operation)),
    close:name=>run(()=>hide(name)),
    toggle:name=>run(()=>panels.get(name).isOpen()?hide(name):show(name)),
  };
}
