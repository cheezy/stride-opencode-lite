<#
.SYNOPSIS
Step 2 of the two-step install: put the artifacts where OpenCode can find them.

.DESCRIPTION
OpenCode does NOT auto-discover skills, agents or commands from inside an
installed plugin. Registering the plugin in opencode.json (Step 1) makes the
hook layer run; it does not make any skill exist. Skipping this script is a
SILENT partial install.

Behaviour mirrors install.sh phase for phase, with the same exit codes and the
same message text, so the two cannot drift without the parity test failing. The
only deliberate differences are the script name in each message and the flag
spelling (-Force vs --force) — printing "install.sh" at a user who ran
install.ps1 would be a defect, not parity.

VERIFICATION STATUS: this script is exercised by the test suite under
PowerShell 7 (pwsh) on macOS. It has NOT been run on Windows, and not under
Windows PowerShell 5.1. See README.md.

.PARAMETER Global
Install into ~/.config/opencode instead of ./.opencode.

.PARAMETER Force
Overwrite files that are already there.
#>
[CmdletBinding()]
param(
  [switch]$Global,
  [switch]$Force,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

function Show-Usage {
  @'
install.ps1 — install stride-opencode-lite's skills, agents, commands and lib
              specs where OpenCode discovers them.

  .\install.ps1              install into .\.opencode\         (project-local)
  .\install.ps1 -Global      install into ~/.config/opencode/  (all projects)
  .\install.ps1 -Force       overwrite files that are already there
  .\install.ps1 -Help        this message

This is STEP 2 of a two-step install. Step 1 is registering the plugin in
opencode.json:

    { "plugin": ["github:cheezy/stride-opencode-lite"] }

Neither step works without the other. Step 1 alone gives you hooks and no
skills; step 2 alone gives you skills and no hooks.

-Force overwrites single files, and REPLACES each stride-opencode-lite skill
directory wholesale, so a file dropped from a skill in a later release does not
survive as a stale sibling.

Nothing here needs elevated privileges.
'@
}

if ($Help) { Show-Usage; exit 0 }

$Src = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path (Join-Path $Src 'package.json')) -or
    -not (Test-Path (Join-Path $Src 'skills'))) {
  [Console]::Error.WriteLine("install.ps1: $Src does not look like a stride-opencode-lite checkout.")
  [Console]::Error.WriteLine("Clone the repository and run this script from its root.")
  exit 1
}

# $env:USERPROFILE on Windows, $HOME elsewhere. The fallback is what the macOS
# pwsh run exercises — the Windows branch is NOT covered by any test here.
if ($Global) {
  $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
  $DestRoot = Join-Path (Join-Path $homeDir '.config') 'opencode'
} else {
  $DestRoot = Join-Path (Get-Location).Path '.opencode'
}

# Enumerated from the source, never hard-coded: a literal list goes stale the
# first time a skill is added.
function Get-Manifest {
  $out = @()
  $skillsRoot = Join-Path $Src 'skills'
  if (Test-Path $skillsRoot) {
    # ONE predicate, matching install.sh and the git cross-check exactly.
    Get-ChildItem -Path $skillsRoot -Recurse -File -Filter '*.md' | ForEach-Object {
      $out += ($_.FullName.Substring($Src.Length + 1) -replace '\\', '/')
    }
  }
  foreach ($dir in @('agents', 'commands', 'lib')) {
    $p = Join-Path $Src $dir
    if (Test-Path $p) {
      Get-ChildItem -Path $p -File -Filter '*.md' | ForEach-Object {
        $out += "$dir/$($_.Name)"
      }
    }
  }
  return $out
}

$manifest = Get-Manifest

# --- The manifest predicate must stay vacuous ----------------------------
# One predicate governs the preflight, the copy and the verification, so
# anything it does not match is neither installed nor reported — "broken but
# green". Introducing such a file must be deliberate, not a silent loss.
$unmatched = @()
$skillsRootCheck = Join-Path $Src 'skills'
if (Test-Path $skillsRootCheck) {
  Get-ChildItem -Path $skillsRootCheck -Recurse -File |
    Where-Object { $_.Extension -ne '.md' } |
    ForEach-Object { $unmatched += ($_.FullName.Substring($Src.Length + 1) -replace '\\', '/') }
}
if ($unmatched.Count -gt 0) {
  [Console]::Error.WriteLine("install.ps1: these files are inside a skill but are not .md, so the")
  [Console]::Error.WriteLine("manifest does not match them — they would NOT be installed, and no check")
  [Console]::Error.WriteLine("would report it:")
  foreach ($u in $unmatched) { [Console]::Error.WriteLine("  $u") }
  [Console]::Error.WriteLine("")
  [Console]::Error.WriteLine("Widen the manifest predicate deliberately if a skill needs to ship them.")
  exit 1
}

# --- Clobber preflight, per PATH and BEFORE any write --------------------
$collisions = @()
foreach ($rel in $manifest) {
  $dest = Join-Path $DestRoot ($rel -replace '/', [IO.Path]::DirectorySeparatorChar)
  if (Test-Path -LiteralPath $dest) { $collisions += $rel }
}

if ($collisions.Count -gt 0 -and -not $Force) {
  [Console]::Error.WriteLine("install.ps1: refusing to overwrite $($collisions.Count) existing file(s) under ${DestRoot}:")
  foreach ($c in $collisions) { [Console]::Error.WriteLine("  $c") }
  [Console]::Error.WriteLine("")
  [Console]::Error.WriteLine("Nothing was copied. Re-run with -Force to overwrite, or move these aside.")
  exit 1
}

# --- Copy ----------------------------------------------------------------
foreach ($dir in @('skills', 'agents', 'commands', 'lib')) {
  $null = New-Item -ItemType Directory -Force -Path (Join-Path $DestRoot $dir)
}

# -Force purges each skill directory first, so a file dropped from a skill in a
# later release does not survive as a stale sibling.
if ($Force) {
  Get-ChildItem -Path (Join-Path $Src 'skills') -Directory | ForEach-Object {
    $target = Join-Path (Join-Path $DestRoot 'skills') $_.Name
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  }
}

# THE COPY IS DRIVEN BY THE MANIFEST, path by path — the same single predicate
# the preflight and the verification use. A directory-wide Copy-Item was a third,
# broader predicate: a non-.md file in a skill would install while sitting
# outside both the clobber guard and the byte verification.
#
# Copy-Item only. NEVER Get-Content | Set-Content: that round-trip re-encodes and
# would add a BOM under Windows PowerShell 5.1, breaking the byte-identity
# promise this repository pins with sha256.
$lastDir = ''
foreach ($rel in $manifest) {
  $native   = $rel -replace '/', [IO.Path]::DirectorySeparatorChar
  $destFile = Join-Path $DestRoot $native
  $parent   = Split-Path -Parent $destFile
  # One New-Item per directory rather than per file.
  if ($parent -ne $lastDir) {
    $null = New-Item -ItemType Directory -Force -Path $parent
    $lastDir = $parent
  }
  Copy-Item -LiteralPath (Join-Path $Src $native) -Destination $destFile -Force
}

# --- Verification, re-enumerated independently of the copy ---------------
$missing = @()
$differing = @()
$emptySource = @()
$installed = 0
$expected = 0

foreach ($rel in (Get-Manifest)) {
  $expected++
  $srcFile  = Join-Path $Src     ($rel -replace '/', [IO.Path]::DirectorySeparatorChar)
  $destFile = Join-Path $DestRoot ($rel -replace '/', [IO.Path]::DirectorySeparatorChar)

  if (-not (Test-Path -LiteralPath $destFile -PathType Leaf)) {
    $missing += $rel
  } elseif ((Get-Item -LiteralPath $destFile).Length -eq 0) {
    # Attribute it correctly: an empty SOURCE means the copy was perfect.
    if ((Get-Item -LiteralPath $srcFile).Length -eq 0) {
      $emptySource += "$rel (empty)"
    } else {
      $differing += "$rel (empty)"
    }
  } elseif ((Get-FileHash -LiteralPath $srcFile).Hash -ne (Get-FileHash -LiteralPath $destFile).Hash) {
    $differing += "$rel (content differs from source)"
  } else {
    $installed++
  }
}

# The independent record: git still tracks a file deleted from the source tree,
# so this sees what enumeration structurally cannot.
$countDrift = @()
$noGitRecord = $false
$null = & git -C $Src rev-parse --is-inside-work-tree 2>$null
if ($LASTEXITCODE -eq 0) {
  $tracked = (& git -C $Src ls-files -- skills agents commands lib 2>$null |
              Where-Object { $_ -like '*.md' } | Sort-Object)
  $enumerated = ($manifest | Sort-Object)
  $absent = $tracked | Where-Object { $enumerated -notcontains $_ }
  if ($absent) {
    $countDrift += "tracked in git but absent from the source tree:"
    foreach ($a in $absent) { $countDrift += "    $a" }
  }
} else {
  $noGitRecord = $true
}

foreach ($decisive in @('skills/stride-opencode-lite-workflow/SKILL.md',
                        'skills/stride-opencode-lite-init/SKILL.md')) {
  $p = Join-Path $DestRoot ($decisive -replace '/', [IO.Path]::DirectorySeparatorChar)
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { $countDrift += "$decisive did not land" }
}

foreach ($dir in @('skills', 'agents', 'commands', 'lib')) {
  $p = Join-Path $DestRoot $dir
  if (-not (Test-Path $p) -or -not (Get-ChildItem -Path $p -Recurse -File)) {
    $countDrift += "$dir/ is empty after install"
  }
}

if ($missing.Count -gt 0 -or $differing.Count -gt 0 -or $emptySource.Count -gt 0 -or $countDrift.Count -gt 0 -or $installed -ne $expected) {
  [Console]::Error.WriteLine("install.ps1: INSTALL IS INCOMPLETE — $installed of $expected files verified at $DestRoot")
  if ($missing.Count -gt 0) {
    [Console]::Error.WriteLine("Missing after copy:")
    foreach ($m in $missing) { [Console]::Error.WriteLine("  $m") }
  }
  if ($differing.Count -gt 0) {
    [Console]::Error.WriteLine("Corrupt after copy:")
    foreach ($d in $differing) { [Console]::Error.WriteLine("  $d") }
  }
  if ($emptySource.Count -gt 0) {
    [Console]::Error.WriteLine("Empty in the source:")
    foreach ($e in $emptySource) { [Console]::Error.WriteLine("  $e") }
  }
  if ($countDrift.Count -gt 0) {
    [Console]::Error.WriteLine("Count mismatch:")
    foreach ($c in $countDrift) { [Console]::Error.WriteLine("  $c") }
  }
  [Console]::Error.WriteLine("Do not use this install. Fix the cause and re-run with -Force.")
  exit 1
}

$skillCount = (Get-ChildItem -Path (Join-Path $DestRoot 'skills') -Directory |
               Where-Object { $_.Name -like 'stride-opencode-lite-*' }).Count
Write-Output "Verified $installed of $expected files at $DestRoot (byte-identical to source)."
Write-Output ("  Skills:   {0}" -f $skillCount)
Write-Output ("  Agents:   {0}" -f (Get-ChildItem -Path (Join-Path $DestRoot 'agents') -File -Filter '*.md').Count)
Write-Output ("  Commands: {0}" -f (Get-ChildItem -Path (Join-Path $DestRoot 'commands') -File -Filter '*.md').Count)
Write-Output ("  Lib:      {0}" -f (Get-ChildItem -Path (Join-Path $DestRoot 'lib') -File -Filter '*.md').Count)
if ($noGitRecord) {
  Write-Output "  (source is not a git checkout, so completeness of the SOURCE was not"
  Write-Output "   verified — only that everything present in it was copied intact.)"
}

# --- Advisory: is the plugin actually registered? ------------------------
$registered = $false
$homeDir2 = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
foreach ($cfg in @((Join-Path (Get-Location).Path 'opencode.json'),
                   (Join-Path (Join-Path (Join-Path $homeDir2 '.config') 'opencode') 'opencode.json'))) {
  if ((Test-Path -LiteralPath $cfg) -and
      (Select-String -LiteralPath $cfg -Pattern 'stride-opencode-lite' -Quiet)) {
    $registered = $true
  }
}
if (-not $registered) {
  [Console]::Error.WriteLine("")
  [Console]::Error.WriteLine("install.ps1: NOTE — the artifacts are installed, but no opencode.json I can")
  [Console]::Error.WriteLine("see registers this plugin, so no hook section will ever fire. That is step 1")
  [Console]::Error.WriteLine("of the two-step install:")
  [Console]::Error.WriteLine("")
  [Console]::Error.WriteLine('    { "plugin": ["github:cheezy/stride-opencode-lite"] }')
  [Console]::Error.WriteLine("")
  [Console]::Error.WriteLine("See README.md. (If you registered it elsewhere, ignore this.)")
}
