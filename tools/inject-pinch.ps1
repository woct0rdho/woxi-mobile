# Injects a real two-finger pinch into the app on a device or emulator.
#
# adb's `input` command can only produce one finger, and the earlier synthetic
# pointer events in the web layer do not behave like real ones, so this writes the
# touch panel's multi-touch protocol directly: two slots on the same touchscreen
# device, which is how a real panel reports two fingers. Android only merges fingers
# that arrive on one device - writing each finger to a different emulator
# `virtio_input_multi_touch_N` device produces two independent single-finger streams
# and the web layer never sees a pinch.
#
# Needs root (`adb root`) because `sendevent` writes to /dev/input.
#
# Usage:
#     .\tools\inject-pinch.ps1 -Cx 588 -Cy 861 -Gap0 130 -Gap1 30       # pinch in (zoom out)
#     .\tools\inject-pinch.ps1 -Cx 588 -Cy 861 -Gap0 30  -Gap1 200      # pinch out (zoom in)

param(
  [string]$Serial = $(if ($Env:WOXI_ADB_SERIAL) { $Env:WOXI_ADB_SERIAL } else { 'emulator-5554' }),
  [int]$Cx = 588,
  [int]$Cy = 861,
  [int]$Gap0 = 130,
  [int]$Gap1 = 30,
  [int]$Steps = 8,
  [int]$TouchDevice = 2   # /dev/input/eventN of a touchscreen (see: getevent -pl)
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'adbfunc.ps1')
$adb = $script:AdbPath

$script = @"
#!/system/bin/sh
# Two-finger pinch: both fingers in one touchscreen device, MT protocol B slots.
E=/dev/input/event$TouchDevice
cx=$Cx
cy=$Cy
gap0=$Gap0
gap1=$Gap1
steps=$Steps
y=`$(( cy * 32767 / 2400 ))
xraw() { echo `$(( `$1 * 32767 / 1080 )); }
slot() { sendevent `$E 3 47 `$1; }
setup() {
  slot `$1
  sendevent `$E 3 57 `$2
  sendevent `$E 3 53 `$(xraw `$3)
  sendevent `$E 3 54 `$y
  sendevent `$E 3 58 100
}
place() { slot `$1; sendevent `$E 3 53 `$(xraw `$2); sendevent `$E 3 54 `$y; }
release() { slot `$1; sendevent `$E 3 57 -1; }
sync() { sendevent `$E 0 0 0; }

setup 0 1001 `$(( cx - gap0 ))
setup 1 1002 `$(( cx + gap0 ))
sync
i=1
while [ `$i -le `$steps ]; do
  gap=`$(( gap0 + (gap1 - gap0) * i / steps ))
  place 0 `$(( cx - gap ))
  place 1 `$(( cx + gap ))
  sync
  i=`$(( i + 1 ))
done
release 0
release 1
sync
echo "pinch: gap `$gap0 -> `$gap1 around `$cx,`$cy on device `$E"
"@

$local = Join-Path $Env:TEMP 'woxi-pinch.sh'
Set-Content -Path $local -Value $script -Encoding ascii -NoNewline
& $adb -s $Serial push $local /data/local/tmp/woxi-pinch.sh | Out-Null
& $adb -s $Serial shell chmod 755 /data/local/tmp/woxi-pinch.sh
& $adb -s $Serial shell /data/local/tmp/woxi-pinch.sh
