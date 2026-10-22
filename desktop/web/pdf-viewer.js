// Each request owns its canvas. A cancelled/failed render never clears the
// currently displayed page, and only the newest request can publish a result.
export function createPdfViewer({host,library,visible,onState,onImage,onPage}){
  let pdf=null,document=null,desired=0,shown=null,active=null,revision=0,mode='width',zoom=1,resizeTimer,lastGeometry='';
  const size=()=>{const style=getComputedStyle(host);return {width:Math.max(1,host.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)),height:Math.max(1,host.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom))};};
  function cancel(){revision++;active?.task?.cancel();active?.layer?.cancel();active=null;}
  function reset(){cancel();pdf=null;document=null;desired=0;shown=null;lastGeometry='';for(const page of host.querySelectorAll('.materials-page')){page.querySelector('canvas').width=0;page.remove();}}
  async function render(index=desired){
    if(!pdf||!document||!Number.isSafeInteger(index)||index<0||index>=pdf.numPages)return;
    desired=index;cancel();if(!visible()||host.clientWidth<2||host.clientHeight<2)return;
    const ticket=revision,currentPdf=pdf,currentDocument=document,job={task:null,layer:null,sheet:null,published:false};active=job;
    const current=()=>revision===ticket&&pdf===currentPdf&&visible();
    onState({state:'loading',pageIndex:index,hasPage:!!shown});
    try{
      const page=await currentPdf.getPage(index+1);if(!current())return;
      const bounds=size(),base=page.getViewport({scale:1});
      const scale=mode==='width'?bounds.width/base.width:mode==='page'?Math.min(bounds.width/base.width,bounds.height/base.height):zoom;
      const viewport=page.getViewport({scale:Math.min(4,Math.max(.1,scale))});zoom=viewport.scale;
      const ratio=Math.min(devicePixelRatio||1,2,8192/viewport.width,8192/viewport.height,Math.sqrt(16000000/(viewport.width*viewport.height)));
      const sheet=documentNode('div','materials-page materials-staging'),canvas=documentNode('canvas'),text=documentNode('div','textLayer');job.sheet=sheet;
      sheet.dataset.m='sheet';canvas.dataset.m='canvas';text.dataset.m='text';sheet.style.width=viewport.width+'px';sheet.style.height=viewport.height+'px';
      canvas.width=Math.ceil(viewport.width*ratio);canvas.height=Math.ceil(viewport.height*ratio);canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';
      sheet.append(canvas,text);host.append(sheet);
      job.task=page.render({canvas,canvasContext:canvas.getContext('2d'),viewport,transform:ratio===1?null:[ratio,0,0,ratio,0,0]});await job.task.promise;if(!current())return;
      const previous=shown;sheet.classList.remove('materials-staging');shown={sheet,canvas,pageIndex:index,document:currentDocument};job.published=true;
      previous?.sheet.remove();if(previous)previous.canvas.width=0;
      onImage({pageIndex:index,pageCount:currentPdf.numPages,zoom,mode});
      let content,warning='';
      try{content=await page.getTextContent();}catch{warning='本页画面已显示，文字层读取失败，可重试或识别本页。';}
      if(!current())return;
      const pageText=content?content.items.map(item=>(item.str||'')+(item.hasEOL?'\n':' ')).join(''):'';
      if(content){
        text.style.setProperty('--total-scale-factor',viewport.scale);text.style.setProperty('--scale-round-x','1px');text.style.setProperty('--scale-round-y','1px');
        try{job.layer=new (await library()).TextLayer({textContentSource:content,container:text,viewport});await job.layer.render();}
        catch(error){if(!current())return;text.replaceChildren();if(error.name!=='AbortException')warning='本页画面已显示，文字选择暂不可用，可重试本页。';}
      }
      if(!current())return;
      await onPage({document:currentDocument,pageIndex:index,pageCount:currentPdf.numPages,text:pageText.slice(0,100000),warning,current});
      if(current())onState({state:'ready',pageIndex:index,warning});
    }catch(error){if(current()&&!['RenderingCancelledException','AbortException'].includes(error.name))onState({state:'error',message:String(error.message),pageIndex:index,hasPage:!!shown});}
    finally{
      if(job.sheet&&!job.published){job.sheet.remove();job.sheet.querySelector('canvas').width=0;}
      if(active===job)active=null;
    }
  }
  const geometry=()=>mode==='custom'?'custom':mode==='width'?String(host.clientWidth):host.clientWidth+'x'+host.clientHeight;
  const observer=new ResizeObserver(()=>{
    clearTimeout(resizeTimer);resizeTimer=setTimeout(function refresh(){
      if(!visible()||!pdf)return;
      if(host.closest('.workspace-moving')){resizeTimer=setTimeout(refresh,100);return;}
      const next=geometry();if(next===lastGeometry)return;lastGeometry=next;if(mode!=='custom')void render();
    },100);
  });observer.observe(host);
  return {
    setDocument(value,metadata){reset();pdf=value;document=metadata;mode='width';},reset,cancel,render,
    get pageIndex(){return desired;},get count(){return pdf?.numPages||0;},get zoom(){return zoom;},get mode(){return mode;},
    get snapshot(){return shown&&active===null?shown:null;},
    async fit(value){if(!['width','page'].includes(value))return;mode=value;await render();},
    async scale(value){if(!Number.isFinite(value))return;zoom=Math.max(.25,Math.min(3,value));mode='custom';await render();},
    destroy(){reset();clearTimeout(resizeTimer);observer.disconnect();},
  };
}
function documentNode(tag,className){const node=globalThis.document.createElement(tag);if(className)node.className=className;return node;}
