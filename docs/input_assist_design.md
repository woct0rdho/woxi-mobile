# Input assistance: what ships, and what is deliberately left out

Portrait phones only. Measured on the emulator (1080*2400 px, 440 dpi, 393*873 dp. WebView viewport 393*827) or in a host probe against the interpreter.

## The bar

One row, one state, still 47 dp - it is the action bar's first page, so nothing moves:

```
| 1  Plot[Sin[x], {x, -5, 5},          |
*--------------------------------------*
| Eval | f, {x, xmin, xmax} |2/2▾| <- |  signature + argument progress
| Eval | Plot | Plot3D | PlotGrid |+86 |  candidates, dimmed by status
| Eval |{x,-5,5}|{x,0,2 Pi}|  ⚠ 1 | <- |  iterator + an issue
| Eval |  Plot  |  Solve   |  ⚠ 2 | <- |  idle + issues
```

- Signature shows the chosen variant's slots with the current one highlighted. Tapping it moves to the next argument. The `n/m ▾` key opens the call card.
- Candidates show up to three names. `+N` opens the sheet. Names that are not implemented are dimmed, and a parameter of the definition the caret is in comes first with "parameter of this definition".
- Options are the call's own `Options[...]`, with names already written in the call filtered out.
- Iterator offers `{x, -5, 5}` and `{x, 0, 2 Pi}` when the caret is inside an empty `{}` in an iterator slot.
- Issues adds one amber chip (`⚠ 2`) when the engine found something in finished input.

## The sheet

Five tabs, opened by `+N`, `n/m ▾`, `⚠`, or the matches button:
- Matches - the long list, with description, status and documentation category per row.
- Examples - the 28 gallery templates the plot keys used to paste. A tap replaces the entry and runs it.
- Call - the call being edited: the variant in use, one row per slot with its role and the example arguments the gallery actually uses (tapping an example replaces the current argument), the other overloads, the head's options (already-set ones marked), and insert skeleton.
- About - the symbol's home: status (`implemented`, `partial`, `not implemented`, `not supported`), description, attributes spelled out (`HoldAll` -> "arguments are not evaluated"), arity when Woxi has it, insert skeleton, every option with its declared default (tap inserts `Name -> `), the documentation URL, and the entry that defines a user symbol.
- Issues - spelling (`Replace with Plot`), unsupported built-ins, and syntax errors with a byte range. Nothing is shown while the entry is unfinished.

## Long-press, one meaning

Long-press means "do more than a tap", never "run" or "delete":

| Target | Tap | Hold |
|---|---|---|
| Symbol key (plot pages, idle `Plot`/`Solve`) | the name, e.g. `Plot[` | the call with its slots spelled out: `Plot[f, {x, -5, 5}]`, first slot selected |
| Suggestion chip | replace the typed prefix | wrap the selection, or the argument under the caret, in that head (`x^2` -> `Simplify[x^2]`) |
| Anything else | normal key | nothing. The tap still fires |

The keyboard fires the hold after 380 ms, cancels on 10 px of movement (so a flick is still a flick), and suppresses the tap only when the handler actually did something.

## Undo/redo

Programmatic edits (keys, accepted suggestions, auto-closed brackets, skeletons) are invisible to the textarea's own undo stack, so the app keeps one per entry: 30 steps, consecutive typing coalesced into one step (700 ms), and a multi-character edit (a chip, a skeleton) always its own step. `Undo` and `Redo` live on bar page 2 and are dimmed when there is nothing to undo or redo respectively - the state comes from the app's own stack, which is exact, because every edit on this keyboard goes through it (a hardware keyboard's edits are captured by `beforeinput`).

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
- Rare names need a specific query. Names in the tail of the registry (rank 3000 and beyond), and unranked names longer than 20 characters, are matched only when the fragment is four characters, is the exact name, or abbreviates *every* word (`RngFlt`); or when the document already uses the name. Three letters then stay quiet - `Ran` gives `Range`, `RandomReal`, `RandomColor` without `RangeFilter` - while `Rang` or `RngFlt` still reach it.
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

The remaining ambiguity is between neighbours of the same band (`Integer` versus `Integers`, `Contours` versus `ContourPlot`), which alphabetical or length order settles; that is a coin flip, not a wrong answer.

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
| `complete_request` | matches, cursor span, per-item `status` and `kind` |
| `inspect_request` | description, `status`, attributes, arity, `options` and `optionDefaults`, docs URL |
| `is_complete_request` | `complete` / `incomplete` / `invalid` |
| `diagnostics_request` | `status` plus items with severity, code, message and an optional `fix` |
| `prototypes_request` | slot roles, names and examples learned from the examples |
| `definitions_request` | per entry: definitions with ranges and parameters |
| `catalog_request` | symbol count and version (Woxi extension) |

Priorities: NORMAL for everything the user is waiting on, BACKGROUND for the one-off catalogue. Gesture frames still overtake both.

## What is not implemented, and why

- Association keys (`assoc["..."]`). Woxi stores associations in a separate value store. `lookup_env_as_expr` deliberately returns just the symbol for them, so reading the keys would mean evaluating user code while typing. Only a literal `<|...|>` in the same entry could be read safely, which is a narrow enough case to skip for now.
- Go to definition / find references. `definitions_request` already knows where every symbol is defined, so the jump is a small piece of UI work that was not needed for this pass. The About card only reports the entry number.
- Formatting (`lsp::format`, 0.8 ms) is available from the same module but has no key yet.
- Overlay squiggles, bracket matching and ghost text need a mirrored layer under the textarea. Everything above lives in the bar and the sheet instead.
- Keyboard layout changes were proposed but not made: the plot pages still carry their 12 keys each, and no new "pattern" page exists. The only keyboard change so far is `Undo`/`Redo` on bar page 2, plus the hold gesture. `?` still inserts `?`, as before.

## Test hooks

`assist` (state, prefix, matches, caret, text, issues, definitions, bar key positions in device pixels), `assistaccept`, `assistsheet`/`card` (tab), `assistclose`, `type` (set text without evaluating), `press` (a key by label), `caret`, `skeleton`, `wrap`, `diag`, `undo`, `redo`.

Device pixels, not CSS: the WebView is inset by the status bar, so a tap coordinate is `inset.top + css * dpr`.
