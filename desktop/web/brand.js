import { showStartupVersion, appVersion } from './update.js';
export { appVersion };
let preferences={iconStyle:'glass',theme:'system',fontSize:18};
const media=matchMedia('(prefers-color-scheme: dark)');
let host;
export function applyBrand(prefs=preferences) {
  preferences={...preferences,...prefs};
  const dark=preferences.theme==='dark'||(preferences.theme==='system'&&media.matches);
  document.documentElement.dataset.theme=dark?'dark':'light';
  const fontSize=Math.max(14,Math.min(24,Number(preferences.fontSize)||18));
  document.documentElement.style.setProperty('--reed-font-size',fontSize+'px');
  document.documentElement.dataset.fontSize=String(fontSize);
  const fontControl=document.getElementById('appearance-font-size'),fontValue=document.getElementById('appearance-font-value');
  if(fontControl)fontControl.value=String(fontSize);if(fontValue)fontValue.textContent=fontSize+' px';
  const style=preferences.iconStyle==='illustrated'?'illustrated':'glass';
  for(const image of document.querySelectorAll('[data-brand-icon]'))image.src=`./assets/branding/${style}-${dark?'dark':'light'}.png`;
  const theme=document.getElementById('appearance-theme'),icon=document.getElementById('appearance-icon');
  if(theme)theme.value=preferences.theme||'system';if(icon)icon.value=style;
  void host?.core.invoke('update_brand_icon',{style,dark}).catch(console.error);
}
export async function initBrand(tauri) {
  host=tauri;
  if(host) {
    try {preferences={...preferences,...await host.core.invoke('desktop_preferences')};}catch(e){console.error(e);}
    await host.event.listen('desktop-appearance',event=>applyBrand(event.payload));
  }
  applyBrand();media.addEventListener('change',()=>applyBrand());
  // 启动动画上显示版本号；早于首帧等待，避免看到动画时还没有版本。
  await showStartupVersion(host).catch(()=>{});
  // Reveal only after the branded first frame is laid out and painted.
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  if(host)await host.core.invoke('ui_ready');
}
export function finishStartup() {
  const splash=document.getElementById('startup');if(!splash)return;
  splash.classList.add('startup-complete');
  setTimeout(()=>{splash.hidden=true;},240);
}
export async function saveAppearance(style,theme,fontSize=preferences.fontSize) {
  await host.core.invoke('set_appearance',{style,theme,fontSize:Number(fontSize)});
}
