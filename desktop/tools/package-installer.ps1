param([string]$Output = "", [switch]$Portable)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'executable-integrity.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$appVersion = (Get-Content -LiteralPath (Join-Path $root 'desktop/src-tauri/tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($appVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'A numeric major.minor.patch application version is required.' }
$tauri = Join-Path $root 'node_modules/.bin/tauri.cmd'
if (-not (Test-Path -LiteralPath $tauri)) { throw 'Run npm ci in the repository first.' }
if (-not $Output) { $Output = Join-Path $root 'dist/Reed-release' }
$Output = [IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $Output) { $Output = "$Output-$(Get-Date -Format yyyyMMdd-HHmmss)" }
New-Item -ItemType Directory -Path $Output | Out-Null
# Tauri's bundler writes a fresh portable stage into this directory, and every file
# it creates inherits the directory's mandatory label. Repair it first, otherwise a
# Low-integrity installer cannot even write its own temporary files.
Set-ReedOutputIntegrity -Path $Output
$portable = Join-Path $Output 'Reed-portable'
& (Join-Path $PSScriptRoot 'package-portable.ps1') -Output $portable
if ($LASTEXITCODE -gt 7) { throw 'Portable staging failed' }
$resources = @{}
foreach ($folder in @('agent','runtime')) { $resources[(Join-Path $portable "$folder/")] = "$folder/" }
foreach ($file in @('LICENSE','NOTICE.md','PI-DESKTOP-LICENSE','MARKED-LICENSE','KATEX-LICENSE')) { $resources[(Join-Path $portable $file)] = $file }
$config = @{
    bundle = @{
        active = $true; useLocalToolsDir = $true; targets = @('nsis'); icon = @('icons/icon.ico')
        shortDescription = 'Reed 苇 — 一苇以航，轻渡学海。'
        # 有签名私钥时才生成更新产物：否则 tauri 会以缺少私钥直接失败，
        # 而签名是「关于 → 检查更新」内置安装的硬前提（应用会用公钥校验安装包）。
        createUpdaterArtifacts = [bool]$env:TAURI_SIGNING_PRIVATE_KEY
        resources = $resources
        windows = @{
            nsis = @{ installMode = 'currentUser'; languages = @('SimpChinese','English'); displayLanguageSelector = $false; installerIcon = 'icons/icon.ico'; compression = 'lzma' }
            webviewInstallMode = @{ type = 'downloadBootstrapper' }
        }
    }
}
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    Write-Warning '未设置 TAURI_SIGNING_PRIVATE_KEY：本次不生成更新产物，安装包无法用于应用内一键更新。正式发版请先设置私钥。'
}
$configPath = Join-Path $Output 'installer-config.json'
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
$env:RUSTUP_TOOLCHAIN = 'stable'
$target = if ($env:CARGO_TARGET_DIR) { [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR) } else { Join-Path $root 'desktop/src-tauri/target' }
# Downloaded compilers can inherit the workspace's Low integrity label and fail
# to map files in the normal user TEMP directory. Repair only our local tools.
function Repair-ReedNsisIntegrity {
    $found = $false
    foreach ($relative in @('.tauri/NSIS/makensis.exe', '.tauri/NSIS/Bin/makensis.exe')) {
        $compiler = Join-Path $target $relative
        if (Test-Path -LiteralPath $compiler) { Set-ReedExecutableIntegrity -Path $compiler; $found = $true }
    }
    return $found
}
$hadNsis = Repair-ReedNsisIntegrity
Push-Location (Join-Path $root 'desktop')
try {
    & $tauri build --bundles nsis --config $configPath
    if ($LASTEXITCODE -ne 0 -and -not $hadNsis -and (Repair-ReedNsisIntegrity)) {
        # The first run may have downloaded NSIS after the preflight repair.
        & $tauri build --bundles nsis --config $configPath
    }
    if ($LASTEXITCODE -ne 0 -and -not $env:TAURI_SIGNING_PRIVATE_KEY) {
        # 已配置更新公钥时，tauri 会因为缺少私钥而拒绝构建。
        # 这里退一步只构建应用（不产出更新包），让本地开发/验收无需持有私钥。
        # 发布产物仍然必须带私钥构建，否则没有签名，应用内一键更新不可用。
        Write-Warning '搭建应用本体：无签名私钥，跳过更新产物（发布产物必须带私钥构建）。'
        $noArtifacts = @{ bundle = @{ createUpdaterArtifacts = $false } }
        $noArtifactsPath = Join-Path $Output 'installer-no-artifacts.json'
        [IO.File]::WriteAllText($noArtifactsPath, ($noArtifacts | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
        & $tauri build --bundles nsis --config $configPath --config $noArtifactsPath
    }
    if ($LASTEXITCODE -ne 0) { throw 'Installer build failed' }
}
finally { Pop-Location }
$nsisDir = Join-Path $target 'release/nsis/x64'
$optimized = Join-Path $nsisDir 'installer-reuse.nsi'
& node (Join-Path $PSScriptRoot 'optimize-installer.cjs') (Join-Path $nsisDir 'installer.nsi') $portable $optimized
if ($LASTEXITCODE -ne 0) { throw 'Dependency reuse preparation failed' }
$makensis = Join-Path $target '.tauri/NSIS/makensis.exe'
Push-Location $nsisDir
try {
    & $makensis '/INPUTCHARSET' 'UTF8' $optimized
    if ($LASTEXITCODE -ne 0) { throw 'Dependency reuse installer compilation failed' }
}
finally { Pop-Location }
$installer = Get-ChildItem -LiteralPath (Join-Path $target 'release/bundle/nsis') -Filter '*setup.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) { throw 'Installer output not found' }
$optimizedSetup=Join-Path $nsisDir 'nsis-output.exe'
if (-not (Test-Path -LiteralPath $optimizedSetup)) { throw 'Optimized NSIS output not found' }
Copy-Item -LiteralPath $optimizedSetup -Destination $installer.FullName -Force
# The generated installer changed after bundling; never keep its old updater signature.
if ($env:TAURI_SIGNING_PRIVATE_KEY) {
    & $tauri signer sign $installer.FullName
    if ($LASTEXITCODE -ne 0) { throw 'Optimized installer signing failed' }
}
$installerPath = Join-Path $Output "Reed-$appVersion-setup.exe"
Copy-Item -LiteralPath $installer.FullName -Destination $installerPath
Set-ReedExecutableIntegrity -Path $installerPath
Assert-ReedStandardIntegrity -Path $installerPath
# 暂存目录始终保留：验收脚本直接用它启动，不必等 ZIP。
Set-ReedOutputIntegrity -Path $portable
$version = @{ product = 'Reed'; version = $appVersion; sourceCommit = (& git -C $root rev-parse HEAD); dataDirectory = '%APPDATA%\Reed' }
[IO.File]::WriteAllText((Join-Path $portable 'VERSION.json'), ($version | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
# 便携 ZIP 由 -Portable 显式开启：压缩上万个文件是本流程最慢的一步，
# 而安装包已包含同一份内容，日常只发 setup 即可。
if ($Portable) {
    Compress-Archive -Path (Join-Path $portable '*') -DestinationPath (Join-Path $Output "Reed-$appVersion-portable.zip")
    Set-ReedOutputIntegrity -Path (Join-Path $Output "Reed-$appVersion-portable.zip")
    Assert-ReedStandardIntegrity -Path (Join-Path $Output "Reed-$appVersion-portable.zip")
} else {
    Write-Host '已跳过便携 ZIP（需要时加 -Portable）；暂存目录仍可用于验收。'
}
$checksums = foreach ($file in Get-ChildItem -LiteralPath $Output -File | Where-Object { $_.Extension -in @('.exe','.zip') }) {
    "$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLower())  $($file.Name)"
}
[IO.File]::WriteAllLines((Join-Path $Output 'SHA256SUMS.txt'), $checksums, [Text.UTF8Encoding]::new($false))
Write-Host "Release artifacts: $Output"
