# Device test driver: rebuild+install, then feed expressions to the app one by one
# through the intent hook and dump the resulting notebook state.
#
# .\tools\test-device.ps1                                   # default expression set
# .\tools\test-device.ps1 -Cases 'Integrate[x^2, x]','Plot[Sin[x], {x, -10, 10}]'
# .\tools\test-device.ps1 -NoBuild -KeepNotebook

param(
    [string[]]$Cases = @(),
    [switch]$NoBuild,
    [switch]$KeepNotebook,
    [int]$SettleSeconds = 4,
    [string]$Screenshot = ''
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'adbfunc.ps1')
$Env:JAVA_HOME = 'C:\android\jdk21'
Set-Location $repo
if (-not $Screenshot) { $Screenshot = Join-Path $repo 'screenshots\woxi_test.png' }

if ($Cases.Count -eq 0) {
    $Cases = @(
        'Integrate[x^2, x]',
        'Solve[x^2 == 4, x]',
        'N[AiryAi[1]]',
        'D[Sin[x^2], x]',
        'DSolveValue[y''[x] == y[x], y[x], x]',
        'Plot[Sin[x], {x, -10, 10}]',
        'Manipulate[Plot[Sin[a x], {x, 0, 10}], {a, 1, 5}]'
    )
}

function Invoke-AppAction {
    param([string]$Action, [string]$Argument = '')
    # The whole command is passed as one shell string: adb forwards it verbatim,
    # so arguments containing spaces or braces survive the device shell.
    $cmd = 'am start -n com.woctordho.woximobile/.MainActivity --es woxi_action ' + $Action
    if ($Argument) {
        $escaped = $Argument -replace '"', '\"'
        $cmd += ' --es woxi_arg "' + $escaped + '"'
    }
    Invoke-Adb -Arguments @('shell', $cmd) | Out-Null
}

if (-not $NoBuild) {
    Write-Host '=== building ==='
    $build = & .\gradlew.bat :app:assembleRelease --no-daemon --console=plain 2>&1 | Out-String
    if ($build -notmatch 'BUILD SUCCESSFUL') { Write-Host $build; throw 'build failed' }
    Write-Host '=== installing ==='
    Write-Host (Invoke-Adb -Arguments @('install', '-r', (Join-Path $repo 'app\build\outputs\apk\release\app-release.apk')))
}

if (-not $KeepNotebook) {
    # Clean install: a reinstall gives the app a fresh uid, which is the only reliable
    # way to clear a wedged WebView renderer on this ROM (see the README's device notes).
    Invoke-Adb -Arguments @('uninstall', 'com.woctordho.woximobile') | Out-Null
    Invoke-Adb -Arguments @('install', (Join-Path $repo 'app\build\outputs\apk\release\app-release.apk')) | Out-Null
}

# Clear the log so the dump below only contains this run.
Invoke-Adb -Arguments @('logcat', '-c') | Out-Null
Invoke-Adb -Arguments @('shell', 'am', 'start', '-n', 'com.woctordho.woximobile/.MainActivity') | Out-Null
Write-Host '=== waiting for the engine to boot ==='
Start-Sleep -Seconds 20

foreach ($case in $Cases) {
    Write-Host ("add: " + $case)
    Invoke-AppAction -Action 'add' -Argument $case
    Start-Sleep -Seconds $SettleSeconds
}

Invoke-AppAction -Action 'dump'
Start-Sleep -Seconds 2
Invoke-AppAction -Action 'dom'
Start-Sleep -Seconds 2

Write-Host '=== notebook dump ==='
# adb returns one multi-line string, so split it before filtering.
$logLines = (Invoke-Adb -Arguments @('logcat', '-d', '-s', 'Woxi:*')) -split "`n"
$logLines |
    Select-String -Pattern 'dump |dom: ' |
    Select-Object -Last 40 |
    ForEach-Object { ($_.Line -replace '^.*Woxi\s+:\s*', '') }

Save-AdbScreenshot -Path $Screenshot
