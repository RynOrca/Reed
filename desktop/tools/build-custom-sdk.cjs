const fs=require('node:fs/promises'),path=require('node:path');
async function bundle(){const root=path.resolve(__dirname,'../web');const texts=await Promise.all(['custom-contract.mjs','custom-frame-source.mjs'].map(f=>fs.readFile(path.join(root,f),'utf8')));const script=texts.join('\n').replace(/^export /gm,'')+'\ncustomFrameBoot();\n';await fs.writeFile(path.join(root,'custom-frame.js'),script);return script;}
module.exports={bundle};if(require.main===module)bundle().catch(e=>{console.error(e);process.exitCode=1;});
