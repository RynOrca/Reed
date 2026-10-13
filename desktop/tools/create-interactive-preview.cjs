const { readFile, writeFile, mkdir } = require('node:fs/promises');
const path = require('node:path');

async function createPreview() {
  const root = path.resolve(__dirname, '../..');
  const read = name => readFile(path.join(root, name), 'utf8');
  const [css, renderer, card, fixtures] = await Promise.all([
    read('desktop/web/style.css'), read('desktop/web/interactive-components.js'),
    read('desktop/web/interactive-ui.js'), read('desktop/agent/interactive-ui/fixtures.mjs'),
  ]);
  const script = [renderer, card.replace(/^import .*;\s*/m, ''), fixtures].join('\n').replace(/export function /g, 'function ');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reed · 组件组合预览</title><style>${css}
  html,body{height:auto;overflow:auto}body{display:block;padding:32px;max-width:1300px;margin:auto;background:#18191c;color:#e5e7eb}h1{font-size:24px;margin:0 0 10px}header p{color:#a7adb7;line-height:1.7;margin-bottom:28px}#gallery{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;align-items:start}.interactive-card{margin:0}@media(max-width:760px){body{padding:16px}#gallery{grid-template-columns:1fr}}
  </style><header><h1>Reed · 组件组合预览</h1><p>四个固定教学样例，使用 Reed 聊天中的同一套渲染器。可直接拖动和调节滑块；此页的操作只保存在内存中。它用于检查组件组合外观，不代表真实模型生成质量。</p></header><main id="gallery"></main><script type="module">${script}
  for(const topic of ['kmp','quicksort','attention','bellman']){
    const documentData=createFixedDocument(topic), artifact={document:documentData,state:{...documentData.initialState}};
    const card=createInteractiveCard({artifactId:topic,title:documentData.title,status:'available'}, {load:async()=>artifact,save:async(_id,state)=>{artifact.state=state;}});
    document.querySelector('#gallery').append(card);card.querySelector('button').click();
  }
  </script></html>`;
  await mkdir(path.join(root,'dist'),{recursive:true});
  const output=path.join(root,'dist','interactive-components-preview.html');
  await writeFile(output,html);
  return output;
}
module.exports={createPreview};
if(require.main===module)createPreview().then(console.log).catch(error=>{console.error(error);process.exitCode=1;});
