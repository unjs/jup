# jup installer for Windows.
#
#   irm https://jup.unjs.io/install.ps1 | iex
#
# It downloads the standalone binary for this machine from the release mirror
# under https://jup.unjs.io/r/, checks it against the digest GitHub recorded for
# that asset, and puts it in the directory `jup enable` uses for shims,
# %LOCALAPPDATA%\jup\bin, so one directory on PATH ends up holding jup and the
# tool commands it links rather than two.
#
# The binary carries its own runtime, so nothing here needs Node.js or npm.
#
# Unlike the POSIX script, this one puts the directory on the user PATH itself.
# That directory belongs to jup and exists only because of this install, so
# there is no shell profile a user already maintains for it to print a line
# into. Pass -NoPathUpdate to skip that and print the command instead.
#
# Parameters / environment:
#   -Dir <path> or JUP_INSTALL_DIR        where to put the binary
#   JUP_INSTALL_BASE_URL                  mirror (default: https://jup.unjs.io)

[CmdletBinding()]
param(
  [string] $Dir,
  [switch] $NoPathUpdate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$baseUrl = if ($env:JUP_INSTALL_BASE_URL) { $env:JUP_INSTALL_BASE_URL } else { 'https://jup.unjs.io' }

function Fail([string] $message) {
  # `throw` rather than `exit`, so an `irm | iex` run reports the failure and
  # unwinds through the cleanup below instead of closing the user's session.
  throw "jup install: $message"
}

# Two targets are published for Windows. RuntimeInformation reports the OS
# architecture rather than the process's, so this is still right under a 32-bit
# or emulated PowerShell on an arm64 machine, which PROCESSOR_ARCHITECTURE is
# not.
$osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
$arch = switch ($osArch) {
  'X64' { 'x64' }
  'Arm64' { 'arm64' }
  default { Fail "unsupported architecture: $osArch (jup ships x64 and arm64 binaries)" }
}

$target = "windows-$arch"
$asset = "jup-$target.tar.xz"

if (-not $Dir) {
  $Dir = if ($env:JUP_INSTALL_DIR) { $env:JUP_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'jup\bin' }
}

# tar.exe has shipped with Windows since 10 1803 and is libarchive, so it reads
# .tar.xz without an xz command. There is no PowerShell fallback: Expand-Archive
# is zip-only and .NET has no LZMA decoder.
$tar = Get-Command tar.exe -ErrorAction SilentlyContinue
if (-not $tar) {
  Fail 'tar.exe was not found. It ships with Windows 10 1803 and later; on an older system, install jup with "npm install -g jup" instead.'
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("jup-install-" + [System.Guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

try {
  $archive = Join-Path $tmp $asset

  Write-Host "jup install: downloading $asset"
  # The default progress bar makes Invoke-WebRequest an order of magnitude
  # slower on a file this size, and this one is ~30 MB.
  $progress = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  try {
    Invoke-WebRequest -Uri "$baseUrl/r/$asset" -OutFile $archive -UseBasicParsing
    $index = Invoke-RestMethod -Uri "$baseUrl/r/index.json" -UseBasicParsing
  } finally {
    $ProgressPreference = $progress
  }

  # Advisory, not a gate: the mirror serves both the archive and the index, so a
  # host that could alter one could alter the other. It catches a truncated or
  # stale-cached download, which is what actually goes wrong here.
  $expected = ($index.assets | Where-Object { $_.name -eq $asset }).digest
  if ($expected) {
    $actual = 'sha256:' + (Get-FileHash -Path $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      Fail "checksum mismatch for $asset (expected $expected, got $actual)"
    }
  }

  & $tar.Path -xf $archive -C $tmp
  if ($LASTEXITCODE -ne 0) { Fail "cannot unpack $asset" }

  $extracted = Join-Path $tmp "jup-$target.exe"
  if (-not (Test-Path -LiteralPath $extracted)) { Fail "$asset did not contain jup-$target.exe" }

  New-Item -ItemType Directory -Path $Dir -Force | Out-Null
  $dest = Join-Path $Dir 'jup.exe'

  # Windows refuses to overwrite a running executable but does allow renaming
  # one out of the way, which is how a `jup` that is upgrading itself can still
  # be replaced. The displaced file is deleted straight afterwards when nothing
  # holds it, and otherwise on the next install.
  $stale = "$dest.old"
  if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $dest) { Rename-Item -LiteralPath $dest -NewName (Split-Path $stale -Leaf) -Force }
  Move-Item -LiteralPath $extracted -Destination $dest -Force
  if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Force -ErrorAction SilentlyContinue }

  $version = (& $dest --version 2>$null)
  Write-Host "jup install: installed jup $version to $dest"

  # HKCU only. A machine-wide PATH needs elevation, and this install is
  # per-user by construction.
  #
  # The registry is read and written directly rather than through
  # [Environment]::SetEnvironmentVariable, which stores the value as REG_SZ and
  # so silently freezes any `%VAR%` an existing user PATH was relying on. The
  # read asks for the unexpanded value for the same reason: expanding it and
  # writing it back would do the damage without the type change.
  $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  try {
    if (-not $envKey) { Fail 'cannot open HKCU\Environment to read PATH' }
    $userPath = [string] $envKey.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    $onPath = @($userPath -split ';' | Where-Object { $_.Trim() } |
      Where-Object { $_.TrimEnd('\') -ieq $Dir.TrimEnd('\') }).Count -gt 0
    if (-not $onPath) {
      if ($NoPathUpdate) {
        Write-Host ''
        Write-Host "  $Dir is not on PATH. Add it, then open a new terminal:"
        Write-Host ''
        Write-Host "    setx PATH `"$Dir;%PATH%`""
        Write-Host ''
      } else {
        $updated = if ($userPath) { "$Dir;$userPath" } else { $Dir }
        $envKey.SetValue('Path', $updated, 'ExpandString')
        # That value is for processes started from now on; this one keeps the
        # session that ran the installer working without a restart.
        $env:Path = "$Dir;$env:Path"
        Write-Host "jup install: added $Dir to your user PATH (open a new terminal for other apps to see it)."
      }
    }
  } finally {
    if ($envKey) { $envKey.Dispose() }
  }

  # Not `jup enable`: shims point at a stub that imports the entry module, and
  # a single-file binary has no such file on disk (see docs/.agents section 10.2).
  # Linking the tool commands still needs the npm package.
  Write-Host "Next: run 'jup use pnpm@12' in a project, or 'jup --help'."
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
