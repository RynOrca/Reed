# 0.3.0 修复后统一隔离验收：按顺序运行原生/桌面验收，各自独立进程与端口。
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$package = Join-Path $root 'dist/reed-030-retry-fix-20261015-203817/Reed-portable'
if (-not (Test-Path (Join-Path $package 'Reed.exe'))) { throw "Portable package missing: $package" }
$env:SUMMON_PLAYWRIGHT_PATH = 'C:\Users\Orca\AppData\Local\Programs\Python\Python314\Lib\site-packages\playwright\driver\package'
$env:SUMMON_EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
$env:SUMMON_TEST_PACKAGE = $package
$logs = Join-Path $root 'dist/reed-030-retry-fix'
$failures = @()
$suites = @(
    @{ Name = 'desktop'; Script = 'desktop/tools/desktop-acceptance.cjs' },
    @{ Name = 'canvas-native'; Script = 'desktop/tools/canvas-native-acceptance.cjs' },
    @{ Name = 'canvas-entry'; Script = 'desktop/tools/canvas-entry-native-acceptance.cjs' },
    @{ Name = 'learning'; Script = 'desktop/tools/learning-workspace-acceptance.cjs' }
)
foreach ($suite in $suites) {
    $log = Join-Path $logs ("{0}.log" -f $suite.Name)
    Write-Host ("=== {0} ===" -f $suite.Name)
    & node (Join-Path $root $suite.Script) *>&1 | Tee-Object -FilePath $log | Select-Object -Last 6
    if ($LASTEXITCODE -ne 0) { $failures += $suite.Name; Write-Warning ("{0} failed with exit {1}" -f $suite.Name, $LASTEXITCODE) }
}
if ($failures.Count) { throw ("Failed suites: " + ($failures -join ', ')) }
Write-Host 'ALL NATIVE SUITES PASSED'
