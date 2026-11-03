# adbfunc.ps1 - dot-source this in other scripts:
# . $PSScriptRoot\adbfunc.ps1
# Invoke-Adb -Arguments @('shell','input','keyevent','KEYCODE_WAKEUP')
#
# The USB link to this device can drop and re-appear, so every command waits for
# the device first and retries the whole command on transport errors.

# adb is resolved once, in this order:
# 1. $Env:WOXI_ADB
# 2. adb on PATH
# 3. $Env:ANDROID_HOME / $Env:ANDROID_SDK_ROOT / Android Studio's default SDK
function Resolve-AdbPath {
    if ($Env:WOXI_ADB) {
        if (Test-Path $Env:WOXI_ADB) { return (Resolve-Path $Env:WOXI_ADB).Path }
        throw "WOXI_ADB points at a missing file: $($Env:WOXI_ADB)"
    }
    $onPath = Get-Command adb -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    $roots = @($Env:ANDROID_HOME, $Env:ANDROID_SDK_ROOT, (Join-Path $Env:LOCALAPPDATA 'Android\Sdk'))
    foreach ($root in $roots) {
        if (-not $root) { continue }
        $candidate = Join-Path $root 'platform-tools\adb.exe'
        if (Test-Path $candidate) { return $candidate }
    }
    throw 'adb not found: put platform-tools on PATH, set ANDROID_HOME, or set WOXI_ADB'
}

$script:AdbPath = Resolve-AdbPath

# Serial of the device to drive. Set WOXI_ADB_SERIAL to use another one, e.g. an emulator:
# $Env:WOXI_ADB_SERIAL = 'emulator-5554'
$script:AdbSerial = if ($Env:WOXI_ADB_SERIAL) { $Env:WOXI_ADB_SERIAL } else { '3116TF1010011589' }

function Get-AdbDevice {
    $out = & $script:AdbPath devices 2>&1 | Out-String
    return ($out -match "$([regex]::Escape($script:AdbSerial))\s+device")
}

function Wait-AdbDevice {
    param([int]$TimeoutSeconds = 120)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Get-AdbDevice) { return $true }
        Start-Sleep -Milliseconds 1200
    }
    return $false
}

function Invoke-Adb {
    param(
        [Parameter(Mandatory = $true, Position = 0)][string[]]$Arguments,
        [int]$Retries = 8,
        [int]$WaitSeconds = 90
    )
    for ($attempt = 1; $attempt -le $Retries; $attempt++) {
        if (-not (Wait-AdbDevice -TimeoutSeconds $WaitSeconds)) { continue }
        $out = & $script:AdbPath -s $script:AdbSerial @Arguments 2>&1 | Out-String
        $text = $out.TrimEnd()
        if ($text -notmatch "device '$([regex]::Escape($script:AdbSerial))' not found" -and
            $text -notmatch 'error: closed' -and
            $text -notmatch 'no devices/emulators found' -and
            $text -notmatch 'failed to get feature set') {
            return $text
        }
        Start-Sleep -Milliseconds 900
    }
    return "ADB-FAILED: $($Arguments -join ' ')"
}

function Save-AdbScreenshot {
    param([Parameter(Mandatory = $true)][string]$Path)
    $remote = '/sdcard/woxi_shot.png'
    Invoke-Adb -Arguments @('shell', 'screencap', '-p', $remote) | Out-Null
    Invoke-Adb -Arguments @('pull', $remote, $Path) | Out-Null
    if (Test-Path $Path) {
        Write-Host ("screenshot: {0} ({1} bytes)" -f $Path, (Get-Item $Path).Length)
        return $true
    }
    Write-Host "screenshot FAILED: $Path"
    return $false
}

# Taps the first visible button whose text matches (to dismiss system dialogs).
function Tap-ButtonText {
    param([Parameter(Mandatory = $true)][string]$Text, [int]$TimeoutSeconds = 12)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Invoke-Adb -Arguments @('shell', 'uiautomator', 'dump', '/sdcard/ui.xml') | Out-Null
        Invoke-Adb -Arguments @('pull', '/sdcard/ui.xml', "$Env:TEMP\ui.xml") | Out-Null
        if (Test-Path "$Env:TEMP\ui.xml") {
            [xml]$ui = Get-Content "$Env:TEMP\ui.xml" -Raw
            $node = $ui.SelectNodes('//node') | Where-Object {
                $_.text -and $_.text.ToLower().Contains($Text.ToLower()) -and $_.bounds
            } | Select-Object -First 1
            if ($node) {
                if ($node.bounds -match '\[(\d+),(\d+)\]\[(\d+),(\d+)\]') {
                    $x = [int](([int]$Matches[1] + [int]$Matches[3]) / 2)
                    $y = [int](([int]$Matches[2] + [int]$Matches[4]) / 2)
                    Invoke-Adb -Arguments @('shell', 'input', 'tap', "$x", "$y") | Out-Null
                    Write-Host "tapped '$($node.text)' at $x,$y"
                    return $true
                }
            }
        }
        Start-Sleep -Milliseconds 800
    }
    Write-Host "button '$Text' not found"
    return $false
}
