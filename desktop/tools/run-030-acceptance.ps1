# 打包后统一隔离验收：原生/桌面/学习块验收 + 学习块布局溢出回归，各自独立进程与端口。
# 用法：desktop\tools\run-030-acceptance.ps1 -Package <便携包目录> [-Logs <日志目录>]
param(
    [string]$Package = "",
    [string]$Logs = ""
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if (-not $Package) { $Package = Join-Path $root 'dist/reed-030-retry-fix-20261015-203817/Reed-portable' }
if (-not (Test-Path (Join-Path $Package 'Reed.exe'))) { throw "Portable package missing: $Package" }
if (-not $Logs) { $Logs = Join-Path $root 'dist/reed-030-retry-fix' }
New-Item -ItemType Directory -Force -Path $Logs | Out-Null
$env:SUMMON_PLAYWRIGHT_PATH = 'C:\Users\Orca\AppData\Local\Programs\Python\Python314\Lib\site-packages\playwright\driver\package'
$env:SUMMON_EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
$env:SUMMON_TEST_PACKAGE = $Package
$failures = @()
$suites = @(
    @{ Name = 'desktop'; Script = 'desktop/tools/desktop-acceptance.cjs' },
    @{ Name = 'canvas-native'; Script = 'desktop/tools/canvas-native-acceptance.cjs' },
    @{ Name = 'canvas-entry'; Script = 'desktop/tools/canvas-entry-native-acceptance.cjs' },
    @{ Name = 'learning'; Script = 'desktop/tools/learning-workspace-acceptance.cjs' },
    @{ Name = 'learning-native'; Script = 'docs/check-032-learning-native.cjs' },
    @{ Name = 'learning-blocks-ui'; Script = 'docs/check-learning-blocks-ui.cjs' },
    # 学习块布局：380～1000px 五档都不能横向溢出（公式不许压到相邻卡片）。
    @{ Name = 'learning-overflow'; Script = 'docs/check-learning-overflow.mjs' },
    @{ Name = 'learning-palette'; Script = 'docs/check-learning-palette.mjs' }
)
foreach ($suite in $suites) {
    $log = Join-Path $Logs ("{0}.log" -f $suite.Name)
    Write-Host ("=== {0} ===" -f $suite.Name)
    & node (Join-Path $root $suite.Script) *>&1 | Tee-Object -FilePath $log | Select-Object -Last 4
    if ($LASTEXITCODE -ne 0) { $failures += $suite.Name; Write-Warning ("{0} failed with exit {1}" -f $suite.Name, $LASTEXITCODE) }
}
if ($failures.Count) { throw ("Failed suites: " + ($failures -join ', ')) }
Write-Host 'ALL NATIVE AND LAYOUT SUITES PASSED'
