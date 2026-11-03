# Input assistance for the portrait phone UI

Implemented. This is the design the code follows, with the numbers measured on the emulator (1080*2400 px, 440 dpi, 393*873 dp) and the places where the implementation diverged from the first sketch.

## Measured starting point

The WebView is inset by the status bar, so its viewport is 393*827 CSS px (dpr 2.75). With the keyboard up, the screen splits like this:

```
   0 px *------------------------------*
        | status bar                   |
  66 px *------------------------------*
        | Untitled          Menu  Opts |  top bar
 156 px *------------------------------*
        | 1  [ entry textarea        ] |  entry (38 dp min, up to 45 vh)
        |                              |
        |  notebook output             |  ~430 dp visible
        |                              |
1573 px *------------------------------*
        | Eval  Plot  Solve       <-   |  action bar, 47 dp  <- now the assist bar
1639 px *------------------------------*
        | Sin   x     7  8  9  /  ()   |
        | Cos   y     4  5  6  *  ^    |  4 key rows * 40 dp
        | Tan   T     1  2  3  - Sqrt  |
        | Log   =     ,  0  .  +  []   |
2340 px *------------------------------*
```

Two numbers drive the design: the keyboard takes 255 dp (31 % of the WebView), leaving about 430 dp of notebook above it, and the action bar is 47 dp of nearly empty space sitting exactly where a thumb rests. A hint surface costs nothing if it lives in that row, and a lot if it needs a new row or an overlay.

## What other apps do

- Acode (Android): a scrollable accessory row above the keys (Ctrl, Alt, Shift, Tab, arrows, Esc). Right position and reach, wrong contents: modifier keys are desktop leftovers a phone keyboard cannot chord, and they use up the only free row.
- Juno (iPad): no completion popup at all. A floating Run button over the editor and a side panel for variables. Lesson: the run action deserves one big fixed target, and reference material belongs in a panel.
- Ace / VS Code web / CodeAssist on phones: completion lists anchored to the caret. They get clipped by the keyboard, need arrow keys or a mouse, and the rows are far below the 44 dp touch target. Do not anchor anything to the caret on a phone.
- Desmos and graphing calculators: function keys insert templates with placeholder slots and the caret walks through them. There is no completion list. Fine for beginners, but the template is opaque and hard to edit afterwards.
- Gboard: the suggestion strip is the canonical mobile completion: a few chips, one tap, never covers content, always in the same place, learns from use. Strip first, list second.
- Swift Playgrounds: inline ghost text accepted by one dedicated key.

Conclusion taken: suggestions live in a fixed strip next to the keys, with a sheet for browsing, and the custom keyboard is an advantage because accept and next-slot can be ordinary keys whose labels change with the state.

## Layout: the assist bar is the action bar

The action bar's first page became the context page. It is still 47 dp, so no plot and no line of output moved. Its four columns are now weighted by the state (`grid-template-columns` from the keys themselves), which is how five or six keys fit when there is more to say.

```
        | 1  Plot[                     |
        |  (earlier entries + outputs) |
        *------------------------------*
        | Eval | f, {x,xmin,xmax} |v|<-|   signature
        | Eval | Plot | Plot3D | +N |<-|   candidates
        | Eval |{x,-5,5}|{x,0,2Pi}|v|<-|   iterator
        | Eval | Plot | Solve |      <-|   idle (as before)
```

- Fixed zones: `Eval` on the left, the context in the middle, `v` (all matches) and backspace on the right. Nothing else may claim space. The keys get narrower instead.
- Bottom sheet (opened by `v`, or by `assistsheet` in tests): up to 52 vh, grab-handle feel, 44 dp rows with name, one-line description and a category or "not implemented" note. The scrim stops above the keyboard, so typing keeps narrowing the list while it is open. It never takes focus.
- Tabs: Matches (live), Examples (the templates the plot keys used to paste), About (name, description, arity, options, documentation URL, all from the engine).

## States

| State | Trigger | Content |
|---|---|---|
| Idle | no call, no name being typed | `Plot` `Solve` as before, plus backspace |
| Signature | caret inside a call with a known prototype | `f, {x, xmin, xmax}` with the current argument highlighted. Tapping it advances to the next argument |
| Candidates | a name prefix of one or more letters | up to three chips, plus `+N` when more exist |
| Options | past the positional arguments of a known call | the call's own option names, filtered by what is typed |
| Iterator | caret inside an empty `{}` in an iterator slot | `{x, -5, 5}`, `{x, 0, 2 Pi}`, ... |

## Interaction rules, as built

- Nothing is inserted without a tap, and nothing is evaluated while typing.
- Accept replaces the typed prefix (`Plo` -> `Plot`). A call name also opens its bracket (`Plot[`), because that is two keys the thumb does not have to find. The signature bar takes over next.
- The bracket keys insert pairs, so accepting a name inside an empty pair fills it instead of nesting a second one: `Plot[Sin[x], {` + `{x, -5, 5}` yields `Plot[Sin[x], {x, -5, 5}`, not `{{x, -5, 5}}`.
- `Eval` finishes unfinished input: `is_complete_request` answers `incomplete` and the missing closers are appended to the text (visible, not hidden), so `Plot[x, {x, 0, 1` plots instead of inserting a newline.
- The bar keeps its buttons: identical key lists do not re-render, because a button that disappears between touchstart and click never fires. This was the bug that made the first build's chips inert under a real finger.
- The caret survives a blur: tapping a key can blur the textarea, and some WebViews reset `selectionStart` to 0 when that happens, so the caret is read from the entry's own record unless the field is focused.
- Long names ellipsize in chips. The sheet always shows them in full.

## Where the content comes from

Everything about symbols is the engine's, over Jupyter-shaped messages. Nothing is duplicated in the frontend.

| Need | Source | Cost |
|---|---|---|
| matches, ranked | `complete_request` | 0.2-2 ms warm, incl. JSON |
| implemented / not implemented | the same reply (`is_known_wolfram_function`) | free |
| description, arity, options, docs | `inspect_request` | 0.2-1 ms, and it does not touch `Out[]` |
| "is the entry finished" | `is_complete_request` | parse only |
| how many symbols are indexed (for the empty sheet) | `catalog_request` | once, lazily |

Ranking is exact name, prefix, camel-case initials (`PP` -> `PlotPoints`), then a subsequence that must start at the name's first character. Session variables come first, unimplemented names last and dimmed. A loose subsequence was tried first and produced 400 matches for `Plo`, which is why it is anchored.

Parameter names do not exist in Woxi's data, so the ~40 prototypes in `assist.js` are presentation only. They place the caret by counting commas in what the user typed and never validate anything. Option names, in contrast, are the call's real `Options[...]`.

## Protocol

Same envelope as the plot messages (`{msg_type, content}` in, `{msg_type, status, content}` back):
- `complete_request {code, cursor_pos, limit}` -> `complete_reply {matches, cursor_start, cursor_end, metadata}`. Descriptions ride in `metadata._jupyter_types_experimental`, the flags and documentation in `metadata._woxi`, the untruncated count in `metadata.total`.
- `inspect_request {code, cursor_pos}` -> `inspect_reply {found, data: {"text/plain": ...}, metadata: {_woxi: {name, description, implemented, category, doc, arity, options}}}`.
- `is_complete_request {code}` -> `is_complete_reply {status, indent}` with `complete`, `incomplete` or `invalid`.
- `catalog_request {}` -> `catalog_reply {version, total}`. Explicitly a Woxi extension. Jupyter has no message for the whole namespace, and a dump of 6290 names per keystroke would be absurd. The sheet shows it when it has nothing else to say ("6290 symbols from Woxi 0.1.0 - type a name.").

Priorities: completion and inspection are NORMAL (they must not drop queued background re-sampling, and a gesture frame still overtakes them). The catalog is BACKGROUND.

## Replacing the example snippets

The plot keys now insert the call itself: `Plot`, `ContourPlot`, `Plot3D`, ... become `Plot[` with the caret inside, and the bar names the arguments. The 28 ready-made examples moved to the sheet's Examples tab, where one tap still runs one.

A first plot becomes: tap `Plot` -> type `Sin[x]` -> tap `{ }` -> tap `{x, -5, 5}` -> `Eval`. The same number of taps as the old one-tap template for the common case, no stale `2 Pi` to delete, and the expression is one the user actually wanted.

## Test hooks

`assist` logs the state, the prefix, the first matches, the caret, the entry text and the centre of every bar key in device pixels, `assistaccept` accepts a match, `assistsheet` opens a tab, `assistclose` closes it, `type` puts text in the entry without evaluating, `press` presses a keyboard key by label.

Device pixels, not CSS: the WebView is inset by the status bar, so a tap coordinate is `inset.top + css * dpr`. The first round of tap tests failed on exactly that.

## What is still open

- The signature key is one button. On a 393 dp bar it has to choose between showing all slots and staying readable. Long prototypes (`ParametricPlot`, `NDSolve`) ellipsize.
- Options are only offered when the caret is past the positional arguments of a prototype. A call without a prototype never offers them, even though the engine knows its options.
- The sheet's Matches tab shows the same list as the bar, just longer. There is no category filter yet (the documentation category of each match is already in the reply and shown as a badge), and no "recently used" ordering.
- Candidate requests are debounced 50 ms and cached per prefix, but a long evaluation still blocks them, because the engine has one thread.
