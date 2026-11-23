# Creates a desktop shortcut to the home launcher (make launcher-shortcut; docs/13,
# "La forma más fácil: doble clic"). Only the owner runs it: nothing else calls it.
param([Parameter(Mandatory = $true)][string]$Target)
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path -LiteralPath $Target).Path
$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop "Neque's Realm - Servidor.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = Split-Path -Parent $exe
$shortcut.Description = "Starts the Neque's Realm game server on this PC"
$shortcut.Save()
Write-Output "Shortcut created: $link"
