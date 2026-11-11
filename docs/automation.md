# Automation and Debugging

Two ways to drive the app without a finger, and the emulator setup the gesture work uses.

## Automation hooks

The web layer exposes `window.WoxiApp.testAction(action, argument)`, and `MainActivity.handleTestIntent()` drives it from an intent extra, so the app can be driven on a device without touching the screen:

```pwsh
adb shell am start -n com.woctordho.woximobile/.MainActivity --es woxi_action dump
adb shell am start -n com.woctordho.woximobile/.MainActivity --es woxi_action keys --es woxi_arg Plot
```

`tools/woxi-session.ps1` wraps this (`Start-WoxiSession`, `Invoke-WoxiAction`, `Invoke-WoxiActionWait`, `Wait-WoxiLog`, `Get-WoxiLog`) and retries a session until the page answers. Dot-source it to get the functions. It finds adb through `WOXI_ADB` (a full path), then `PATH`, then `ANDROID_HOME`/`ANDROID_SDK_ROOT`/Android Studio's default SDK. `WOXI_ADB_SERIAL` picks the device, otherwise the one attached device is used, so no serial is baked in. `tools/test-device.ps1` builds on it to feed whole expressions through the hook:

```pwsh
.\tools\test-device.ps1 -Cases 'Integrate[x^2, x]', 'Plot[Sin[x], {x, -10, 10}]'
```

A check that needs several actions in order runs them as a step script - `action|argument` pairs separated by `;` - which is how the entries below are used:

```pwsh
. .\tools\woxi-session.ps1
Start-WoxiSession
Invoke-WoxiActionWait 'insert' 'Plot[Sin[x], {x, -8, 8}]'
Invoke-WoxiActionWait 'evalall'
Invoke-WoxiActionWait 'plotperf'
Get-WoxiLog 'plotperf'
```

### Entries and text

- `insert <text>` puts the text in the active entry, focuses it and leaves the caret at the end. It does not evaluate.
- `add <text>` appends a new entry with that source and evaluates it, logging the setup and evaluation timings.
- `type <text>` sets the active entry's text without evaluating it or moving focus, which is what the typing help needs to see a partial expression.
- `caret <at>` puts the caret at a character offset. `caret <start>,<end>` selects a range, the way the selection handles would.
- `key <enter|plot|solve|back>` presses one of the keyboard's action keys.
- `keys <label>` presses a key by its label, exactly as a tap would: the current page wins, otherwise the first page or bar page with that label. It logs the input, the caret, shift and the entry count.
- `press <label>` presses a key by label through the same tap path and logs which page it came from.
- `format` formats the active entry. `formatall` formats every entry.
- `wrap <name>` wraps the input in a function (default `Simplify`). `skeleton <name>` inserts the argument skeleton for one (default `Plot`).
- `undo` and `redo` step the active entry's text history and log whether either is still possible.
- `godef` jumps to the definition under the caret.
- `evalall` evaluates every entry in order. The log reports whether there was any input and when the run finished.

### Keyboard, sheets and layout

- `kb` logs the keyboard's state: page, shift, visible height.
- `shift` toggles shift. `shift double` simulates two quick taps, which the adb harness is too slow to produce.
- `swipe <left|right|up|down>` swipes the keyboard pages and logs whether the page changed and the keyboard height.
- `barswipe <left|right>` swipes the symbol bar above the keyboard.
- `multitouch [lost]` reproduces the reported pad case: one finger drags, a second touches the pad, the first finishes the drag. `lost` drops the first `touchend`, which used to wedge the pad.
- `theme <system|light|dark>` sets the theme and logs the resolved one.
- `reload` reloads the page, which is how a WebView in a bad state is cleared without reinstalling.
- `sheet` opens the menu. `options` opens the options sheet.
- `card <section>` opens the assistance card on a section and logs how many rows it has.
- `slider [fraction]` nudges the first `Manipulate` slider to that fraction of its range (default 0.75), which checks live re-rendering.
- `scrollto <n>` scrolls entry `n` to the top.
- `metrics` logs the input box geometry (wrapped lines must not be clipped) and the keyboard geometry (a swipe must not resize it).

### Documents

- `save <name>` writes the notebook through the system file picker.
- `loadjson <json>` loads a notebook from JSON text, as if it had been opened.
- `serialize` logs the notebook as JSON, which is what a round-trip check compares.

### Typing help

- `assist` dumps the bar state (`idle`, `signature`, `candidates`, `options`, `iterator`), the prefix, the first matches, the caret, the entry text and the centre of every bar key in device pixels, which is what a tap test needs.
- `assistaccept [name]` accepts a match (the first one by default).
- `assistsheet <all|examples|about>` opens the help sheet on that section. `assistclose` closes it.
- `diag` logs the issues the help found: their codes, which have a fix, and the text they were found in.

### Plots

- `plotview <pan,dx,dy|zoom,factor>` drives a gesture directly: a pan in pixels, or a zoom about the plot's centre.
- `plotdrag <dx,dy>` and `plotpinch <factor>` stream single-pointer and two-pointer gestures over time, since adb cannot inject two fingers at once.
- `plotsweep <dx,dy,frames>` drags at display-frame rate for that many frames and logs how long it took, which is a finger rather than a script stepping through moves.
- `plothold <dx,dy>`, `plotmove <fraction>` and `plotrelease` do the same step by step and leave the finger down, so a screenshot can catch the frame the canvas draws before any answer arrives.
- `plotlatency <ms>` delays every plot answer, which is how a gesture is checked with the engine behind.
- `plotrefine` asks for a re-sample now instead of waiting for the idle timer.
- `plotperf` logs what plot frames cost: round trip, SVG paint, canvas draws, payload bytes, the range and coverage, and how often a re-sample was asked for. `plotperf reset` clears the counters.
- `plotstate` logs what the first plot's controller believes: the range the finger asked for, the picture's range, the samples' coverage, whether a canvas is mounted, how many series it holds, and the matrix of its last draw.
- `plotframe` logs the picture's frame and the payload's data rectangle in user units next to each other, and `plotcanvas` the canvas element, its bitmap and every box the paint uses. The pair is what showed that a frame is not a data area.

`dump` reports one line per entry: its source, how many SVGs it has, whether the plot trim ran (`fit=yes WxH`), the rectangle gestures map onto (`rect=WxH/data` when the axes were recognised, `/svg` when they were not), a text preview of the output, and how long the engine round trip and the rendering took (`engine=..ms render=..ms json=..B`).

Gestures can also be measured rather than eyeballed: `tools/record-pan.ps1` records the screen while a sweep runs, and `tools/check-pan-frames.py` measures the recording frame by frame - the curve's box inside the plot card, how far it stops short of the edge it should reach, and the step it moved. A pan that hides part of the curve until an answer lands shows up there as a short box or a still frame followed by a jump.

## Debugging in an emulator

An emulator is the better environment for gesture work: a standard ROM, and it can be rebooted in seconds when the WebView gets itself into a bad state.

```pwsh
# System image and AVD (avdmanager's prompt hangs when not on a TTY, so the AVD is written by hand)
sdkmanager "system-images;android-36;google_apis;x86_64"
# Installed to %UserProfile%\.android\avd\woxi36.ini and woxi36.avd\config.ini, then:
emulator -avd woxi36 -no-snapshot -no-boot-anim -gpu auto

rustup target add x86_64-linux-android
.\tools\build-engine.ps1 -Abi x86_64 -Profile fast

# Drive the emulator instead of the phone
$Env:WOXI_ADB_SERIAL = 'emulator-5554'       # every tools/*.ps1 honours this
adb -s emulator-5554 root                    # google_apis (not playstore) images allow this
.\tools\inject-pinch.ps1 -Cx 588 -Cy 861 -Gap0 130 -Gap1 30   # real two-finger pinch
```

`tools/inject-pinch.ps1` writes the touch panel's multi-touch protocol directly, with both fingers in two slots of the same touchscreen device. That detail matters: Android only merges fingers that arrive on one device, so writing each finger to a different emulator `virtio_input_multi_touch_N` device produces two independent single-finger streams and the web layer never sees a pinch at all.
