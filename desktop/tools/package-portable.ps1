param([string]$Output = "")
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'executable-integrity.ps1')
$desktopDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$projectDir = Join-Path $desktopDir 'src-tauri'
$agentDir = Join-Path $desktopDir 'agent'
if (-not (Test-Path (Join-Path $agentDir 'node_modules'))) {
    throw 'Install Agent dependencies first: cd desktop/agent; npm ci'
}
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = & $nodeExe -p 'process.versions.node'
$parts = $nodeVersion.Split('.')
if ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 19)) {
    throw "Node.js 22.19+ is required; found $nodeVersion"
}
if (-not $Output) { $Output = Join-Path $desktopDir 'dist-portable' }
$Output = [IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $Output) { $Output = "$Output-$(Get-Date -Format yyyyMMdd-HHmmss)" }
New-Item -ItemType Directory -Force -Path $Output | Out-Null
# Staged files inherit the build directory's mandatory label; a Low-integrity
# Reed.exe cannot write AppData at all, so repair the output before writing into it.
Set-ReedOutputIntegrity -Path $Output
$env:RUSTUP_TOOLCHAIN = 'stable'
$targetDir = if ($env:CARGO_TARGET_DIR) { [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR) } else { Join-Path $projectDir 'target' }
Push-Location $projectDir
try { & cargo build --release; if ($LASTEXITCODE -ne 0) { throw 'Cargo release build failed' } }
finally { Pop-Location }
Copy-Item -LiteralPath (Join-Path $targetDir 'release\summon-desktop.exe') -Destination (Join-Path $Output 'Reed.exe') -Force
New-Item -ItemType Directory -Force -Path (Join-Path $Output 'runtime'), (Join-Path $Output 'agent') | Out-Null
Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $Output 'runtime\node.exe') -Force
# Copy the agent runtime by pattern so a newly added module cannot be forgotten;
# test files stay out of the package.
Get-ChildItem -LiteralPath $agentDir -Filter '*.mjs' -File | Where-Object { $_.Name -notlike '*.test.mjs' } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Output "agent\$($_.Name)") -Force
}
Copy-Item -LiteralPath (Join-Path $agentDir 'skills') -Destination (Join-Path $Output 'agent\skills') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $agentDir 'package.json') -Destination (Join-Path $Output 'agent\package.json') -Force
# Copy dependency trees without mirroring/deleting destination files.
& robocopy.exe (Join-Path $agentDir 'node_modules') (Join-Path $Output 'agent\node_modules') /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
if ($LASTEXITCODE -gt 7) { throw "Agent dependency copy failed (robocopy $LASTEXITCODE)" }
Copy-Item -LiteralPath (Join-Path $desktopDir 'PI-DESKTOP-LICENSE') -Destination (Join-Path $Output 'PI-DESKTOP-LICENSE') -Force
Copy-Item -LiteralPath (Join-Path $desktopDir 'README.md') -Destination (Join-Path $Output 'README.md') -Force
foreach ($notice in @('LICENSE','NOTICE.md')) {
    Copy-Item -LiteralPath (Join-Path $desktopDir "../$notice") -Destination (Join-Path $Output $notice) -Force
}
Copy-Item -LiteralPath (Join-Path $desktopDir 'web/vendor/MARKED-LICENSE') -Destination (Join-Path $Output 'MARKED-LICENSE') -Force
Set-ReedExecutableIntegrity -Path (Join-Path $Output 'Reed.exe')
Set-ReedExecutableIntegrity -Path (Join-Path $Output 'runtime/node.exe')
Assert-ReedStandardIntegrity -Path (Join-Path $Output 'Reed.exe')
Assert-ReedStandardIntegrity -Path (Join-Path $Output 'runtime/node.exe')
Write-Host "Portable build: $Output"
