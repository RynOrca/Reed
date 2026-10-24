// Applied at document creation in the preview WebView, including navigations.
(()=>{
  const install=()=>{
    if(document.getElementById('reed-preview-scrollbars'))return;
    const style=document.createElement('style');style.id='reed-preview-scrollbars';
    style.textContent='html,body,*{scrollbar-width:thin!important;scrollbar-color:rgba(140,140,140,.65) transparent!important}::-webkit-scrollbar{width:10px;height:10px;background:transparent!important}::-webkit-scrollbar-track,::-webkit-scrollbar-track-piece,::-webkit-scrollbar-corner{background:transparent!important;border:0!important;box-shadow:none!important}::-webkit-scrollbar-thumb{background:rgba(140,140,140,.65)!important;border:2px solid transparent;border-radius:10px;background-clip:padding-box!important}::-webkit-scrollbar-thumb:hover{background-color:rgba(140,140,140,.85)!important}::-webkit-scrollbar-button{display:none!important}';
    (document.head||document.documentElement).append(style);
  };
  if(document.documentElement)install();else document.addEventListener('DOMContentLoaded',install,{once:true});
})();
