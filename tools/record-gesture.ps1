param(
  [Parameter(Mandatory = $true)][string]$Steps,
  [string]$Out = (Join-Path $Env:TEMP 'gesture.mp4'),
  [int]$Limit = 6,
  [switch]$Reload
)

# Records the screen while a *finger-like* gesture runs, and prints the video's path for
# tools/check-pan-frames.py. Unlike record-pan.ps1 (which drives the app's synthetic pointer
# hooks), this can inject real touch input, so the app sees the same event stream a hand
# produces:
#
# swipe|x0,y0,x1,y1,ms           adb's touch swipe (the system interpolates the moves)
# pinch|cx,cy,gap0,gap1[,steps]  a real two-finger pinch (tools/inject-pinch.ps1)
# action|name|argument           an app harness action (tools/woxi-session.ps1)
# wait|ms                        a pause, e.g. to let a delayed answer arrive
#
# The notebook must already be on screen: the tool does not reload the page (that would put
# the plot's appearance into the recording). Use -Reload to start from a fresh page anyway.
#
# Steps are separated by `;`: 'swipe|540,800,780,800,500;wait|800'.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'adbfunc.ps1')
. (Join-Path $PSScriptRoot 'woxi-session.ps1')

$adb = $script:AdbPath
$serial = Resolve-AdbSerial
$remote = '/sdcard/gesture.mp4'

if ($Reload) {
    if (-not (Start-WoxiSession)) {
        throw 'the app did not answer. Start it and try again'
    }
} elseif (-not (Test-WoxiAlive)) {
    # No reload by default: the notebook (and the plot being measured) must already be on
    # screen and settled. A reload would replay it and put the appearance into the recording.
    throw 'the app is not running. Start it and add the plot first'
}
Invoke-Adb -Arguments @('shell', 'rm', '-f', $remote) | Out-Null
$record = Start-Process -FilePath $adb -NoNewWindow -PassThru -ArgumentList @(
  '-s', $serial, 'shell', 'screenrecord', '--time-limit', "$Limit",
  '--bit-rate', '12000000', $remote
)
Start-Sleep -Milliseconds 1200
foreach ($step in $Steps.Split(';')) {
  $parts = $step.Split('|')
  $kind = $parts[0].Trim()
  if (-not $kind) { continue }
  switch ($kind) {
    'action' {
      Invoke-WoxiActionWait $parts[1] ($parts[2] -join '|') | Out-Null
    }
    'swipe' {
      $values = ($parts[1] -split ',') | ForEach-Object { [int]$_ }
      Invoke-Adb -Arguments @(
        'shell', 'input', 'swipe',
        "$($values[0])", "$($values[1])", "$($values[2])", "$($values[3])", "$($values[4])"
      ) | Out-Null
    }
    'pinch' {
      $values = ($parts[1] -split ',') | ForEach-Object { [int]$_ }
      $pinchSteps = if ($values.Length -gt 4) { $values[4] } else { 8 }
      & (Join-Path $PSScriptRoot 'inject-pinch.ps1') -Serial $serial `
        -Cx $values[0] -Cy $values[1] -Gap0 $values[2] -Gap1 $values[3] -Steps $pinchSteps | Out-Null
    }
    'wait' {
      Start-Sleep -Milliseconds ([int]$parts[1])
    }
    default { throw "unknown step $kind" }
  }
}
Start-Sleep -Milliseconds 400
$record.WaitForExit()
Invoke-Adb -Arguments @('pull', $remote, $Out) | Out-Null
Invoke-Adb -Arguments @('shell', 'rm', '-f', $remote) | Out-Null
# A recording of a screen that never changed is one frame: the gesture did nothing (the page has
# no interactive plot, or the coordinates missed it). Without this check that looks like a
# successful run with an empty video, and the frame measurements then have nothing to say.
$ffprobe = Get-Command ffprobe -ErrorAction SilentlyContinue
if ($ffprobe) {
    $frames = & $ffprobe.Source -v error -count_frames -select_streams v:0 `
        -show_entries stream=nb_read_frames -of default=noprint_wrappers=1:nokey=1 $Out 2>$null
    if ($frames -match '^\d+$' -and [int]$frames -lt 2) {
        throw "the recording has $frames frame: the gesture changed nothing (is an interactive plot on screen?)"
    }
}
Write-Output $Out
