param([Parameter(Mandatory=$true)][string]$NsisDir)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'executable-integrity.ps1')
$root=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$NsisDir=(Resolve-Path -LiteralPath $NsisDir).Path
$compiler=Join-Path $root 'desktop/src-tauri/target/.tauri/NSIS/makensis.exe'
$product='Reed Dependency Acceptance'
$registry="HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$product"
if(Test-Path -LiteralPath $registry){throw 'Owned test registration already exists; inspect before retry'}
$testRoot=Join-Path $env:TEMP ('reed-dependency-upgrade-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$app=Join-Path $testRoot 'app'
$checks=[Collections.Generic.List[string]]::new()
function Compile-TestInstaller($source,$version,$name) {
    $text=[IO.File]::ReadAllText((Join-Path $NsisDir $source))
    $text=$text.Replace('!define PRODUCTNAME "Reed"',"!define PRODUCTNAME `"$product`"")
    $text=$text.Replace('!define MANUFACTURER "reed"','!define MANUFACTURER "reed-acceptance"')
    $text=$text.Replace('!define BUNDLEID "app.reed.desktop"','!define BUNDLEID "app.reed.dependency.acceptance"')
    $text=$text.Replace('!define VERSION "0.2.2"',"!define VERSION `"$version`"")
    $text=$text.Replace('!define VERSIONWITHBUILD "0.2.2.0"',"!define VERSIONWITHBUILD `"$version.0`"")
    $setup=Join-Path $testRoot "$name.exe"
    $text=$text.Replace('!define OUTFILE "nsis-output.exe"',"!define OUTFILE `"$setup`"")
    if($text -match '!define PRODUCTNAME "Reed"' -or $text -notmatch 'app.reed.dependency.acceptance'){throw 'Installer identity was not isolated'}
    $script=Join-Path $NsisDir "$name.nsi"
    [IO.File]::WriteAllText($script,$text.TrimStart([char]0xfeff),[Text.UTF8Encoding]::new($false))
    Push-Location $NsisDir
    try {& $compiler /INPUTCHARSET UTF8 $script *> (Join-Path $testRoot "$name-build.log");if($LASTEXITCODE -ne 0){throw "Test installer compilation failed: $testRoot"}}
    finally {Pop-Location}
    Set-ReedExecutableIntegrity -Path $setup
    return $setup
}
function Install-Test($setup,$update=$false) {
    $args=if($update){"/S /NS /UPDATE /D=$app"}else{"/S /NS /D=$app"}
    $watch=[Diagnostics.Stopwatch]::StartNew()
    $process=Start-Process -FilePath $setup -ArgumentList $args -WindowStyle Hidden -Wait -PassThru
    if($process.ExitCode -ne 0){throw "Test install failed $($process.ExitCode)"}
    $watch.Stop();return $watch.ElapsedMilliseconds
}
$old=Compile-TestInstaller 'installer.nsi' '0.2.1' 'deps-old'
$new=Compile-TestInstaller 'installer-reuse.nsi' '0.2.2' 'deps-new'
$firstMs=Install-Test $old
$deps=Join-Path $app 'agent/node_modules'
$probe=Get-ChildItem -LiteralPath $deps -Filter '*.js' -Recurse -File | Select-Object -First 1
if(-not $probe){throw 'Missing installed dependency probe'}
$original=[IO.File]::ReadAllBytes($probe.FullName)
$marker=[datetime]'2001-01-01T00:00:00Z'
[IO.File]::SetLastWriteTimeUtc($probe.FullName,$marker)
$upgradeMs=Install-Test $new
if([IO.File]::GetLastWriteTimeUtc($probe.FullName) -ne $marker){throw 'Unchanged dependency was rewritten during upgrade'}
if((Get-ItemProperty -LiteralPath $registry).DisplayVersion -ne '0.2.2'){throw 'Upgrade registration not updated'}
$checks.Add('0.2.1 to 0.2.2 normal setup preserves dependency file timestamp while updating registration')
[IO.File]::WriteAllText($probe.FullName,'corrupted dependency')
$obsolete=Join-Path $deps 'obsolete-reed-test.js';[IO.File]::WriteAllText($obsolete,'obsolete')
$repairMs=Install-Test $new $true
if((Get-FileHash -LiteralPath $probe.FullName).Hash -ne ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($original))).Replace('-','')){throw 'Corrupt dependency was not repaired'}
if(Test-Path -LiteralPath $obsolete){throw 'Obsolete dependency remains'}
$checks.Add('Same-version repair replaces corrupted content and removes obsolete dependencies')
Remove-Item -LiteralPath $probe.FullName
$missingMs=Install-Test $new $true
if(-not (Test-Path -LiteralPath $probe.FullName)){throw 'Missing dependency was not restored'}
$checks.Add('Missing dependency triggers restoration')
$uninstaller=Join-Path $app 'uninstall.exe'
$process=Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
if($process.ExitCode -ne 0){throw 'Owned test uninstall failed'}
$deadline=(Get-Date).AddSeconds(30)
while((Test-Path -LiteralPath (Join-Path $app 'Reed.exe')) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 200}
if((Test-Path -LiteralPath $registry) -or (Test-Path -LiteralPath $deps)){throw 'Owned test uninstall did not clean registration/dependencies'}
$checks.Add('Real uninstall removes dependencies and owned test registration')
$report=@{checks=$checks.ToArray();testRoot=$testRoot;firstMs=$firstMs;upgradeMs=$upgradeMs;repairMs=$repairMs;missingMs=$missingMs;basis='Unique product/registry identity, synthetic 0.2.1 baseline generated from the standard template; no production installation touched'}
$report | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $root 'dist/patch-0.2.2/dependency-upgrade-report.json') -Encoding utf8
$report | ConvertTo-Json -Depth 5
