// Modify only the generated NSIS file. Fail closed when Tauri changes its layout.
const fs=require('node:fs');
const path=require('node:path');
const {manifest}=require('./dependency-manifest.cjs');
const [source,portable,output]=process.argv.slice(2);
const script=fs.readFileSync(source,'utf8').replace(/^\ufeff/,'');
if(!script.includes('; Copy resources')||!script.includes('; In update mode, always proceeds without uninstalling')||!script.includes('!define OUTFILE "nsis-output.exe"'))throw Error('Unsupported Tauri NSIS layout');
const expected=manifest(path.join(portable,'agent','node_modules'));
const manifestPath=path.join(path.dirname(output),'dependencies.json');
fs.writeFileSync(manifestPath,JSON.stringify(expected));
const quote=value=>path.resolve(value).replaceAll('$','$$').replaceAll('"','$\\"');
let fileCount=0;
const dependencies=[];
let result=script.replace(/^\s*(?:CreateDirectory "\$INSTDIR\\agent\\node_modules(?:\\[^"]*)?"|File \/a "\/oname=agent\\node_modules\\[^\r\n]+)\r?$/gm,line=>{
  dependencies.push(line.trim());if(line.trim().startsWith('File '))fileCount++;return '';
});
if(fileCount!==expected.files.length||fileCount===0)throw Error(`Dependency resource mismatch ${fileCount}/${expected.files.length}`);
const reuse=`
  ; Reuse only a byte-for-byte complete dependency tree. Older packages need no marker.
  StrCpy $ReedReuseDeps 0
  InitPluginsDir
  File /oname=$PLUGINSDIR\\reed-dependencies.json "${quote(manifestPath)}"
  File /oname=$PLUGINSDIR\\reed-verify.cjs "${quote(path.join(__dirname,'dependency-manifest.cjs'))}"
  IfFileExists "$INSTDIR\\runtime\\node.exe" 0 reed_deps_checked
    nsExec::ExecToStack /TIMEOUT=120000 '\"$INSTDIR\\runtime\\node.exe\" \"$PLUGINSDIR\\reed-verify.cjs\" verify \"$INSTDIR\\agent\\node_modules\" \"$PLUGINSDIR\\reed-dependencies.json\"'
    Pop $0
    Pop $1
    \${If} $0 == 0
      StrCpy $ReedReuseDeps 1
      DetailPrint "Dependencies verified; preserving node_modules"
    \${EndIf}
  reed_deps_checked:
  \${If} $ReedReuseDeps != 1
    DetailPrint "Installing or repairing dependencies"
    RMDir /r "$INSTDIR\\agent\\node_modules"
${dependencies.map(line=>'    '+line).join('\n')}
  \${EndIf}
`;
result=result.replace('Section Install','Var ReedReuseDeps\nSection Install');
// This marker is after CheckIfAppIsRunning, so a running installation is stopped first.
result=result.replace('  ; Copy resources',reuse+'\n  ; Copy resources');
// Upgrades proceed in-place by default, including passive/silent invocation. Uninstall is unchanged.
result=result.replace('  ; In update mode, always proceeds without uninstalling','  ${If} $R0 = 1\n    Goto reinst_done\n  ${EndIf}\n\n  ; In update mode, always proceeds without uninstalling');
const anchor='  Pop $R0\n  ; Reinstalling the same version';
const normalized=result.replaceAll('\r\n','\n');
if(!normalized.includes(anchor))throw Error('Unsupported version selection layout');
result=normalized.replace(anchor,'  Pop $R0\n  ${If} $R0 = 1\n    Abort ; Skip maintenance page: upgrade in place.\n  ${EndIf}\n  ; Reinstalling the same version');
fs.writeFileSync(output,result);
console.log(`Prepared dependency reuse for ${fileCount} files`);
