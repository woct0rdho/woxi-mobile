# Device test driver for plots: evaluate expressions one by one, screenshot each output, and
# optionally run gesture/action steps between them. Uses the running app. The in-app keyboard
# is part of the layout, so `shotout` scrolls an entry's plot card to the top of the viewport
# above it and logs the card's rectangle (CSS px) for the gesture tools and the frame checker.
#
# .\tools\test-3d.ps1 -Cases 'Plot3D[...]', 'Plot3D[..., Boxed -> False]'
# .\tools\test-3d.ps1 -Reinstall                      # fresh app, then the default plot
# .\tools\test-3d.ps1 -NoNotebook -Steps 'shotout|2|current','action|plot3dorbit|200,60,60'
#
# Steps: action|<name>|<argument>   an app harness action (tools/woxi-session.ps1)
#        shotout|<entry>|<name>     scroll entry n's plot to the top, log its rect, screenshot
#        shot|<name>                a screenshot
#        wait|<ms>

param(
    [string[]]$Cases = @(),
    [string[]]$Steps = @(),
    [string]$OutDir = (Join-Path $Env:TEMP 'p3d'),
    [switch]$NoNotebook,
    [switch]$Reinstall,
    [int]$CaseTimeoutSeconds = 90
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'woxi-session.ps1')
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if ($Reinstall) {
    Invoke-Adb -Arguments @('install', '-r', (Join-Path $repo 'app\build\outputs\apk\debug\app-debug.apk')) | Out-Null
    Invoke-Adb -Arguments @('shell', 'am', 'force-stop', 'com.woctordho.woximobile') | Out-Null
    Start-Sleep -Seconds 2
    Invoke-Adb -Arguments @('logcat', '-c') | Out-Null
    if (-not (Start-WoxiSession)) { throw 'no session' }
}

function Invoke-Step([string]$step) {
    $parts = $step.Split('|')
    switch ($parts[0].Trim()) {
        'action' { Invoke-WoxiActionWait $parts[1] (($parts | Select-Object -Skip 2) -join '|') 90 | ForEach-Object { Write-Host "  $_" } }
        'shotout' {
            $reply = Invoke-WoxiActionWait 'shotout' $parts[1] 30
            $reply | Where-Object { $_ -match 'shotout: ' } | ForEach-Object { Write-Host "  $_" }
            Start-Sleep -Milliseconds 300
            Save-AdbScreenshot -Path (Join-Path $OutDir ($parts[2] + '.png')) | Out-Null
            Write-Host "  shot $($parts[2])"
        }
        'shot' { Save-AdbScreenshot -Path (Join-Path $OutDir ($parts[1] + '.png')) | Out-Null; Write-Host "  shot $($parts[1])" }
        'wait' { Start-Sleep -Milliseconds ([int]$parts[1]) }
        default { throw "unknown step $step" }
    }
}

if (-not $NoNotebook -and -not $Reinstall) {
    Invoke-WoxiActionWait 'newnotebook' '' 30 | Out-Null
}
if ($Reinstall) {
    # A fresh page restores the last notebook. A new one makes the plot under test the only plot.
    Invoke-WoxiActionWait 'newnotebook' '' 30 | Out-Null
}
foreach ($case in $Cases) {
    Write-Host ("add: " + $case)
    Invoke-WoxiActionWait 'add' $case $CaseTimeoutSeconds | Out-Null
}
foreach ($step in $Steps) { Invoke-Step $step }
if ($Cases.Count) {
    Invoke-WoxiActionWait 'dump' '' $CaseTimeoutSeconds | ForEach-Object { Write-Host "  $_" }
}
