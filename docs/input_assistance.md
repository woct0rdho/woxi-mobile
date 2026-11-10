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
- Iterator offers `{x, -5, 5}` and `{x, 0, 2 Pi}` when the caret is inside an empty `{}` in an iterator slot.
- Issues adds one amber chip (`! 2`) when the engine found something in finished input.

## The action bar and the menu

The bar is the keyboard's first two pages, four keys each. The menu is the sheet behind the Menu button. The split follows the notebook apps: the toolbar holds what is used while writing a cell, the menu holds what changes the whole notebook or is rare.

| Bar page | Keys | Why there |
|---|---|---|
| 1 (context) | Eval, the function chips / signature, `<-` | every keystroke updates it |
| 2 (cell) | Undo, Redo, Insert, Delete | no keyboard shortcuts on a phone. Insert and Delete are the two cell edits, next to each other |
| 3 (text) | Cut, Copy, Paste, Format | selection edits, plus normalising the entry |

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
- Letters, digits and operators are not function buttons. They insert their label. A delimiter pair (`( )`, `[ ]`, `{ }`, `" "`) wraps a selection - `(x + 1)` from a selected `x + 1` - which is what a bracket key is for.

The keyboard fires the hold after 380 ms, cancels on 10 px of movement (so a flick is still a flick), and suppresses the tap only when the handler actually did something.

## Backspace

Backspace deletes one character, or a whole empty pair (`()`, `[]`, `{}`, `""`, `<||>`) when the caret sits inside it: `Integrate[]` collapses to `Integrate` in one tap, so a call key doubles as a name key.

## Where the caret is

The bar describes the caret, so the caret has to be known even when the field has no DOM focus. Two facts make that non-obvious on Android:
- A caret-handle drag fires `selectionchange` and nothing else. No click, no keyup, no `select`. The app therefore listens on the document, records the new selection on the entry and refreshes the bar (coalesced at 40 ms, so a drag is one refresh at the end rather than sixty in flight).
- Tapping this keyboard's keys blurs the textarea, and some WebViews then report the selection as 0. Every entry therefore keeps its own `caret`/`selStart`/`selEnd`, updated on `selectionchange`, `keyup`, `click`, `select`, `focus`, `input` and every programmatic edit. A focused field is still the source of truth. A blurred one acts on the recorded copy.

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

Why not the editor models? VSCode pushes an undo stop from every cursor-moving command (`pushStackElement` in `coreCommands.ts`), so a typing run between caret moves is one step. Vim groups per typed command (`:help undo-blocks`), which for `i ... Esc` is the whole insert. Both are tuned for a keyboard and a large file. Here every key is an explicit tap on a short expression, and the common repair is "undo the last name/number I tapped", so the step is the word. `Ctrl-G u`-style finer control has no key on this keyboard. A shorter pause is the way to ask for a smaller step.

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
- Rare names need a specific query. Names in the tail of the registry (rank 3000 and beyond), and unranked names longer than 20 characters, are matched only when the fragment is four characters, is the exact name, or abbreviates every word (`RngFlt`), or when the document already uses the name. Three letters then stay quiet - `Ran` gives `Range`, `RandomReal`, `RandomColor` without `RangeFilter` - while `Rang` or `RngFlt` still reach it.
- "Already used" is remembered by the engine. It collects builtin names with Woxi's tokenizer from every evaluated statement and from the text of each typing-help request, so a name written once in the notebook outranks the prior in every later entry.
- Package-qualified names and system variables last. `Context`Symbol` and `$Name` are real, but they are not what a phone user is typing. They stay in the sheet, after the plain names of the same tier.

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

The remaining ambiguity is between neighbours of the same band (`Integer` versus `Integers`, `Contours` versus `ContourPlot`), which alphabetical or length order settles. That is a coin flip, not a wrong answer.

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

Seven messages, one envelope (`{msg_type, content}` in, `{msg_type, status, content}` out), all history-neutral:

| Message | Answer |
|---|---|
| `complete_request` | matches, cursor span, per-item `status`, `kind`, `type` (`function`/`variable`) and `arity` when Woxi knows it |
| `inspect_request` | description, `status`, attributes, arity, `options` and `optionDefaults`, docs URL |
| `is_complete_request` | `complete` / `incomplete` / `invalid` |
| `diagnostics_request` | `status` plus items with severity, code, message and an optional `fix` |
| `prototypes_request` | slot roles, names and examples learned from the examples |
| `definitions_request` | per entry: definitions with name range, full range and parameters |
| `format_request` | the formatted text of each code, through Woxi's formatter |
| `catalog_request` | symbol count and version (Woxi extension) |

Priorities: NORMAL for everything the user is waiting on, BACKGROUND for the one-off catalogue. Gesture frames still overtake both.

## What is not implemented, and why

- Association keys (`assoc["..."]`). Woxi stores associations in a separate value store. `lookup_env_as_expr` deliberately returns just the symbol for them, so reading the keys would mean evaluating user code while typing. Only a literal `<|...|>` in the same entry could be read safely, which is a narrow enough case to skip for now.
- Go to definition is in the menu and in the About card. "Find references" is still absent (the jump is the useful half).
- Overlay squiggles, bracket matching and ghost text need a mirrored layer under the textarea. Everything above lives in the bar and the sheet instead.
- Keyboard layout changes were proposed but not made: the plot pages still carry their 12 keys each, and no new "pattern" page exists. The only keyboard change so far is `Undo`/`Redo` on bar page 2, plus the hold gesture. `?` still inserts `?`, as before.

## Test hooks

`assist` (state, prefix, matches, caret, the stored selection, text, issues, definitions, bar key positions in device pixels), `assistaccept`, `assistsheet`/`card` (tab), `assistclose`, `type` (set text without evaluating), `press` (a key by label), `caret` (`<at>` or `<start>,<end>`), `skeleton`, `wrap`, `diag`, `undo`, `redo`, `format`, `formatall`, `godef`.

Device pixels, not CSS: the WebView is inset by the status bar, so a tap coordinate is `inset.top + css * dpr`.
