# Build workspaces can stamp executable files with a Low mandatory label.
# Windows then starts those images at Low integrity, blocking normal AppData writes.
function Set-ReedExecutableIntegrity {
    param([Parameter(Mandatory = $true)][string]$Path)
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($item.PSIsContainer -or $item.Extension -ne '.exe') { throw "Expected packaged executable: $Path" }
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    # WRITE_OWNER is needed to set the label; generated files may grant only Modify.
    & icacls.exe $item.FullName /grant:r "${owner}:(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Cannot restore build owner control: $Path" }
    & icacls.exe $item.FullName /setintegritylevel M | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Cannot set standard user integrity: $Path" }
}

# Anything written under a Low-integrity build directory inherits that label, and a
# Low-integrity Reed.exe can neither install nor write %APPDATA%. Every packaging
# step that stages files must therefore repair its own output: the owner's ACE has
# to be granted first, because a directory without an explicit ACE for its owner
# refuses the label change outright.
function Set-ReedOutputIntegrity {
    param([Parameter(Mandatory = $true)][string]$Path)
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    if ($item.PSIsContainer) {
        & icacls.exe $item.FullName /grant:r "${owner}:(OI)(CI)F" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Cannot restore build owner control: $Path" }
        & icacls.exe $item.FullName /setintegritylevel '(OI)(CI)M' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Cannot set standard user integrity: $Path" }
        & icacls.exe $item.FullName /setintegritylevel M /T /C /Q | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Cannot set staged file integrity: $Path" }
        return
    }
    & icacls.exe $item.FullName /grant:r "${owner}:(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Cannot restore build owner control: $Path" }
    & icacls.exe $item.FullName /setintegritylevel M | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Cannot set standard user integrity: $Path" }
}

# Packaging must fail loudly instead of shipping a package that only breaks on the
# user's machine, which is exactly how the Low-label installer reached the user.
function Assert-ReedStandardIntegrity {
    param([Parameter(Mandatory = $true)][string]$Path)
    $label = (& icacls.exe $Path) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "Cannot read the integrity label: $Path" }
    if ($label -match 'Mandatory Label\\Low ') { throw "Low integrity survives packaging: $Path" }
}
