# Auto-Save and Notebook File Model

## File model

Each notebook is a real `.ipynb` file in app-private storage, `filesDir/notebooks/`. The default notebook is `Untitled.ipynb`. `New notebook` creates `Untitled 2.ipynb`, and the `Notebooks...` sheet lists the files in that directory. The file name is the notebook title. File names are truncated by UTF-8 bytes with room for `.ipynb` and the checked writer's `.new` temp suffix, so imported emoji/CJK titles remain writable. The Storage Access Framework is the import/export boundary: `Import notebook...` copies a file into the workspace and `Export notebook...` writes a copy through the system picker. Android app-private storage needs no permission and is included in Auto Backup subject to the 25 MB quota.

Auto Backup includes the `notebooks` directory and the `woxi-files.xml` SharedPreferences file. The theme setting (`woxi.settings`) lives in WebView localStorage, which is not in those backup rules. It is device-local rather than notebook content.

In the Notebooks sheet, the row opens the notebook. The trailing `⋮` opens Rename and Delete. Rename presents a focused name field and keeps the current name if cancelled. It never overwrites an existing file: a collision is rejected and the list is shown again. Deleting asks for confirmation and removes the file. Deleting the current notebook opens the newest remaining one, or creates a fresh `Untitled` when none is left. A file name change updates the top-bar title and the last-opened preference.

Writes use a checked replacement writer on one actor thread: a complete `.new` temp file is synced, then renamed over the base and verified. A successful write leaves one complete base file and no temporary file. A failed write keeps the previous base and removes the temporary file. The production writer always uses the atomic rename. The JVM tests inject a Windows-safe move so they do not need a delete-then-retry fallback. The checked result is what drives the web layer's dirty state. There is at most one latest snapshot per filename. Switching notebooks cannot drop the previous notebook's last edit.

A page token gates file mutations, and engine/plot/query requests and results carry the same token. Queued engine/plot/query work for a replaced page is discarded before it runs, while autosave snapshots already accepted by the writer continue to disk. The native writer orders snapshots by arrival so a reloaded page's lower revision counter cannot be overwritten by an older page. `nextNotebookName` reserves a name until its first write succeeds or the notebook is deleted. Rename targets are checked against the same reservation set. Rename and delete pause autosave for that filename, and rename carries the latest serialized snapshot before changing the filename.

`Activity.onStop` is a best-effort flush because `WebView.evaluateJavascript()` is asynchronous. A `pagehide` listener flushes the web debounce before a normal reload. A renderer crash cannot run that listener, so it remains a process-failure boundary. A failed write keeps the previous file and its snapshot is retried on the next autosave or flush. Opening an existing notebook does not rewrite its base file: it reads the latest pending snapshot when one exists, and discards an uncommitted `.new` temp. A snapshot found during restore is written once under the new page's token so the new page owns its retry. Reading a notebook returns its filename.

## Invariants

- A name returned by `nextNotebookName` is reserved until its first write exists, the notebook is deleted, or the page is replaced. A pending, writing, failed or reserved name cannot be handed out for another notebook or used as a rename target. Reservations without a file or snapshot are dropped when a new page starts.
- The native writer owns snapshot ordering. A newer arrival, not a page-local revision number, supersedes an older snapshot for the same filename. A page token rejects file mutations and engine/plot/query work from a previous WebView page. The file picker results also carry the page token, so a stale import cannot replace a notebook in a replacement page.
- Notebook state is confined to the NotebookFiles actor thread. Autosave, queries, rename and delete are serialized there. There is no shared state lock or file lock. Synchronous JS queries wait for the actor for the small metadata/file reads they need.
- A filename has at most one live snapshot. Pending and failed snapshots are kept per file, not globally, so changing the visible notebook does not discard another file's last edit.
- Opening an existing notebook does not write its disk copy. Reading returns the latest queued snapshot when the disk copy is older, and replay/restore names the file through `setCurrentNotebook`. Only a snapshot that has not reached disk is adopted once under the new page's token.
- Rename and delete are serialized with autosave on the same writer. Autosave is paused for the filename during the operation, and rename writes the latest serialized snapshot before the atomic filename change. A queued write cannot recreate a deleted path or write into a newly allocated name. Temp files are removed on rename and delete.
- Filenames are truncated by UTF-8 bytes, leaving room for `.ipynb` and the checked writer's `.new` temp suffix.
- An entry is evaluated exactly when it has an integer `execution_count` or at least one persisted output item. There is no separate evaluated flag that can disagree with the file.
- A restored session is replayed once for the current notebook generation. Counted entries replay in count order. Evaluated entries without a count replay after them in notebook order instead of being skipped. A replay for a replaced notebook can never mark the replacement restored.
- Replacing a notebook also invalidates in-flight evaluations. An old evaluate-all loop stops before submitting more code, and its completion does not clear the new notebook's evaluating state. Deleting or clearing an entry invalidates that entry's in-flight result, so a detached entry cannot write output or advance the execution count.
- `Activity.onStop` does not promise a save: it flushes what native already holds and asks the web layer to flush its debounce. The boundary for a completed write is the autosave callback. It is a process-failure boundary, not a promise about sudden power loss.

## Unchanged: read broadly, write narrowly

The writer emits nbformat 4.5 with standard fields only:
- code cells with a stable 8-hex `id`
- `source`, `execution_count` and standard `execute_result`/`stream` outputs
- top-level `metadata.kernelspec` and `metadata.language_info`
- standard `metadata.widgets` only when a cell has a supported `Manipulate` panel

It does not write `metadata.title`, a Woxi-specific metadata object or a custom MIME type. The reader also accepts foreign text/SVG/stream outputs and a standard ipywidgets model graph. It ignores `text/html` and never executes notebook JavaScript. SVG is stripped of scripts, event handlers and comparable active content before it reaches the DOM. Non-code cells are not preserved by the writer. Opening a notebook that contains them reports how many were skipped.

A cell that was evaluated but produced no output keeps its `execution_count`. An unevaluated cell keeps `null`. Stable cell ids also keep widget model ids stable across saves. Blank code cells and trailing source whitespace are preserved: the file is a document, not a collection of non-empty editing placeholders.

## Restore

Boot reads the last notebook, or the newest app-private notebook if the preference is missing, and renders its saved outputs. It does not evaluate. If the file is only available as a queued snapshot, the page adopts that snapshot once so the current page owns its retry. The interpreter session is empty. `session.js` rebuilds it on demand, before the first evaluation or Manipulate interaction, by replaying evaluated entries in execution-count order with rendering suppressed. A restored plot is a saved picture and a restored panel is interactive through the app's own renderer. A re-evaluation recreates the live engine output.

The current session's execution count is derived from the entries: the persisted maximum of integer counts plus the number of evaluated entries without a count. That includes the fallback counts the writer will synthesize, so a later evaluation cannot duplicate one. There is no separate mutable counter to drift from the entries. A file with outputs but a null count is still replayed. Its position after counted entries is the only order the format gives us.

## Outputs

| Engine item | Persisted as |
|---|---|
| typeset text | `execute_result`: `text/plain`, `image/svg+xml` |
| graphics / plot | `execute_result`: `image/svg+xml`, empty `text/plain` |
| `Manipulate` | standard widget-view MIME plus `metadata.widgets`. SVG/text fallback |
| `Print` | stdout `stream` |
| warning | stderr `stream` |
| error | stderr `stream` with `Error:` |
| evaluated, no output | `outputs: []` with a count |

`entry.output` HTML, the evaluated source snapshot, canvases, fitted bounds, scroll/caret, plot samples, plot camera and engine handles are session state, not notebook content. The file stores the current source and outputs. It cannot recover a source edit that was not evaluated before the file was saved. On restore, a cell whose source was edited after its last evaluation is therefore replayed from the current source, not the source that produced the visible output. This is the same provenance limit the standard notebook format imposes. A restored plot is intentionally still until re-evaluated.

## Manipulate panels

A `Manipulate` panel is written as standard ipywidgets state version 2.0:
- `VBoxModel` root with an `HTMLModel` (SVG) or `LabelModel` (text) view and standard controls
- `FloatSliderModel`, `IntSliderModel`, `DropdownModel` or `CheckboxModel`
- model/view modules `@jupyter-widgets/controls`, model version `2.0.0`, no custom module
- `application/vnd.jupyter.widget-view+json` in the output. The ordinary SVG/text output is the fallback

Jupyter with ipywidgets renders the saved panel and its values. Stock Jupyter does not recompute the Woxi body because the Woxi kernel does not implement the ipywidgets comm protocol. Our app does. Full live Jupyter support would require kernel-side widget comms, not a different file format. The panel values are updated in the widget state when a control settles, and that update is autosaved.

The Woxi body is not duplicated in metadata: `Manipulate[body, ...]` is read from the cell source by `widgets.manipulateBody`. If that fails, or the control graph contains a model this app does not implement, the cell keeps its ordinary SVG/text and no widget state.

## Triggers

- Input edits: trailing 800 ms, with a 5 s maximum defer.
- Evaluation, structure changes, clear/duplicate/undo/redo: same debounce. Only completed results are written.
- `Activity.onStop`: best-effort web flush plus the native writer queue. A `pagehide` flush covers normal reloads. `onPause` is not treated as a save point.
- Before import, export, new or stored-file open: flush first. Rename does not use the debounced flush: the current notebook is serialized before the native operation and the writer saves that snapshot before the filename change. For a non-current notebook, its pending snapshot is used when present. Delete discards pending snapshots for the target.
- Auto-save failure: keep dirty, retain the failed snapshot, retry. Show a failure toast once.
- A snapshot loaded from an open or restore operation is written under the new page's token before it is considered durable. A failed write never leaves the document marked clean.
- Theme changes are a deliberate notebook mutation: typeset SVGs carry their colors, so changing the resolved theme re-evaluates evaluated cells and uses the normal autosave path. This is separate from opening/restoring a file.
- Settings (theme) are saved in `woxi.settings` by the theme module when the setting changes. They are not notebook content.
- Opening or installing a notebook updates the last-opened preference. Rename/delete update it for the visible file. A background autosave for another file cannot overwrite it.

Auto Backup runs opportunistically, not on every save. It is not a substitute for exporting a file the user owns.
