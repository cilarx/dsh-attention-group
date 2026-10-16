<#
.SYNOPSIS
  Sync this plugin's source into the DSH profile so the live loader can import it.

.DESCRIPTION
  Why this exists: DSH's in-box packages (`@deepseek-ai/*`) resolve from
  `~/.dsh/profiles/node_modules`, and Node resolves imports from a module's REAL
  path. A `link:` dependency or a directory junction keeps the real path outside
  the profile, so the loader fails with:

      attention-group (dsh-attention-group): failed to import
      ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'

  Both were measured on 2026-10-16. Installing a real copy inside the profile
  resolves it, and editing this source tree then re-running this script keeps the
  copy current without a DSH restart (the profile's HMR service picks the change
  up).

  This is a development convenience only. A published install lands in the
  profile by itself, so end users never need it.

.EXAMPLE
  pwsh -File tools/sync-plugin.ps1
#>
[CmdletBinding()]
param(
  # Source tree of the plugin. Defaults to this script's parent directory.
  [string] $Source,
  # Profile to sync into. Defaults to the desktop profile under the DSH home.
  [string] $Profile = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  # Copy and verify only; do not print the file list.
  [switch] $Quiet
)

$ErrorActionPreference = 'Stop'

if (-not $Source) { $Source = Split-Path -Parent $PSScriptRoot }
$Source = (Resolve-Path -LiteralPath $Source).Path
$target = Join-Path $Profile 'node_modules\dsh-attention-group'

if (-not (Test-Path -LiteralPath $Profile)) { throw "profile not found: $Profile" }
$manifest = Join-Path $Source 'package.json'
if (-not (Test-Path -LiteralPath $manifest)) { throw "not a plugin package (no package.json): $Source" }

# A link or junction here would defeat the whole point: replace it with a real
# directory. Only the link itself is removed, never the directory it points at.
if (Test-Path -LiteralPath $target) {
  $existing = Get-Item -LiteralPath $target -Force
  if ($existing.LinkType) {
    $existing.Delete()
    Write-Host "removed $($existing.LinkType) at $target (link only, target untouched)"
  } else {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
}

New-Item -ItemType Directory -Force -Path $target | Out-Null

# Only what the loader reads. Nothing else belongs in the profile.
$files = @('package.json', 'cordis.patch.yml')
foreach ($file in $files) {
  $from = Join-Path $Source $file
  if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $target -Force }
}
Copy-Item -LiteralPath (Join-Path $Source 'src') -Destination $target -Recurse -Force

$copied = Get-ChildItem -LiteralPath $target -Recurse -File
if (-not $Quiet) {
  Write-Host "synced $($copied.Count) file(s) -> $target"
  foreach ($file in $copied) {
    Write-Host ("  {0,-24} {1,7:N0} B  {2}" -f $file.Name, $file.Length, $file.LastWriteTime.ToString('HH:mm:ss'))
  }
}

# Verify the copy actually imports. A green sync that cannot load is worthless.
$node = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node = 'node' }
$entry = Join-Path $target 'src\index.js'
$url = 'file:///' + ($entry -replace '\\', '/')
$check = & $node --input-type=module -e "import('$url').then(m => console.log('OK ' + Object.keys(m).sort().join(','))).catch(e => { console.log('FAIL ' + e.code + ' ' + String(e.message).split('\n')[0]); process.exit(1) })"
Write-Host "import check: $check"
if ($LASTEXITCODE -ne 0) { throw "the synced copy does not import: $check" }
