# Input Assistance

Portrait phones only. Measured on the emulator (1080*2400 px, 440 dpi, 393*873 dp. WebView viewport 393*827) or in a host probe against the interpreter.

## The bar

One row, one state, still 47 dp - it is the action bar's first page, so nothing moves:

```
| 1  Plot[Sin[x], {x, -5, 5},          |
*--------------------------------------*
| Eval | f, {x, xmin, xmax} |2/2 v| <- |  signature + argument progress
| Eval | Plot | Plot3D | PlotGrid |+86 |  candidates, dimmed by status
| Eval |{x,-5,5}|{x,0,2 Pi}|  ! 1 | <- |  iterator + an issue
| Eval |  Plot  |  Solve   |  ! 2 | <- |  idle + issues
```

- Signature shows the chosen variant's slots with the current one highlighted. Tapping it moves to the next argument. The `n/m v` key opens the call card.
- Candidates show up to three names. `+N` opens the sheet. Names that are not implemented are dimmed, and a parameter of the definition the caret is in comes first with "parameter of this definition". When completion applies but has no answer, the bar shows the default action row instead of an empty one.
- Options are the call's own `Options[...]`, with names already written in the call filtered out.
- Iterator offers `{x, -5, 5}` and `{x, 0, 2 Pi}` when the caret is inside an empty `{}` in an iterator slot. A chip fills that pair (it replaces the `{}`, it is not inserted between the braces).
- Issues adds one amber chip (`! 2`) when the engine found something in finished input. A warning belongs to the text it was found in, so it disappears as soon as the text changes.

The state is chosen by the caret's context, in this order: inside a string or a comment (or after `->`) nothing applies. A name being typed is always completion (a `Fra` in a call's options slot completes `Frame`, it does not show option rows). An empty argument past the last declared one is the options slot. An empty iterator `{}` is the iterator row. Any other caret inside a call is the signature. Outside a call the bar is idle. `Assist.contextFor` is the one place that decides this.

The requests that fill a state (completion, options, diagnostics) never switch it. A late answer is applied only while the caret still asks for it: a completion list is dropped when the prefix is no longer before the caret, an options answer when the caret moved out of the options slot, and a warning is dropped when the text changed. A repaint from a late warning (`refreshBar`) follows the same context decision, so a warning arriving while the iterator row is showing adds its `!` chip to that row instead of turning it back into the signature.

## The action bar and the menu

The bar is the keyboard's first two pages, four keys each. The menu is the sheet behind the Menu button. The split follows the notebook apps: the toolbar holds what is used while writing a cell, the menu holds what changes the whole notebook or is rare.

| Bar page | Keys | Why there |
|---|---|---|
| 1 (context) | Eval, the function chips / signature, `<-` | every keystroke updates it |
| 2 (cell) | Undo, Redo, Insert, Delete | no keyboard shortcuts on a phone. Insert and Delete are the two cell edits, next to each other |
| 3 (text) | Cut, Copy, Paste, Format | selection edits, plus normalizing the entry |

The clipboard keys read and write the Android clipboard, the same one the hardware Ctrl+C/X/V use: the bridge is an access path (the Web clipboard APIs need permissions and user activation a WebView does not reliably give), not a second clipboard.

| Menu | Why not the bar |
|---|---|
| New notebook, Open, Save, Save as | file-level, rare |
| Evaluate notebook | JupyterLab Run > Run All / Mathematica Evaluation > Evaluate Notebook: notebook-wide, slow, done once |
| Format notebook | the notebook-wide counterpart of the bar's Format |
| Go to definition | navigation, used occasionally. The About card also has a tappable "defined in entry N" |
| Duplicate entry, Clear entry | they create or wipe a whole cell (JupyterLab has both in Edit, not the toolbar) |

Four keys per page is not a style choice: the bar is a `repeat(4, 1fr)` grid 47 px high, so a fifth key lands in a second row that is clipped. That is how Delete disappeared when Undo/Redo were added.

Every page is defined in `keyboard.js`'s `BARS`. Only page 1 is replaced at run time (the assistance chips). Page 2's buttons do not change, only their state: the app answers `handlers.keyState` with `dim` for Undo/Redo when the entry's history is empty, and `refreshKeyStates` rewrites the classes of the buttons on screen without replacing them (a button that disappears under a finger never fires its click).

## The sheet

Five tabs, opened by `+N`, `n/m v`, `!`, or the matches button:
- Matches - the long list, with description, status and documentation category per row.
- Examples - the 28 gallery templates the plot keys used to paste. A tap replaces the entry and runs it.
- Call - the call being edited: the variant in use, one row per slot with its role and the example arguments the gallery actually uses (tapping an example replaces the current argument), the other overloads, the head's options (already-set ones marked), and insert skeleton.
- About - the symbol's home: status (`implemented`, `partial`, `not implemented`, `not supported`), description, attributes spelled out (`HoldAll` -> "arguments are not evaluated"), arity when Woxi has it, insert skeleton, every option with its declared default (tap inserts `Name -> `), the documentation URL, and the entry that defines a user symbol.
- Issues - spelling (`Replace with Plot`), unsupported built-ins, and syntax errors with a byte range. Nothing is shown while the entry is unfinished.

## Function buttons: one meaning, everywhere

Every key and chip whose label is a Wolfram function does the same two things, whether it sits on a pad page, in the action bar or in the completion row:

| | No selection | Selection |
|---|---|---|
| Tap | insert the call with empty brackets, caret inside (`Integrate[]`) | replace the selection with the same |
| Hold | insert the call with every slot named, wrapping the operand to the right of the caret (`Plot[Sin[x], {x, -5, 5}]`) | wrap the selection (`Plot[x^2, {x, -5, 5}]`) |

Details that keep it predictable:
- Chips also replace the name being typed on both presses. A pad key leaves the text before the caret alone. With a selection, the chip replaces the typed name and the selection.
- "The operand to the right" is a function call, an identifier, a number, a string or a bracketed group, measured by bracket matching. Nothing to the right means the placeholders stay and the first one is selected. The left side is never guessed: selecting it is the way to wrap it (`x + 1 // N` is the usual composition).
- No call shape lives in a key. The tap always inserts `Name[]`. The arguments a function needs come from the assist's prototypes (`prototypes.js`), so a chip, a pad key and the sheet's insert skeleton cannot disagree. The old `D[|, x]`, `If[|, , ]` key shapes moved there.
- A function whose arity is exactly zero (`NotebookDirectory`, the Mathieu group symbols) cannot wrap anything: the hold falls back to the tap, so `NotebookDirectory[]` is inserted and the text to the right is left alone.
- Constants and literals keep the tap meaning on hold. `Pi`, `E`, `Infinity`, `$Name`, a session variable or an iterator chip such as `{x, -5, 5}` are values, not calls. Holding them does nothing extra. `Break[]`-style keys have no argument to spell out, so they behave the same way.
- An option symbol is a name, not a call. Accepting `Axes` inserts `Axes`, never `Axes[]`. In a call's options region it inserts `Axes -> ` instead (the same edit as the options row's chips). The engine marks option symbols from `engine/data/option_symbols.txt`, generated from Woxi's own `Options[f]` declarations, so it can tell `Axes` from `Sin` even when the caret is not in a call. A zero-argument function still gets its brackets (`NotebookDirectory[]`), because `[]` is what makes it evaluate.
- A hold with no second action is performed on release, as the tap it is. Performing it while the finger is still down looks the same to the user but not to the WebView: the end of the gesture takes the focus and the caret away from the text the press just placed (`Sin` on an empty entry, `Plot`'s selected placeholder).
- Letters, digits and operators are not function buttons. They insert their label. A delimiter pair (`( )`, `[ ]`, `{ }`, `" "`) wraps a selection - `(x + 1)` from a selected `x + 1` - which is what a bracket key is for.

The keyboard fires the hold after 380 ms, cancels on 10 px of movement (so a flick is still a flick), and replaces the click when the hold wrote something itself or when the release performs the tap it turned out to be.

## Backspace

Backspace deletes one character, or a whole empty pair (`()`, `[]`, `{}`, `""`, `<||>`) when the caret sits inside it: `Integrate[]` collapses to `Integrate` in one tap, so a call key doubles as a name key.

## Where the caret is

The caret is the textarea's own, drawn by the WebView. The app does not draw a second one. Two Android facts decide whether it is visible:
- A caret is drawn only while the window has the focus, and a WebView takes the window focus only when a finger lands in it. A notebook that has just opened - or one whose menu, sheet or file picker has just closed - can have a focused textarea (`document.activeElement`) and still show no caret at all. `focusEntry` therefore asks the shell for the window focus (`WoxiNative.focusWebView`, `WebView.requestFocus()`) whenever it is missing, at boot and after a notebook is opened, so the caret is there before the first tap in the text.
- Pressing a control gives that control the DOM focus, and a focused button draws no caret. Every key, every sheet row and the Menu/Options buttons cancel the press's default action (the `keepFocus` helper, or the same listener written into each key), so the entry keeps the focus while the user types, opens a sheet or accepts a suggestion. `closeSheet` gives the focus back when something else took it (the native file picker, a window switch).

With the focus kept, the field's own selection is the source of truth for the bar, for every key and for copy/cut. A caret moved with the handle and a range dragged over text are the same native selection the next key replaces or wraps, exactly as native typing would, and a tap in the textarea and a key press act on the same caret.

Two mechanical details make that hold:
- A caret-handle drag fires `selectionchange` and nothing else. No click, no keyup, no `select`. The app therefore listens on the document, records the new selection on the entry and refreshes the bar (coalesced at 40 ms, so a drag is one refresh at the end rather than sixty in flight).
- A command writes the value and then places the caret, which the native code does not follow: a caret below the last visible line of a capped field would sit outside the box, in a field scrolled to its start. `revealCaret` recycles the focus (blur, then focus - without `preventScroll`, which cancels the scroll inside the field too) after the value has grown, and only for a focused field whose content overflows, so a caret that is already on screen stays put.

A field can still lose the focus on purpose: a plot drag or a `Manipulate` slider owns the finger. Every entry keeps its own `caret`/`selStart`/`selEnd`, updated on `selectionchange`, `keyup`, `click`, `select`, `focus`, `input` and every programmatic edit, and the next key or command gives the field the focus back (`focusInput`) before it edits, so the caret reappears where the text went. A rebuilt entry (insert, delete, duplicate, open) puts its stored selection back, so rebuilding no longer drops the caret at the end of the text.

One reader (`selectionOf`) serves every path that inserts, deletes, copies or accepts, so those cannot drift apart again. A function key or a suggestion replaces a selection on a tap and wraps it on a hold, which is why the bar can happily show completion for the text before a selection (`sxyz` with `xyz` selected completes `s`).

Requests carry the caret they were computed for, not a fresh read when the answer is due: a drag can move the caret while a completion waits out its 50 ms debounce, and a reply for another position would describe the wrong text.

## Undo/redo

Programmatic edits (keys, accepted suggestions, auto-closed brackets, skeletons) are invisible to the textarea's own undo stack, so the app keeps one per entry: 100 steps, and one step is one word of the expression - an identifier, a number, an operator, or one structural edit (a chip, a skeleton, a bracket pair). `Sin[x] + 1` therefore undoes as `1`, `Sin[x]`, `[]`, `Sin`, not as the whole entry at once, and a backspace run undoes word by word.

A step ends at:
- a separator character (whitespace, `,` `;` brackets, `+ - * / ^ = ! & | @ # : " ~ ? %`), so typing `x+1` gives `x+` and `1` - identifier characters (`_`, `$`, `` ` ``) are not separators, so `x_`, `$Name` and `Ctx`Name` stay whole.
- a pause (700 ms), which is a new thought.
- a caret jump: a key pressed somewhere other than where the last step ended starts a new step.
- a kind change: typing, deleting, and a structural edit never merge with each other.
- a selection: replacing one is always its own step.

The snapshot also keeps the selection it replaced, so undo puts a replaced selection back (as VSCode does). Redo does the same in reverse. `Undo` and `Redo` live on bar page 2 and are dimmed when there is nothing to undo or redo respectively - the state comes from the app's own stack, which is exact, because every edit on this keyboard goes through it (a hardware keyboard's edits are captured by `beforeinput`).

Why not the browser's stack? Every in-app key writes the textarea's value from script, which the browser's undo stack does not see at all. It also dies with the textarea on every notebook rebuild (inserting or deleting an entry), and it exposes no `canUndo`/`canRedo` for the bar's dim state. The hardware shortcuts are routed to this stack instead (see Hardware keyboard), so the field never has two histories.

Why not the editor models? VSCode pushes an undo stop from every cursor-moving command (`pushStackElement` in `coreCommands.ts`), so a typing run between caret moves is one step. Vim groups per typed command (`:help undo-blocks`), which for `i ... Esc` is the whole insert. Both are tuned for a keyboard and a large file. Here every key is an explicit tap on a short expression, and the common repair is "undo the last name/number I tapped", so the step is the word. `Ctrl-G u`-style finer control has no key on this keyboard. A shorter pause is the way to ask for a smaller step.

## Hardware keyboard

A physical keyboard edits the same entry as the app keyboard: Android hands printable keys to the active IME connection, so the WebView applies them itself and the page learns about the text through `beforeinput`/`input` (the key event it also gets is `Unidentified`). That means the caret, the selection, the assist bar and the clipboard are the native ones, and the two input methods interleave freely: a letter typed after the `Sin` key lands inside `Sin[]`, and an in-app key pressed while Shift+arrows made a selection replaces that selection exactly like a tap.

| Key | What it does |
|---|---|
| characters, Backspace/Delete, arrows, Home/End | native editing. Each edit is recorded by `beforeinput` as one step of the app's history, so the bar's Undo/Redo stay exact |
| Enter | the Eval key (`submitActive`) |
| Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y | the app's Undo/Redo, so there is one history |
| Ctrl+A / Ctrl+C / Ctrl+X / Ctrl+V | native editing, on the same Android clipboard as the bar's Cut/Copy/Paste |
| Tab / Shift+Tab | kept in the entry: a focused key draws no caret and swallows the next letter |
| Escape | closes the sheet on top (the assistance sheet first, then Menu/Options), like Android's Back |

A modal sheet (Menu, Options) blurs the entry while it is open. Otherwise a physical keyboard edits the page behind the sheet - invisibly, and through the IME, where `preventDefault` on the key event does not reach (the text arrives as a commit, not as a key press). Closing the sheet restores the caret and the selection. The assistance sheet is deliberately not modal to typing: its list filters as the entry changes.

What is not the same as the app keyboard:
- The bar's Delete deletes the entry. The hardware Delete deletes the next character, as in any text field. (The hardware Backspace is the bar's `<-`.)
- A physical `Sin` types the letters. It does not insert the call. The completion bar offers `Sin[]` as it does after app-key typing.
- Shift and Caps Lock are the platform's: they do not light the app keyboard's Shift key and do not change what its keys insert. The app's letters page keeps its own one-shot/locked state.
- Shift+Enter is not intercepted (the app keyboard has no newline key), so the field inserts a newline where the WebView reports the Shift modifier. Enter alone evaluates.
- IME composition (a CJK keyboard, predictive text) is not treated specially: each composition update is one undo step.

## Matching: finding a name without noise

The matcher is tiered, because a phone bar shows three suggestions and a sheet shows a page: the order decides whether the feature helps or gets in the way. VSCode's fuzzy scorer and fzf's boundary bonuses were the reference, but Wolfram names have one useful structure - CamelCase words - and that is what the tiers exploit.

| Tier | Query | Example | Why |
|---|---|---|---|
| 0 | exact name, any case | `sin` | `Sin` |
| 1 | prefix | `Plo` | `Plot`, `Plot3D`, ... |
| 2 | CamelCase initials, closest initials first | `PP` | `PlotPoints` before `PrimePi` |
| 3 | substring at a word start | `Range` | `PlotRange`, `DataRange` |
| 4 | abbreviation of whole words: the query splits at its capitals and each piece must start a word, skipping letters inside it | `Rng`, `PltRng`, `pts` | `Range`, `PlotRange`, `...Points` |
| 5 | substring anywhere (last resort) | `otran` | `PlotRange` |

Within a tier, the frequency prior decides. Woxi's registry sorts its symbols by how fundamental they are (`List` 1, `Rule` 2, `Times` 3, ... `Plot` 21, `Sin` 22), which is the closest thing to a usage count it has. The engine vendors that table (`engine/data/functions.csv`, copied verbatim, only the `name` and `rank` columns are read) and bands it: the first hundred share a band, then one band per thousand, and unranked names come last. So `pts` gives `PlotPoints`, not `PetersenGraph`, and `ListP` gives `ListPlot` before `ListPlay` - both are the registry's answer, not a guessed popularity list.

Noise rules, each of which came from a query that went wrong:
- Substrings need three characters. Two letters are everywhere: `pl` appears inside every `...Plot` name, and `pp` inside `Append`.
- An abbreviation must start words. `pts` reads `...Points` or `Petersen`, but it cannot pick letters across word middles, which is what a plain fuzzy subsequence does and what made `Plo` return 400 names.
- The weak tiers are a fallback. They appear only when the sharper tiers leave fewer than three candidates, so typing a prefix never grows a fuzzy tail.
- Rare names need a specific query. Names in the tail of the registry (rank 3000 and beyond), and unranked names longer than 20 characters, are matched only when the fragment is four characters, is the exact name, or abbreviates every word (`RngFlt`), or when the notebook already uses the name. Three letters then stay quiet - `Ran` gives `Range`, `RandomReal`, `RandomColor` without `RangeFilter` - while `Rang` or `RngFlt` still reach it.
- "Already used" is remembered by the engine. It collects builtin names with Woxi's tokenizer from every evaluated statement and from the text of each typing-help request, so a name written once in the notebook outranks the prior in every later entry.
- Package-qualified names and system variables last. `Context`Symbol` and `$Name` are real, but they are not what a phone user is typing. They stay in the sheet, after the plain names of the same tier.
- In a call's options region, that call's own options come first. The frontend knows when the caret is past the last argument of a call (the same context that shows the options row) and sends the head and the options already written with the completion request. The engine asks Woxi for `Options[head]` (cached for builtins) and breaks ties inside the tier: an option the call does not name yet, then one it already names (repeating it is legal but rarely intended), then everything else. A better match still wins, so an option cannot outrank the name actually being typed, and the rare-name gate is skipped for options - the call has already said they are valid here. `Options[f]` is the only per-function option data Woxi ships, and its coverage is uneven (`Plot` declares about sixty, `Plot3D` declares none), so the boost only applies where Woxi knows the options.

Results on the device, which is how the rules were tuned:

| Typed | First suggestions |
|---|---|
| `sin` | `Sin`, `Sinc`, `Sinh` |
| `Tbl` | `Table`, `TableForm`, `ParallelTable` |
| `manip` | `Manipulate`, `Manipulator`, `ManipulateVideo` |
| `Dens` | `DensityPlot`, `DensityPlot3D`, `DensityHistogram` |
| `Plt` | `Plot`, `ListPlot`, `PlotRange` |
| `PP` | `PlotPoints`, `PrimePi`, `PolarPlot` |
| `pts` | `PlotPoints`, `StreamPoints`, `FourierParameters` |
| `ListP` | `ListPlot`, `ListPlot3D`, `ListPointPlot3D` |
| `Vec` | `VectorQ`, `VectorPlot`, `VectorAngle` |
| `Int` | `Integrate`, `Integer`, `IntegerQ` |
| `Rng` | `Range`, `PlotRange`, `DataRange` |
| `Rng` with `RangeFilter` used earlier in the entry | `RangeFilter`, `Range`, `PlotRange` |
| `Ran` / `Rang` | `Range`, ... / `Range`, `RangeFilter`, `PlotRange` |
| `Fr` inside `Sin[` | `Frame`, `FreeQ`, `Framed`, `FrameLabel` - no options context, so no boost |
| `Fr` in `Plot[Sin[x], {x, -5, 5}, ` | `Frame`, `FrameLabel`, `FrameStyle`, `FrameTicks`, `FrameTicksStyle`, then `FreeQ` |
| `Fra` after `Frame -> True, ` | `FrameLabel`, `FrameStyle`, `FrameTicks`, `FrameTicksStyle`, then `Frame` (already set), then `Framed` |
| `Frame` after `Frame -> True, ` | `Frame` (an exact name still wins), then the other options |
| `As` in `Sum[i, {i, 1, 10}, ` | `Assumptions` (a `Sum` option) first |

The remaining ambiguity is between neighbors of the same band (`Integer` versus `Integers`, `Contours` versus `ContourPlot`), which alphabetical or length order settles. That is a coin flip, not a wrong answer.

## Prototypes, roles and examples

Woxi's registry has a one-line description, sometimes an arity, real options and attributes, but no parameter names and no usage patterns. So:
- ~60 functions have curated slot names per variant (one or two overloads each), written as `Plot: ['f, {x, xmin, xmax}', '{f1, f2, ...}, {x, xmin, xmax}']`.
- The engine learns the rest from the gallery: `prototypes_request` parses every example and classifies each argument by shape - an iterator (`{x, -2 Pi, 2 Pi}`, whose first element names the variable the other slots use), an option (a rule), a data list (all numbers), a list of functions, or an expression. It returns slot roles, slot names and the concrete examples, and the client merges them into the curated table (curated names win, learned examples are added).
- Roles are shapes, not types: `expression`, `iterator`, `option`, `options`, `number`, `data`, `list`, `symbol`. There are no types to show, and inventing them would mislead exactly the users this is for.
- Variant choice uses the number of arguments already typed: the largest variant that still fits, else the smallest. Extra arguments are options, so they do not switch the variant.

## Session awareness

- Parameters of the definition the caret is in lead the completion list. `definitions_request` sends every entry's text once (debounced) and answers, per entry, each definition's name, kind, byte range and the pattern names on its left-hand side (parsed with Woxi's own parser, so `f[x_, y_]` gives `x` and `y`).
- Session symbols already come from the engine (`get_defined_names`), so a function defined three entries up completes with no extra work. The About card adds "defined in entry N" when it can see the definition.

## Diagnostics

`diagnostics_request` runs Woxi 0.4's own analysis (`lsp::analysis`), in-process:
- gating: the engine reports `status: incomplete` and returns no items for unfinished input, so a half-typed call never turns amber.
- debounce: 350 ms after the last keystroke, only when the text changed.
- kinds: `spelling` (with a `fix` edit built from `spelling_suggestion`), `unsupported` (a built-in Woxi does not run), `syntax` (shown with our own wording and a byte range, never the grammar's rule names).
- pull-only: the engine never pushes, because a push would interrupt an edit.

## Protocol

Eight messages, one envelope (`{msg_type, content}` in, `{msg_type, status, content}` out), all history-neutral:

| Message | Answer |
|---|---|
| `complete_request` | matches, cursor span, per-item `status`, `kind`, `type` (`function`/`variable`), `arity` when Woxi knows it, `option` (an option symbol such as `Axes`) and `callOption` (an option of the call in context, which accepts with `->`). In a call's options region the request also carries `context_head` and `context_used`, which rank that call's `Options[...]` first |
| `inspect_request` | description, `status`, attributes, arity, `options` and `optionDefaults`, docs URL |
| `is_complete_request` | `complete` / `incomplete` / `invalid` |
| `diagnostics_request` | `status` plus items with severity, code, message and an optional `fix` |
| `prototypes_request` | slot roles, names and examples learned from the examples |
| `definitions_request` | per entry: definitions with name range, full range and parameters |
| `format_request` | the formatted text of each code, through Woxi's formatter |
| `catalog_request` | symbol count and version (Woxi extension) |

Priorities: NORMAL for everything the user is waiting on, BACKGROUND for the one-off catalog. Gesture frames still overtake both.

## What is not implemented, and why

- Association keys (`assoc["..."]`). Woxi stores associations in a separate value store. `lookup_env_as_expr` deliberately returns just the symbol for them, so reading the keys would mean evaluating user code while typing. Only a literal `<|...|>` in the same entry could be read safely, which is a narrow enough case to skip for now.
- Option values in the bar (`Frame -> ` -> `True`/`False`, `PlotRange -> ` -> `{Full, Automatic}`, ...). The idea is a row like the iterator row: chips that insert the value verbatim, strings and lists included, rather than completing a name. The blocker is data, not UI. Woxi exposes only `Options[f]`, one declared default per option (`Frame` -> `False`, `Axes` -> `True`, `PlotRange` -> `{Full, Automatic}`). Its LSP, documentation and source have no per-option set of allowed values and no `AllowedValues`-style API. A row could start from that default, the boolean counterpart, and the values the notebook or the examples already used for the option, but it would be incomplete and sometimes misleading (`Axes -> False` is valid; `Method -> "..."` or a plot range's forms are not enumerable). A complete list needs an upstream API/table or a curated table with a stated provenance; parked until one of those exists.
- Go to definition is in the menu and in the About card. "Find references" is still absent (the jump is the useful half).
- Overlay squiggles, bracket matching and ghost text need a mirrored layer under the textarea. Everything above lives in the bar and the sheet instead.
- Keyboard layout changes were proposed but not made: the plot pages still carry their 12 keys each, and no new "pattern" page exists. The only keyboard change so far is `Undo`/`Redo` on bar page 2, plus the hold gesture. `?` still inserts `?`, as before.

## Test hooks

`assist` (state, context decision, prefix, matches, caret, the stored selection, text, issues, definitions, bar key positions in device pixels), `assistaccept`, `assistsheet`/`card` (tab), `assistclose`, `type` (set text without evaluating), `press` (a key by label), `caret` (`<at>` or `<start>,<end>`), `focus` (window focus, DOM focus and the entry's selection), `skeleton`, `wrap`, `diag`, `undo`, `redo`, `format`, `formatall`, `godef`.

Device pixels, not CSS: the WebView is inset by the status bar, so a tap coordinate is `inset.top + css * dpr`.
