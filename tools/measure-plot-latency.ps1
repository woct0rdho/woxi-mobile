# Measures how per-evaluation latency depends on the notebook's content weight.
#
# Usage: .\tools\measure-plot-latency.ps1
#
# Times the same action (default: evaluating a small Plot) against notebooks of
# growing weight, from an empty one up to a document full of plots. Latency is
# measured from the "test action:" logcat line to the "evaluated" line, i.e. the
# app-side round trip excluding intent delivery.

. (Join-Path $PSScriptRoot 'woxi-session.ps1')

function Get-RawCount { return (Get-WoxiLogRaw | Measure-Object).Count }

function Time-Action {
  param([string]$Action, [string]$Argument)
  $before = Get-RawCount
  Invoke-WoxiAction $Action $Argument
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    $all = @(Get-WoxiLogRaw)
    if ($all.Count -gt $before) {
      $new = @($all | Select-Object -Skip $before)
      $start = $new | Where-Object { $_ -match 'test action' } | Select-Object -First 1
      $end = $new | Where-Object { $_ -match 'evaluated|loaded|dom:' } | Select-Object -Last 1
      if ($start -and $end) {
        $t0 = [datetime]::ParseExact((($start -split '\s+')[1]), 'HH:mm:ss.fff', $null)
        $t1 = [datetime]::ParseExact((($end -split '\s+')[1]), 'HH:mm:ss.fff', $null)
        return [math]::Round(($t1 - $t0).TotalMilliseconds)
      }
    }
  }
  return -1
}

function Sample {
  param([string]$Label, [string]$Action, [string]$Argument, [int]$Runs = 4)
  $times = @()
  for ($i = 0; $i -lt $Runs; $i++) {
    $ms = Time-Action $Action $Argument
    if ($ms -ge 0) { $times += $ms }
    Start-Sleep -Milliseconds 200
  }
  $sorted = $times | Sort-Object
  $median = if ($sorted.Count) { $sorted[[int][math]::Floor($sorted.Count / 2)] } else { -1 }
  Write-Host ("{0,-44} n={1} median={2,5} ms  [{3}]" -f $Label, $times.Count, $median, ($times -join ' '))
  return $median
}

$probe = 'Plot[Sin[x], {x, 0, 6}]'

Write-Host '=== empty notebook ==='
Time-Action 'loadjson' '{"version":1,"entries":[]}' | Out-Null
Start-Sleep -Milliseconds 500
Sample 'Plot[Sin[x], {x, 0, 6}]  (empty doc)' 'add' $probe

Write-Host ''
Write-Host '=== + 8 plain text entries ==='
for ($i = 1; $i -le 8; $i++) { Time-Action 'add' "n^2 + $i" | Out-Null }
Sample 'Plot[Sin[x], {x, 0, 6}]  (8 text entries)' 'add' $probe

Write-Host ''
Write-Host '=== + 8 more entries that each hold a plot ==='
for ($i = 1; $i -le 8; $i++) { Time-Action 'add' "Plot[Cos[$i x], {x, 0, 6}]" | Out-Null }
Sample 'Plot[Sin[x], {x, 0, 6}]  (8 plots, 16 entries)' 'add' $probe

Write-Host ''
Write-Host '=== + 8 more plots ==='
for ($i = 1; $i -le 8; $i++) { Time-Action 'add' "Plot[Sin[$i x], {x, 0, 6}]" | Out-Null }
Sample 'Plot[Sin[x], {x, 0, 6}]  (16 plots, 24 entries)' 'add' $probe
