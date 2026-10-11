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
