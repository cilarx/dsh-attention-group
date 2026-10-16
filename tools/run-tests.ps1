<#
.SYNOPSIS
  Run every test suite and print just the summary.

.DESCRIPTION
  Why this exists as a script and not a one-liner: `node --test` spawns a child
  process per file, and piping its output through PowerShell (`| Select-String`)
  can keep the pipe handle open long after the run has finished.

  Measured 2026-10-16: the same five suites took **3.5 s** of real work but
  **over 120 s** of wall time when piped, which looks exactly like a hang and
  invites debugging a problem that is not there. Redirecting to a file first
  avoids it entirely, so this script does that.

  It also syncs first, because the suites load the INSTALLED profile copy rather
  than the source tree — testing without syncing tests the previous edit.

.EXAMPLE
  pwsh -File tools/run-tests.ps1
#>
[CmdletBinding()]
param(
  # Skip the sync step (useful when only test files changed).
  [switch] $NoSync
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot

# Syncing needs a profile to sync INTO. A fresh clone has none, and failing there
# would make the suite look broken when it is not: the tests fall back to this
# source tree, and the committed dev shim does the resolution (see
# test/support/entry.mjs). So a missing profile is a note, not an error.
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$canSync = Test-Path -LiteralPath $profileDir

if (-not $NoSync) {
  if ($canSync) {
    & (Join-Path $PSScriptRoot 'sync-plugin.ps1') -Quiet | Out-Null
  } else {
    Write-Host "note: no profile at $profileDir - skipping the sync and testing this source tree"
    Write-Host "      (install DSH, or run tools/sync-plugin.ps1, to test the installed copy instead)"
  }
}

$node = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node = 'node' }

$files = @(
  'test/router.test.js'
  'test/tools.test.js'
  'test/panel-client.test.js'
  'test/panel-host.test.js'
  'test/sink.test.js'
  'test/digest.test.js'
  'test/relay.test.js'
  'test/effort.test.js'
) | ForEach-Object { Join-Path $root $_ } | Where-Object { Test-Path -LiteralPath $_ }

$out = Join-Path $env:TEMP 'attention-group-tests.txt'
$watch = [Diagnostics.Stopwatch]::StartNew()
& $node --test @files *> $out
$code = $LASTEXITCODE
$watch.Stop()

Get-Content -LiteralPath $out | Where-Object {
  # The reporter's shape depends on whether stdout is a TTY: `ℹ tests 73` when
  # redirected, `# tests 73` under TAP. Match both rather than guess which.
  $_ -match '^\s*(✔|✖)' -or
  $_ -match '^\s*(ok|not ok) \d+ -' -or
  $_ -match '^\s*(ℹ|#) (tests|pass|fail|cancelled|skipped|todo)' -or
  $_ -match 'AssertionError|Error:'
} | ForEach-Object { $_ }

Write-Host ("{0} suite(s) in {1:N1}s (full log: {2})" -f $files.Count, $watch.Elapsed.TotalSeconds, $out)
exit $code
