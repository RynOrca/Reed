const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {manifest,verify}=require('./dependency-manifest.cjs');
test('reuse requires complete matching bytes, not timestamps or package version',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'reed-deps-test-'));
  try{
    const file=path.join(root,'module.js');fs.writeFileSync(file,'original');const expected=manifest(root);
    assert.equal(verify(root,expected),true);const stamp=fs.statSync(file).mtime;
    fs.writeFileSync(file,'modified');fs.utimesSync(file,stamp,stamp);assert.equal(verify(root,expected),false);
    fs.writeFileSync(file,'original');fs.writeFileSync(path.join(root,'obsolete.js'),'old');assert.equal(verify(root,expected),false);
    fs.unlinkSync(path.join(root,'obsolete.js'));fs.unlinkSync(file);assert.equal(verify(root,expected),false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
