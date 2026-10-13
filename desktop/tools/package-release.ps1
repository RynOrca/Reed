# 为「关于 → 检查更新」准备发布产物：签名安装包 + latest.json。
#
# 为什么需要这一步：Tauri updater 在安装前会用应用内置的公钥校验更新包签名。
# 没有签名（或签名对不上公钥）时应用会拒绝安装。所以每次发版都要：
#   1. 用私钥签安装包；
#   2. 生成 latest.json（含版本、平台、URL、签名字符串）；
#   3. 把 latest.json 一并作为 release 资源上传——endpoint 指向 releases/latest/download/latest.json。
#
# 私钥绝不入库。默认从环境变量 TAURI_SIGNING_PRIVATE_KEY 读取；
# 也可以显式传 -PrivateKeyPath（该路径应保持在仓库外或被 .gitignore 覆盖）。
#
# 用法：
#   $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content C:\keys\reed.key -Raw
#   pwsh -File desktop/tools/package-release.ps1 -BundleDir dist/Reed-release
#
# 未签名时脚本会**明确报错**而不是生成一个装不上的 latest.json；
# 开发期确实想跳过，用 -SkipSignature（产物会写明未签名，updater 不会接受）。

param(
  [Parameter(Mandatory = $true)][string]$BundleDir,
  [string]$InstallerName = "",
  [string]$PrivateKeyPath = "",
  [string]$Repository = "RynOrca/Reed",
  [switch]$SkipSignature
)
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$version = (Get-Content -LiteralPath (Join-Path $root 'desktop/src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "tauri.conf.json 里的版本号不是 major.minor.patch：$version" }

$dir = (Resolve-Path -LiteralPath $BundleDir).Path
if (-not $InstallerName) { $InstallerName = "Reed-$version-setup.exe" }
$installer = Join-Path $dir $InstallerName
if (-not (Test-Path -LiteralPath $installer)) { throw "找不到安装包：$installer" }

# ─── 签名 ───
$signature = ""
if ($SkipSignature) {
  Write-Warning "已跳过签名：latest.json 会标记为未签名，Tauri updater 将拒绝安装这个包。"
} else {
  $key = ""
  if ($PrivateKeyPath) {
    if (-not (Test-Path -LiteralPath $PrivateKeyPath)) { throw "找不到私钥文件：$PrivateKeyPath" }
    $key = Get-Content -LiteralPath $PrivateKeyPath -Raw
  } elseif ($env:TAURI_SIGNING_PRIVATE_KEY) {
    $key = $env:TAURI_SIGNING_PRIVATE_KEY
  } else {
    throw @"
没有可用的私钥。请任选一种：
  1) 设置环境变量（推荐，私钥不落盘到仓库）：
       `$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content <私钥路径> -Raw
  2) 显式传入路径：-PrivateKeyPath <私钥路径>
  3) 如果只想走「检测 + 跳转下载页」而不做一键安装，用 -SkipSignature。
没有密钥时无法签名，因而无法支持应用内一键安装。
"@
  }

  # 优先用 tauri signer；它需要私钥内容通过环境变量传递，因此临时赋值。
  $tauri = Join-Path $root 'node_modules/.bin/tauri.cmd'
  if (-not (Test-Path -LiteralPath $tauri)) { throw '缺少 tauri CLI，请先 npm ci。' }
  $previous = $env:TAURI_SIGNING_PRIVATE_KEY
  $env:TAURI_SIGNING_PRIVATE_KEY = $key
  try {
    $output = & $tauri signer sign $installer 2>&1
    if ($LASTEXITCODE -ne 0) { throw "签名失败：$output" }
  } finally {
    if ($null -eq $previous) { Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue } else { $env:TAURI_SIGNING_PRIVATE_KEY = $previous }
  }

  # tauri 会把签名写到 <文件>.sig；也兼容直接把签名打印到 stdout 的情况。
  $sigPath = "$installer.sig"
  if (Test-Path -LiteralPath $sigPath) {
    $signature = (Get-Content -LiteralPath $sigPath -Raw).Trim()
  } else {
    $signature = ($output | Out-String).Trim()
  }
  if (-not $signature) { throw '签名命令没有产生签名内容。' }
  Set-Content -LiteralPath $sigPath -Value $signature -NoNewline -Encoding utf8
  Write-Host "已签名：$InstallerName"
}

# ─── latest.json ───
$url = "https://github.com/$Repository/releases/latest/download/$InstallerName"
$manifest = [ordered]@{
  version   = $version
  notes     = "Reed 一苇 $version"
  pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = $signature
      url       = $url
    }
  }
}
$manifestPath = Join-Path $dir 'latest.json'
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))

# ─── 校验和 ───
$checksums = foreach ($file in Get-ChildItem -LiteralPath $dir -File | Where-Object { $_.Extension -in @('.exe', '.zip') }) {
  "$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLower())  $($file.Name)"
}
[IO.File]::WriteAllLines((Join-Path $dir 'SHA256SUMS.txt'), $checksums, [Text.UTF8Encoding]::new($false))

Write-Host ""
Write-Host "发布产物：$dir"
Write-Host "  安装包  : $InstallerName"
Write-Host "  清单    : latest.json   （必须作为 release 资源上传）"
Write-Host "  校验和  : SHA256SUMS.txt"
Write-Host ""
Write-Host "发布步骤："
Write-Host "  1. 把 latest.json 与 $InstallerName 上传到同一个 release"
Write-Host "  2. 该 release 必须是 latest（endpoint 指向 releases/latest/download/latest.json）"
Write-Host "  3. 应用内置公钥必须与本次签名私钥配对"
if ($SkipSignature) { Write-Host "  注意：本次未签名，一键安装不可用。" }
