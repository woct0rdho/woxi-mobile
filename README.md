# Woxi Mobile

Android frontend for [Woxi](https://github.com/ad-si/Woxi) the Wolfram Language interpreter, with a mobile-friendly UI inspired by MathStudio.

## Architecture

```
app/src/main/kotlin/com/woctordho/woximobile/
  MainActivity.kt        WebView shell: edge-to-edge, asset loader, SAF, back handling, theme
  NativeEngine.kt        loads libwoxi_jni.so, owns the single engine thread
  NativeBridge.kt        window.WoxiNative: engineRequest(...), files, theme, insets
app/src/main/assets/www/
  index.html             top bar / notebook / keyboard / sheets (+ pre-paint theme script)
  css/app.css            light and dark palettes
  js/app.js              entries, persistence, menu, options (theme), keyboard wiring
  js/keyboard.js         in-app math keyboard, pages, swipe gestures
  js/notebook.js         Jupyter .ipynb documents (reader/writer) + base64 helpers
  js/woxi-client.js      main-thread client (promises over the native bridge)
  js/render-output.js    interpreter output items -> notebook HTML, plot margin trim
  js/plot-interact.js    drag to pan and pinch to zoom a 2D plot
  js/prototypes.js       curated argument shapes and the slot-role helpers
  js/assist.js           the typing bar and its sheet (prototypes.js holds the table)
engine/                  Rust crate `woxi-jni`: the JNI wrapper around the Woxi core
  src/lib.rs             JNI entry points, crate docs and the module list
  src/json.rs            request/reply envelopes, flat field readers, escaping
  src/output.rs          output items: text, graphics, print, warning, error
  src/eval.rs            one entry at a time -> its output items
  src/manipulate.rs      Manipulate controls and re-rendering with new values
  src/plot.rs            plot handles, and the sampler rewriting behind pan/zoom
  src/assist/            typing help: complete, inspect, status, diagnostics, prototypes
  data/functions.csv     Woxi's symbol registry, vendored for its frequency order
app/src/main/jniLibs/arm64-v8a/libwoxi_jni.so   built by tools/build-engine.ps1
tools/                   build, deploy and test scripts, plus the three that own the artwork:
  trace-woxi-mark.py     traces Woxi's W out of their logo bitmap into clean geometry
  make-woxi-mobile.py    puts two wheels under it ("Woxi Mobile")
  make-icon.py           fits that into Android's icon layers and writes res/ + design/
design/                  what those three write: SVGs, PNGs, the traced outline (gitignored)
```

## Build

```powershell
# SDK and NDK (put them on PATH, or export ANDROID_HOME pointing at the SDK)
rustup target add aarch64-linux-android
cargo install cargo-ndk
sdkmanager "ndk;28.2.13676358"

# Engine (after changing `engine/`)
.\tools\build-engine.ps1                           # -> app/src/main/jniLibs/arm64-v8a/libwoxi_jni.so
.\tools\build-engine.ps1 -Abi x86_64               # for the emulator

# App
# Gradle 9.8 runs on JDK 17-25. Point JAVA_HOME at one (or have
# `java` on PATH. deploy.ps1 and test-device.ps1 derive JAVA_HOME from it).
.\gradlew.bat :app:assembleRelease                 # arm64-v8a
.\gradlew.bat :app:assembleRelease -Pabi=all       # arm64-v8a + x86_64

# Build + install + launch + screenshot on a connected phone
.\tools\deploy.ps1
```

Notes:
- `cargo-ndk` needs an NDK. `tools/build-engine.ps1` uses `ANDROID_NDK_HOME` if set, otherwise the newest NDK under the SDK found through `ANDROID_HOME`, `ANDROID_SDK_ROOT` or Android Studio's default location.
- The library is stored uncompressed and mmapped from the APK. Only ABIs that have a `libwoxi_jni.so` in `app/src/main/jniLibs` are packaged, and `-Pabi` picks which. The default is arm64-v8a alone, since that is the phone.

## Lint and test

See `.github/workflows/lint.yml`.

## Automation hooks

The web layer exposes `window.WoxiApp.testAction(action, argument)`, and `MainActivity.handleTestIntent()` drives it from an intent extra, so the app can be driven on a device without touching the screen:

```powershell
adb shell am start -n com.woctordho.woximobile/.MainActivity --es woxi_action dump
adb shell am start -n com.woctordho.woximobile/.MainActivity --es woxi_action keys 'Plot'
```

`tools/woxi-session.ps1` wraps this (`Start-WoxiSession`, `Invoke-WoxiAction`, `Invoke-WoxiActionWait`, `Get-WoxiLog`) and retries a session until the page answers, which is what the on-device checks above use. Available actions: `insert`, `add`, `type` (put text in the entry without evaluating it), `key`, `keys`, `press` (press a keyboard key by label), `caret`, `evalall`, `dom`, `dump`, `metrics`, `kb`, `swipe`, `barswipe`, `multitouch` (the two-finger drag case, with `lost` for a dropped `touchend`), `shift`, `save`, `loadjson`, `serialize`, `sheet`, `options`, `theme`, `reload`, `slider`, `scrollto`, `plotview` (drive a plot gesture: `pan,<dx>,<dy>` or `zoom,<factor>`), `plotdrag` and `plotpinch` (streamed single-pointer and two-pointer gestures, since adb cannot inject two fingers at once), `plotlatency` (delay plot answers by n ms, to reproduce races).

The typing-help bar has its own hooks: `assist` logs the bar state (`idle`, `signature`, `candidates`, `options`, `iterator`), the prefix, the first matches, the caret, the entry text and the centre of every bar key in device pixels, which is what a tap test needs. `assistaccept` accepts a match by name (the first one by default). `assistsheet` opens the sheet on `all`, `examples` or `about`. `assistclose` closes it.

## Debugging in an emulator

An emulator is the better environment for gesture work: a standard ROM, and it can be rebooted in seconds when the WebView gets itself into a bad state.

```powershell
# System image and AVD (avdmanager's prompt hangs when not on a TTY, so the AVD is written by hand)
sdkmanager "system-images;android-36;google_apis;x86_64"
# Installed to %USERPROFILE%\.android\avd\woxi36.ini and woxi36.avd\config.ini, then:
emulator -avd woxi36 -no-snapshot -no-boot-anim -gpu auto

# The engine also has to exist for the emulator's ABI
rustup target add x86_64-linux-android
cargo ndk -t x86_64 --platform 24 -o ..\app\src\main\jniLibs build --release

# Drive the emulator instead of the phone
$Env:WOXI_ADB_SERIAL = 'emulator-5554'       # every tools/*.ps1 honours this
adb -s emulator-5554 root                    # google_apis (not playstore) images allow this
.\tools\inject-pinch.ps1 -Cx 588 -Cy 861 -Gap0 130 -Gap1 30   # real two-finger pinch
```

`tools/inject-pinch.ps1` writes the touch panel's multi-touch protocol directly, with both fingers in two slots of the same touchscreen device. That detail matters: Android only merges fingers that arrive on one device, so writing each finger to a different emulator `virtio_input_multi_touch_N` device produces two independent single-finger streams and the web layer never sees a pinch at all.

`dump` reports one line per entry: its source, how many SVGs it has, whether the plot trim ran (`fit=yes WxH`), the rectangle gestures map onto (`rect=WxH/data` when the axes were recognised, `/svg` when they were not), a text preview of the output, and how long the engine round trip and the rendering took (`engine=..ms render=..ms json=..B`).
