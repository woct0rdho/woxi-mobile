# Test-harness helper for the Woxi notebook app on the device.
#
# The device's WebView sometimes comes up without a working renderer (the page
# reports "finished" but never runs JavaScript), so a session is only considered
# live once the in-page test hook has answered.
#
# Usage: .\tools\woxi-session.ps1
#     Start-WoxiSession
#     Invoke-WoxiAction 'swipe' 'left'    # fire an woxi_action intent
#     Wait-WoxiLog 'kb: page='            # wait for the reply, returns the text
#     Get-WoxiLog 'kb: ' 10               # last matching lines

. (Join-Path $PSScriptRoot 'adbfunc.ps1')

$script:WoxiPackage = 'com.woctordho.woximobile'
$script:WoxiLogCursor = 0

function Get-WoxiLogRaw {
  # adb returns one multi-line string. Split it so Select-String matches lines.
  return ((Invoke-Adb -Arguments @('logcat', '-d', '-s', 'Woxi:*')) -split "`n")
}

# All logcat lines (every tag), split, for diagnosing the WebView.
function Get-AllLogLines {
  return ((Invoke-Adb -Arguments @('logcat', '-d')) -split "`n")
}

# `Get-WoxiLogRaw` hands back plain strings. `Select-String` hands back MatchInfo.
# Both shapes reach the helpers below, and reading `.Line` off a string silently
# yields $null, which made every wait look like an empty reply.
function ConvertTo-WoxiText($entry) {
  $text = if ($entry -is [string]) { $entry } elseif ($entry.Line) { $entry.Line } else { [string]$entry }
  return ($text -replace '^.*Woxi\s+:\s*', '')
}

function Get-WoxiLog([string]$pattern = '', [int]$count = 40) {
  $lines = Get-WoxiLogRaw
  if ($pattern) { $lines = $lines | Select-String -Pattern $pattern }
  return @($lines | Select-Object -Last $count | ForEach-Object { ConvertTo-WoxiText $_ })
}

function Invoke-WoxiAction([string]$action, [string]$argument = '') {
  $cmd = 'am start -n ' + $script:WoxiPackage + '/.MainActivity --es woxi_action ' + $action
  if ($argument) { $cmd += ' --es woxi_arg "' + ($argument -replace '"', '\"') + '"' }
  Invoke-Adb -Arguments @('shell', $cmd) | Out-Null
}

# Sends an action and returns the web-layer lines that appeared because of it.
function Invoke-WoxiActionWait([string]$action, [string]$argument = '', [int]$timeoutSec = 12) {
  $before = (Get-WoxiLogRaw | Measure-Object).Count
  Invoke-WoxiAction $action $argument
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    $all = Get-WoxiLogRaw
    if (($all | Measure-Object).Count -gt $before) {
      $new = @($all | Select-Object -Skip $before | ForEach-Object { ConvertTo-WoxiText $_ })
      $web = @($new | Where-Object { $_ -notmatch '^test action:|^page started:|^page finished:|^resource error:' -and $_ })
      if ($web.Count -gt 0) { return $web }
    }
  }
  return @('(no reply within ' + $timeoutSec + 's)')
}

# Waits until [pattern] shows up in the log, ignoring everything else.
function Wait-WoxiLog([string]$pattern, [int]$timeoutSec = 30) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    if ((Get-WoxiLogRaw | Select-String -Pattern $pattern | Measure-Object).Count -gt 0) {
      return $true
    }
    Start-Sleep -Milliseconds 400
  }
  return $false
}

function Test-WoxiAlive {
  $before = (Get-WoxiLogRaw | Measure-Object).Count
  Invoke-WoxiAction 'kb'
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $all = Get-WoxiLogRaw
    if (($all | Measure-Object).Count -gt $before) {
      $new = @($all | Select-Object -Skip $before | ForEach-Object { ConvertTo-WoxiText $_ })
      if (($new | Where-Object { $_ -match 'kb: page=' }).Count -gt 0) { return $true }
    }
  }
  return $false
}

# True when the system is refusing to start the WebView's sandboxed renderer for our
# uid, which is what "process is bad" means. Nothing in the app can clear that flag:
# the phone has to be restarted.
function Test-WoxiRendererBlocked {
  $lines = ((Invoke-Adb -Arguments @('logcat', '-d')) -split "`n")
  return ($lines | Where-Object { $_ -match 'Unable to launch app .*woximobile' -and $_ -match 'process is bad' }).Count -gt 0
}

function Start-WoxiSession([int]$attempts = 5, [int]$settleSec = 10) {
  # Never force-stop first: killing the app while the WebView's renderer service is
  # being started is what makes ActivityManager mark our uid "process is bad", after
  # which no renderer can start until the phone is restarted. A gentle reload of the
  # running instance gives a fresh page instead.
  Invoke-Adb -Arguments @('logcat', '-c') | Out-Null
  Invoke-WoxiAction 'reload' | Out-Null
  # Wait for the page rather than for a fixed delay: a cold start after an install
  # can take much longer than a reload, and probing too early just wastes a timeout.
  $loaded = Wait-WoxiLog 'page finished' ([Math]::Max(20, $settleSec))
  if (-not $loaded) {
    Start-Sleep -Seconds 2
  }
  if (Test-WoxiAlive) {
    Write-Host 'session alive (running instance)'
    return $true
  }
  for ($i = 1; $i -le $attempts; $i++) {
    Invoke-Adb -Arguments @('shell', 'am', 'start', '-n', "$($script:WoxiPackage)/.MainActivity") | Out-Null
    Wait-WoxiLog 'page finished' ([Math]::Max(15, $settleSec)) | Out-Null
    if (Test-WoxiAlive) {
      Write-Host "session alive (attempt $i)"
      return $true
    }
    if (Test-WoxiRendererBlocked) {
      Write-Host 'the Android WebView renderer is blocked for this app (ActivityManager: process is bad).'
      Write-Host 'Restart the phone to clear it; reinstalling does not.'
      return $false
    }
    Write-Host "attempt ${i}: no renderer"
  }
  Write-Host 'session could not be started; last log lines:'
  Get-WoxiLog '' 15 | ForEach-Object { Write-Host ('  ' + $_) }
  return $false
}
