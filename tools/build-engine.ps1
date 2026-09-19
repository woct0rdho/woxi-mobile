# Build the Woxi interpreter into app/src/main/jniLibs/arm64-v8a/libwoxi_jni.so.
#
# .\tools\build-engine.ps1                # arm64-v8a (phones)
# .\tools\build-engine.ps1 -Abi x86_64    # emulators
#
# One-time prerequisites (standard Rust/Android toolchain):
# rustup target add aarch64-linux-android
# cargo install cargo-ndk
# an NDK (any recent "ndk;<version>" from sdkmanager) must be installed
#
# Note for machines behind a proxy or a rustup mirror that does not mirror the
# Android std component: set HTTPS_PROXY/HTTP_PROXY, and make sure
# RUSTUP_DIST_SERVER points at a server that has rust-std-<target>
# (i.e. https://static.rust-lang.org).

param(
    [ValidateSet('arm64-v8a', 'x86_64')][string]$Abi = 'arm64-v8a',
    [string]$Profile = 'release'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$out = Join-Path $repo 'app\src\main\jniLibs'

# Locate the newest installed NDK unless the caller already exported one.
if (-not $Env:ANDROID_NDK_HOME -and -not $Env:ANDROID_NDK_ROOT) {
    $ndkRoot = 'C:\android\sdk\ndk'
    $candidate = Get-ChildItem $ndkRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if (-not $candidate) { throw "no NDK found in $ndkRoot - install one with sdkmanager 'ndk;<version>'" }
    $Env:ANDROID_NDK_HOME = $candidate.FullName
}
Write-Host "NDK: $Env:ANDROID_NDK_HOME"
Write-Host "target ABI: $Abi"

Push-Location (Join-Path $repo 'engine')
try {
    $args = @('ndk', '-t', $Abi, '--platform', '24', '-o', $out, 'build')
    if ($Profile -eq 'release') { $args += '--release' }
    & cargo @args
    if ($LASTEXITCODE -ne 0) { throw "cargo ndk failed ($LASTEXITCODE)" }
} finally {
    Pop-Location
}

# cargo-ndk copies every cdylib the workspace produced. The `woxi` crate builds one
# too. Only the JNI wrapper belongs in the APK.
Get-ChildItem $out -Recurse -Filter '*.so' |
    Where-Object { $_.BaseName -ne 'libwoxi_jni' } |
    ForEach-Object { Write-Host "removing stray library $($_.Name)"; Remove-Item $_.FullName }

Get-ChildItem $out -Recurse -Filter *.so | ForEach-Object {
    Write-Host ("built {0} ({1:N1} MB)" -f $_.FullName.Replace("$repo\", ''), ($_.Length / 1MB))
}
