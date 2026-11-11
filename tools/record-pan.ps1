param(
  [Parameter(Mandatory = $true)][string]$Steps,
  [string]$Out = (Join-Path $Env:TEMP 'pan.mp4'),
  [int]$Limit = 9
)

# Records the screen while the app runs one harness script, so a gesture can be
# measured frame by frame (tools/check-pan-frames.py) instead of by its end points.
# `Steps` is a script of `action|argument` pairs separated by `;`, the same actions
# tools/woxi-session.ps1 drives: 'plotsweep|-200,0,70;plotperf'.
#
# The device and adb come from tools/adbfunc.ps1: WOXI_ADB_SERIAL picks the device,
# otherwise the one attached device is used.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'adbfunc.ps1')
. (Join-Path $PSScriptRoot 'woxi-session.ps1')

$adb = $script:AdbPath
$serial = Resolve-AdbSerial
$remote = '/sdcard/pan.mp4'

if (-not (Start-WoxiSession)) {
    throw 'the app did not answer. Start it and try again'
}
Invoke-Adb -Arguments @('shell', 'rm', '-f', $remote) | Out-Null
$record = Start-Process -FilePath $adb -NoNewWindow -PassThru -ArgumentList @(
  '-s', $serial, 'shell', 'screenrecord', '--time-limit', "$Limit",
  '--bit-rate', '12000000', $remote
)
Start-Sleep -Milliseconds 1200
foreach ($step in $Steps.Split(';')) {
  $parts = $step.Split('|', 2)
  $name = $parts[0].Trim()
  if (-not $name) { continue }
  $argument = if ($parts.Length -gt 1) { $parts[1] } else { '' }
  Invoke-WoxiActionWait $name $argument | Out-Null
}
$record.WaitForExit()
Invoke-Adb -Arguments @('pull', $remote, $Out) | Out-Null
Invoke-Adb -Arguments @('shell', 'rm', '-f', $remote) | Out-Null
Write-Output $Out
