# Automation and Debugging

Two ways to drive the app without a finger, and the emulator setup the gesture work uses.

## Automation hooks

The web layer exposes `window.WoxiApp.testAction(action, argument)`, and `MainActivity.handleTestIntent()` drives it from an intent extra, so the app can be driven on a device without touching the screen:

```pwsh
adb shell am start -n com.woctordho.woximobile/.MainActivity --es woxi_action dump
adb shell am start -n com.woctordho.woximobile/.MainActivity --es woxi_action keys --es woxi_arg Plot
```

An action is applied as soon as the page is usable, not after a fixed delay: the web layer reports when boot has finished (after the engine starts), and actions that arrive while a page is loading - on launch, or after `reload` - wait in order for it. Each action ends with a `test: done <action>` log line, so a harness can wait for the action itself rather than for a guessed duration. The log line is also how a failing action is seen (its exception is logged before the marker).

The hardware keyboard is driven the same way: `adb shell input text 'Sin'` types text (through the active IME, like a physical keyboard), `adb shell input keyevent KEYCODE_TAB` presses one key, and `adb shell input keycombination 113 54` presses Ctrl+Z. A test of the mix types here, taps an in-app key with `keys`, and checks the entry and the caret with `dump` and `focus`.

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
- `focus` logs whether the window has the focus that draws the caret (`window=`), which element the DOM focuses (`active=`), whether it is the active entry's textarea, and that textarea's selection.
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

- `assist` dumps the bar state (`idle`, `signature`, `candidates`, `options`, `iterator`), the prefix, the first matches, the caret, the entry text and the center of every bar key in device pixels, which is what a tap test needs.
- `assistaccept [name]` accepts a match (the first one by default).
- `assistsheet <all|examples|about>` opens the help sheet on that section. `assistclose` closes it.
- `diag` logs the issues the help found: their codes, which have a fix, and the text they were found in.

### Plots

The plot hooks below live in `js/plot-hooks.js`. The rest of the actions live in `js/test-hooks.js` (its `createTestAction` takes the menu and options sheets from the app). Both drive the same controllers a finger does:
- `plotsweep <dx,dy,frames>` drags at display-frame rate for that many frames and logs how long it took, which is a finger rather than a script stepping through moves.
- `plotpinch <factor>[,<angle>,<shiftX>,<shiftY>]` streams a synthetic two-finger gesture over time, for a device where `tools/inject-pinch.ps1` (the real touch-panel pinch) is not available. The default is a horizontal pinch. `45` is a uniform pinch, `90` a vertical one, and the shifts move the midpoint during the gesture (for example `plotpinch 2,0,80,40` is a pan while x zooms).
- `plothold <dx,dy>`, `plotmove <fraction>` and `plotrelease` do the same step by step and leave the finger down, so a screenshot can catch the frame the canvas draws before any answer arrives.
- `plotlatency <ms>` delays every plot answer, which is how a gesture is checked with the engine behind.
- `plotrefine` asks for a re-sample now instead of waiting for the idle timer (or a denser drawing, for a plot whose domain is fixed) and reports whether one was due, using the coverage the samples really have.
- `expire` drops the engine's plot handles without re-evaluating, so the next request takes the `ExpiredHandle` path. `plotstate` then reports `status: stale` and the canvas keeps panning its cached samples.
- `plotperf` logs what plot frames cost: round trip and canvas paint percentiles, payload bytes, views/refines (with the last re-sample's margin and reason, `pad=<views>/<coverage|resolution>`), the coverage checks and their answers, the pinned box and scale, draws, dropped repaints, sends, failures (`failed=<n>:<ename>: <message>/<kind>`, the kind naming a view or a re-sample) and `geom` - repaints whose scale differed from the previous one (the box is pinned at mount), which is a visual jump of everything the canvas drew and must stay 0 during a gesture. `plotperf reset` clears the counters.
- `plotstate` logs what the first plot's controller believes (append `last` to inspect the newest plot instead): `status` (`live`, or `stale` when the engine no longer knows the handle and the canvas keeps panning its cached scene. A disposed controller is gone and the action reports `none`), `density`, `layer` (a canvas is mounted), `prepared` (the samples decode), `series`, `gesture`, `wanted` (the range the finger left), `scene` (the range the newest scene shows), `shown` (the range in `data-woxi-plot`), `coverage`, `box` and `scale` (the pinned layout and the user-to-pixel scale), the data `mapping`, the scene's `frame` and `rails` (the room the labels and marks need inside the frame), and a `ticks` summary grouped as `axis:kind:labeled` (`a` for an axis tick, `f` for a frame tick).
- `plotscene` logs the scene the canvas is drawing, with coordinates rounded to 0.01 (append `last` for the newest plot): `box`, `frame`, `rails`, `fs`, `lines` (orientation, value and kind), `ticks` (orientation, value, kind, its edge `s`, along-edge position `at`, base, tip, and a labeled tick's `dx`/`dy`/anchor/size) and `texts`. It reads the layer, so it also shows a gesture frame before its markup arrives. Use it to see which side a frame label was put on or how far inside its rail an axis was clamped.
- `rebuild` rebuilds the notebook from the output HTML it keeps, without re-evaluating: what deleting an entry does. A plot comes back with the samples and the scene of the old element (`seedsOf`), so it stays interactive. A plot with no live controller comes back as a still picture, and the next evaluation of its entry gives it a fresh one.

`dump` reports one line per entry: its source, how many SVGs it has, the plot trim (`fit=yes WxH` when the ink trim ran, `fit=scene WxH` when the picture is pinned to its layout box, `fit=raw` when it kept its own box), `plot=<handle>` with the range it shows and whether it can re-sample/densify, a text preview of the output, and how long the engine round trip and the rendering took (`engine=..ms render=..ms json=..B`).

Gestures are measured frame by frame rather than eyeballed:

```pwsh
.\tools\record-gesture.ps1 -Steps 'wait|1500;swipe|540,860,760,860,600;wait|1500;action|plotperf' -Out $Env:TEMP\swipe.mp4
python tools\check-pan-frames.py $Env:TEMP\swipe.mp4 --card 90,560,1070,1200 --montage $Env:TEMP\frames.png
```

`record-gesture.ps1` injects a real touch swipe (`adb shell input swipe`) or a real two-finger pinch (`tools/inject-pinch.ps1`, which writes the panel's multi-touch protocol and needs root), optionally interleaved with app actions. It fails a recording that contains a single frame: that is what a gesture over a static page (no interactive plot, or coordinates that missed it) produces. `record-pan.ps1` does the same for the synthetic `plotsweep`. `check-pan-frames.py` extracts every frame and measures the curve's box and the step it took (cross-correlated, `--limit` px so a periodic curve cannot match its own next period), the picture's background box inside `--card`, and how far the curve stops short of the reference box. It lists still frames, jumping frames and card changes, and `--montage` writes the worst frames side by side. `--from`/`--to` select frames, `--background r,g,b` fixes the picture's fill.

For a single before/after comparison, `tools/check-ink-box.py shot1.png shot2.png ...` prints the box and pixel count of the series color in each screenshot. Two screenshots of the same view - one at rest, one with a finger down and one pixel of movement (which mounts the canvas), then back to the same range - must agree to within a pixel or two: a larger box while the finger is down is the canvas drawing the curve at a different scale than the picture, which is what a gesture reads as a zoom.

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
$Env:WOXI_ADB_SERIAL = 'emulator-5554'       # every tools/*.ps1 honors this
adb -s emulator-5554 root                    # google_apis (not playstore) images allow this
.\tools\inject-pinch.ps1 -Cx 588 -Cy 861 -Gap0 130 -Gap1 30   # real two-finger pinch
```

`tools/inject-pinch.ps1` writes the touch panel's multi-touch protocol directly, with both fingers in two slots of the same touchscreen device. That detail matters: Android only merges fingers that arrive on one device, so writing each finger to a different emulator `virtio_input_multi_touch_N` device produces two independent single-finger streams and the web layer never sees a pinch at all.
