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

function Resolve-JavaHome {
    if ($Env:JAVA_HOME -and (Test-Path (Join-Path $Env:JAVA_HOME 'bin\java.exe'))) { return }
    if ($Env:WOXI_JAVA_HOME) {
        if (-not (Test-Path (Join-Path $Env:WOXI_JAVA_HOME 'bin\java.exe'))) {
            throw "WOXI_JAVA_HOME is not a JDK: $($Env:WOXI_JAVA_HOME)"
        }
        $Env:JAVA_HOME = $Env:WOXI_JAVA_HOME
        return
    }
    $java = Get-Command java -ErrorAction SilentlyContinue
    if ($java) {
        # bin\java.exe -> the JDK home two levels up.
        $Env:JAVA_HOME = Split-Path -Parent (Split-Path -Parent $java.Source)
        return
    }
    throw 'no JDK: set JAVA_HOME (JDK 17-25), or put java on PATH'
}

Resolve-JavaHome
Set-Location $repo
if (-not $Screenshot) { $Screenshot = Join-Path $repo 'screenshots\latest.png' }

if (-not $NoBuild) {
    Write-Host '=== building release APK ==='
    $build = & .\gradlew.bat :app:assembleRelease --no-daemon --console=plain -PwoxiAutomation=true 2>&1 | Out-String
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
Invoke-Adb -Arguments @('logcat', '-c') | Out-Null
Invoke-Adb -Arguments @('shell', 'am', 'start', '-n', 'com.woctordho.woximobile/.MainActivity') | Out-Null
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
    $log = (Invoke-Adb -Arguments @('logcat', '-d', '-s', 'Woxi:*')) -split '\r?\n'
    if (($log | Select-String -Pattern 'page finished|test: done').Count -gt 0) {
        break
    }
    Start-Sleep -Milliseconds 100
}

Write-Host '=== recent app log ==='
Invoke-Adb -Arguments @('logcat', '-d', '-t', '120', '-s', 'Woxi:*') | Select-Object -Last 30

Save-AdbScreenshot -Path $Screenshot
