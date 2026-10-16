<#
.SYNOPSIS
  1-Command Release Builder & GitHub Auto-Update Publisher for Typo.

.DESCRIPTION
  1. Updates version numbers across package.json, Cargo.toml, tauri.conf.json, and backstage.ts
     using strict UTF-8 (without BOM) reading and writing so Unicode symbols never get corrupted.
  2. Optionally embeds your GitHub Release repo (e.g. "username/typo-releases") into DEFAULT_SETTINGS
     so any friend who installs your Setup.exe is automatically connected to your update channel!
  3. Builds the production frontend + Rust binary + Windows NSIS Setup Installer
  4. Copies the installer and portable executable into .\releases\
  5. If -Repo is specified and GitHub CLI (gh) is installed, publishes the release directly to GitHub!

.EXAMPLE
  .\publish-release.ps1 -Version "1.0.0"
  .\publish-release.ps1 -Version "1.0.1" -Repo "yourname/typo-releases" -Notes "New PDF Studio tools"
#>
param(
    [string]$Version = "",
    [string]$Repo = "",
    [string]$Notes = "Typo Desktop Suite release build."
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Read-Utf8([string]$Path) {
    return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
}
function Write-Utf8NoBom([string]$Path, [string]$Text) {
    $clean = $Text.TrimStart([char]0xFEFF)
    [System.IO.File]::WriteAllText($Path, $clean, $utf8NoBom)
}

$pkgPath = Join-Path $ProjectRoot "package.json"
$cargoPath = Join-Path $ProjectRoot "src-tauri\Cargo.toml"
$tauriConfPath = Join-Path $ProjectRoot "src-tauri\tauri.conf.json"
$backstagePath = Join-Path $ProjectRoot "src\ui\backstage.ts"
$settingsPath = Join-Path $ProjectRoot "src\core\settings.ts"

$pkgRawInit = Read-Utf8 $pkgPath
$pkgJson = $pkgRawInit | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = $pkgJson.version
}
$Version = $Version.TrimStart('v', 'V')

Write-Host "`n========================================================" -ForegroundColor Cyan
Write-Host "  Typo Release Builder & Publisher  -  v$Version" -ForegroundColor Cyan
Write-Host "========================================================`n" -ForegroundColor Cyan

# 1. Sync version across project files (Strict UTF-8 without BOM)
Write-Host "[1/4] Syncing version v$Version across configuration files..." -ForegroundColor Yellow
$pkgRaw = [regex]::Replace($pkgRawInit, '"version"\s*:\s*"[^"]+"', "`"version`": `"$Version`"", 1)
Write-Utf8NoBom $pkgPath $pkgRaw

$cargoRaw = Read-Utf8 $cargoPath
$cargoRaw = [regex]::Replace($cargoRaw, '(?m)^version\s*=\s*"[^"]+"', "version = `"$Version`"", 1)
Write-Utf8NoBom $cargoPath $cargoRaw

$tauriRaw = Read-Utf8 $tauriConfPath
$tauriRaw = [regex]::Replace($tauriRaw, '"version"\s*:\s*"[^"]+"', "`"version`": `"$Version`"", 1)
Write-Utf8NoBom $tauriConfPath $tauriRaw

$bsRaw = Read-Utf8 $backstagePath
$bsRaw = $bsRaw -replace 'Installed: v[0-9]+\.[0-9]+\.[0-9]+', "Installed: v$Version"
$bsRaw = $bsRaw -replace 'Version [0-9]+\.[0-9]+\.[0-9]+', "Version $Version"
Write-Utf8NoBom $backstagePath $bsRaw

if (-not [string]::IsNullOrWhiteSpace($Repo)) {
    Write-Host "      Embedding default update channel '$Repo' into settings.ts..." -ForegroundColor DarkCyan
    $setRaw = Read-Utf8 $settingsPath
    $setRaw = [regex]::Replace($setRaw, 'updateRepo:\s*"[^"]*"', "updateRepo: `"$Repo`"", 1)
    Write-Utf8NoBom $settingsPath $setRaw
}

# 2. Build frontend & Tauri NSIS installer
Write-Host "[2/4] Building TypeScript frontend & Windows NSIS Setup Installer..." -ForegroundColor Yellow
$env:CARGO_INCREMENTAL = "0"
npm run build
if ($LASTEXITCODE -ne 0) { throw "Frontend build failed." }

npx tauri build --bundles nsis
if ($LASTEXITCODE -ne 0) { throw "Tauri NSIS build failed." }

# 3. Collect artifacts into .\releases\ and update Creative Apps Portal binary
Write-Host "[3/4] Organizing release packages in .\releases\..." -ForegroundColor Yellow
$releasesDir = Join-Path $ProjectRoot "releases"
New-Item -ItemType Directory -Force -Path $releasesDir | Out-Null

$builtExe = Join-Path $ProjectRoot "src-tauri\target\release\typo.exe"
$setupDir = Join-Path $ProjectRoot "src-tauri\target\release\bundle\nsis"
$setupExe = Get-ChildItem -Path $setupDir -Filter "*setup*.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1

$outPortable = Join-Path $releasesDir "Typo_${Version}_Portable.exe"
$outSetup = Join-Path $releasesDir "Typo_${Version}_x64-setup.exe"

Copy-Item $builtExe $outPortable -Force
if ($setupExe) {
    Copy-Item $setupExe.FullName $outSetup -Force
}

try {
    Copy-Item $builtExe (Join-Path $ProjectRoot "Typo.exe") -Force
} catch {
    Write-Host "      (Note: Typo.exe is currently running; close it to overwrite root Typo.exe)" -ForegroundColor DarkGray
}

Write-Host "`n  -> Installer ready: $outSetup" -ForegroundColor Green
Write-Host "  -> Portable ready : $outPortable`n" -ForegroundColor Green

# 4. Optional GitHub Release upload
if (-not [string]::IsNullOrWhiteSpace($Repo)) {
    Write-Host "[4/4] Publishing v$Version to GitHub Releases ($Repo)..." -ForegroundColor Yellow
    if (Get-Command gh -ErrorAction SilentlyContinue) {
        $assets = @($outPortable)
        if (Test-Path $outSetup) { $assets += $outSetup }
        gh release create "v$Version" @assets --repo $Repo --title "Typo v$Version" --notes $Notes
        if ($LASTEXITCODE -eq 0) {
            Write-Host "`nPublished Typo v$Version to https://github.com/$Repo/releases/tag/v$Version !" -ForegroundColor Green
        }
    } else {
        Write-Host "GitHub CLI ('gh') not found. Upload '$outSetup' manually to https://github.com/$Repo/releases/new with tag 'v$Version'." -ForegroundColor Yellow
    }
} else {
    Write-Host "[4/4] Done! Share '$outSetup' with your friends, or pass -Repo 'username/typo-releases' to auto-publish to GitHub." -ForegroundColor Cyan
}
