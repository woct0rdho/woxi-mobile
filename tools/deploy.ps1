# Build the release APK, install it, launch it and capture a screenshot.
# . $PSScriptRoot\deploy.ps1   (or run it directly)
# Optional:
# -NoBuild to reinstall the existing APK,
# -Screenshot <path> to choose the output file,
# -KeepData to leave the stored notebook in place.

param(
    [switch]$NoBuild,
    [string]$Screenshot = '',
    [switch]$KeepData
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'adbfunc.ps1')

$Env:JAVA_HOME = 'C:\android\jdk21'
Set-Location $repo
if (-not $Screenshot) { $Screenshot = Join-Path $repo 'screenshots\latest.png' }

if (-not $NoBuild) {
    Write-Host '=== building release APK ==='
    $build = & .\gradlew.bat :app:assembleRelease --no-daemon --console=plain 2>&1 | Out-String
    if ($build -notmatch 'BUILD SUCCESSFUL') {
        Write-Host $build
        throw 'build failed'
    }
    Write-Host 'build ok'
}

$apk = Join-Path $repo 'app\build\outputs\apk\release\app-release.apk'

if (-not $KeepData) {
    # Uninstall rather than `pm clear`: installing over an existing APK has left a
    # stale asset state on this device, where the WebView then loads nothing.
    Write-Host '=== uninstalling (fresh profile) ==='
    Invoke-Adb -Arguments @('uninstall', 'com.woctordho.woximobile') | Out-Null
}

Write-Host '=== installing ==='
Write-Host (Invoke-Adb -Arguments @('install', $apk))

Write-Host '=== launching ==='
Invoke-Adb -Arguments @('shell', 'am', 'start', '-n', 'com.woctordho.woximobile/.MainActivity') | Out-Null
Start-Sleep -Seconds 5

Write-Host '=== recent app log ==='
Invoke-Adb -Arguments @('logcat', '-d', '-t', '120', '-s', 'Woxi:*') | Select-Object -Last 30

Save-AdbScreenshot -Path $Screenshot
