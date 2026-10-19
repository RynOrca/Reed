// One queue owns all workspace transitions, including navigation into a panel.
export function paintWorkspace(){
  return new Promise(resolve=>{
    const timeout=setTimeout(resolve,200);
    requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timeout);resolve();}));
  });
}
export function createWorkspacePanels({onEmpty=async()=>{}}={}){
  const panels=new Map();let tail=Promise.resolve();
  const run=operation=>{const task=tail.then(operation);tail=task.catch(()=>{});return task;};
  async function hide(name,options){const panel=panels.get(name);if(!panel.isOpen())return;await panel.close(options);if(panel.isOpen())throw Error('面板尚未收起，请先完成保存后重试');}
  async function show(name,operation){
    let handoff=false;
    for(const [other,panel]of panels)if(other!==name&&panel.isOpen()){await hide(other,{keepExpanded:true});handoff=true;}
    try{await (operation||panels.get(name).open)();}
    finally{if(handoff&&![...panels.values()].some(panel=>panel.isOpen()))await onEmpty();}
  }
  return {
    register(name,panel){panels.set(name,panel);},
    show:(name,operation)=>run(()=>show(name,operation)),
    close:name=>run(()=>hide(name)),
    toggle:name=>run(()=>panels.get(name).isOpen()?hide(name):show(name)),
  };
}
