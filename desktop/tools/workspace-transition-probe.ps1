param([int]$OwnerPid,[string]$Output,[int]$Duration=1800)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot 'workspace-transition-probe.cs') -ReferencedAssemblies System.Drawing
$samples=[WorkspaceTransitionProbe]::Run($OwnerPid,$Output,$Duration)
[IO.File]::WriteAllText((Join-Path $Output 'samples.json'),(ConvertTo-Json -InputObject @($samples) -Depth 4),[Text.UTF8Encoding]::new($false))
