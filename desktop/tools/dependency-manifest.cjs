const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');

function manifest(root) {
  const entries=[];
  function visit(dir) {
    for(const name of fs.readdirSync(dir).sort()) {
      const file=path.join(dir,name),stat=fs.lstatSync(file);
      if(stat.isSymbolicLink())throw Error('Dependency links cannot be reused');
      if(stat.isDirectory())visit(file);
      else if(stat.isFile())entries.push({path:path.relative(root,file).split(path.sep).join('/'),size:stat.size,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
      else throw Error('Unsupported dependency file');
    }
  }
  if(fs.lstatSync(root).isSymbolicLink())throw Error('Dependency root cannot be a link');
  visit(root);return {version:1,files:entries};
}
function verify(root,expected) {
  if(expected.version!==1||!Array.isArray(expected.files)||!expected.files.length)return false;
  const actual=manifest(root);
  return JSON.stringify(actual)===JSON.stringify(expected);
}
module.exports={manifest,verify};
if(require.main===module) {
  try {
    const [mode,root,file]=process.argv.slice(2);
    if(mode==='create')fs.writeFileSync(file,JSON.stringify(manifest(root)));
    else if(mode==='verify') {if(!verify(root,JSON.parse(fs.readFileSync(file,'utf8'))))process.exitCode=1;}
    else throw Error('Expected create or verify');
  } catch {process.exitCode=1;}
}
