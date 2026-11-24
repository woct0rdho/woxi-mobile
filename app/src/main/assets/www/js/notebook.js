// Notebook file format: Jupyter's .ipynb, nbformat 4.5.
//
// The writer stays inside the standard fields: code cells, stable cell ids, source,
// execution_count, standard execute_result/stream outputs, and the standard ipywidgets
// metadata for a Manipulate panel. It does not write a title, a Woxi-specific metadata
// object or a custom MIME type. The filename is the notebook title.
//
// The reader is deliberately tolerant: it accepts a foreign notebook's code cells and
// standard text/SVG/stream outputs, and a saved ipywidgets model graph. Opening a file
// does not evaluate it. Inputs and outputs are restored as they were last saved. The
// interpreter session is rebuilt separately, on demand.
//
// A result is an `execute_result` carrying `text/plain` and, when the engine typeset it,
// `image/svg+xml`. A plot is an `execute_result` with the SVG and an empty `text/plain`.
// A 3D scene is an `execute_result` with only `application/vnd.woxi.plot3d`. It has no
// text placeholder or SVG payload. Printed text is a stdout stream. Warnings and errors
// are stderr streams, errors prefixed with "Error: ". A Manipulate panel adds the standard
// widget-view MIME plus its state in `metadata.widgets`. Its ordinary SVG/text output is
// the fallback for readers without ipywidgets.

import { executionCounts, isEvaluated, newCellId, uniqueCellId } from "./notebook-model.js";
import * as WoxiWidgets from "./widgets.js";

const NBFORMAT = 4;
const NBFORMAT_MINOR = 5;

// From kernelspec/woxi/kernel.json in ad-si/Woxi.
const KERNELSPEC = {
  display_name: "Woxi (Wolfram Language)",
  language: "wolfram",
  name: "woxi",
};

// From the language_info of Woxi's kernel_info reply. Its `version` is left out: the
// engine does not report the Woxi version it embeds, and a stale copy would be worse
// than none.
const LANGUAGE_INFO = {
  name: "wolfram",
  mimetype: "application/vnd.wolfram.mathematica",
  file_extension: ".wls",
  pygments_lexer: "mathematica",
  codemirror_mode: "mathematica",
  nbconvert_exporter: "text",
};

// One entry per line, each keeping its newline. Empty text is a single empty string,
// which is what Woxi's writer emits too.
function splitLines(text) {
  const value = text === undefined || text === null ? "" : String(text);
  if (!value) return [""];
  const lines = value.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(i < lines.length - 1 ? lines[i] + "\n" : lines[i]);
  }
  return out;
}

function joinLines(value) {
  if (typeof value === "string") return value;
  if (Object.prototype.toString.call(value) === "[object Array]") return value.join("");
  return "";
}

function stream(name, text) {
  let value = String(text === undefined || text === null ? "" : text);
  if (value && value.charAt(value.length - 1) !== "\n") value += "\n";
  return { output_type: "stream", name: name, text: splitLines(value) };
}

function executeResult(data, executionCount) {
  return {
    output_type: "execute_result",
    execution_count: executionCount,
    data: data,
    metadata: {},
  };
}

// The outputs of an evaluated entry: the engine items `evaluation.js` keeps, mapped to
// the MIME bundle a Jupyter front end reads. `views` comes from `widgets.build`. An item
// without a supported widget graph keeps only its ordinary SVG/text.
function outputsFor(entry, executionCount, views, entryIndex) {
  if (!entry || !Array.isArray(entry.items) || !entry.items.length) return [];
  const items = entry.items;
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== "object") continue;
    switch (item.type) {
      case "text": {
        const data = { "text/plain": splitLines(item.text) };
        if (item.svg) data["image/svg+xml"] = splitLines(item.svg);
        out.push(executeResult(data, executionCount));
        break;
      }
      case "graphics":
        if (item.plot3d) {
          out.push(executeResult({ "application/vnd.woxi.plot3d": item.plot3d }, executionCount));
        } else if (item.svg) {
          out.push(
            executeResult(
              { "image/svg+xml": splitLines(item.svg), "text/plain": [""] },
              executionCount
            )
          );
        }
        break;
      case "manipulate": {
        const view = WoxiWidgets.viewOf(entry, i, item);
        if (!view || (!view.svg && !view.text)) break;
        const data = { "text/plain": splitLines(view.text || "") };
        if (view.svg) data["image/svg+xml"] = splitLines(view.svg);
        const root = views && views[entryIndex + ":" + i];
        if (root) {
          data[WoxiWidgets.VIEW_MIME] = {
            version_major: WoxiWidgets.VERSION_MAJOR,
            version_minor: WoxiWidgets.VERSION_MINOR,
            model_id: root,
          };
        }
        out.push(executeResult(data, executionCount));
        break;
      }
      case "print":
        out.push(stream("stdout", item.text));
        break;
      case "warning":
        out.push(stream("stderr", item.text));
        break;
      case "error":
        out.push(stream("stderr", "Error: " + String(item.text || "")));
        break;
      default:
        break;
    }
  }
  return out;
}

function serialize(notebook) {
  const entries = notebook && notebook.entries ? notebook.entries : [];
  // Repair ids into a local array before building widget model ids. Serialization
  // does not mutate the live entries, and does not need a shadow copy of them.
  const cellIds = [];
  const usedIds = new Set();
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] || {};
    const cellId = uniqueCellId(entry.cellId, usedIds);
    usedIds.add(cellId);
    cellIds.push(cellId);
  }
  const widgets = WoxiWidgets.build(entries, cellIds);
  const counts = executionCounts(entries);
  const cells = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] || {};
    const evaluated = isEvaluated(entry);
    cells.push({
      cell_type: "code",
      execution_count: counts[i],
      id: cellIds[i],
      metadata: {},
      source: splitLines(entry.input || ""),
      outputs: evaluated ? outputsFor(entry, counts[i], widgets.views, i) : [],
    });
  }
  const metadata = {
    kernelspec: KERNELSPEC,
    language_info: LANGUAGE_INFO,
  };
  if (widgets.state) {
    metadata.widgets = {};
    metadata.widgets[WoxiWidgets.STATE_MIME] = widgets.state;
  }
  return JSON.stringify(
    {
      nbformat: NBFORMAT,
      nbformat_minor: NBFORMAT_MINOR,
      metadata: metadata,
      cells: cells,
    },
    null,
    2
  );
}

function outputToItems(output, models, input) {
  if (!output || typeof output !== "object") return [];
  if (output.output_type === "stream") {
    const text = joinLines(output.text);
    if (!text) return [];
    if (output.name === "stderr") {
      if (text.indexOf("Error: ") === 0) {
        return [{ type: "error", text: text.slice("Error: ".length).replace(/\n$/, "") }];
      }
      return [{ type: "warning", text: text.replace(/\n$/, "") }];
    }
    return [{ type: "print", text: text.replace(/\n$/, "") }];
  }
  if (output.output_type === "error") {
    const trace = joinLines(output.traceback).trim();
    const text = trace || [output.ename, output.evalue].filter(Boolean).join(": ");
    return text ? [{ type: "error", text: text }] : [];
  }
  if (output.output_type !== "execute_result" && output.output_type !== "display_data") {
    return [];
  }
  const data = output.data || {};
  const widgetView = data[WoxiWidgets.VIEW_MIME];
  if (widgetView && typeof widgetView === "object" && models) {
    const panel = WoxiWidgets.panel(models, widgetView.model_id);
    const body = WoxiWidgets.manipulateBody(input);
    if (panel && body) {
      return [
        {
          type: "manipulate",
          body: body,
          controls: panel.controls,
          initial: panel.initial,
        },
      ];
    }
  }
  const text = joinLines(data["text/plain"]);
  const svg = joinLines(data["image/svg+xml"]);
  const plot3d = data["application/vnd.woxi.plot3d"];
  if (plot3d && typeof plot3d === "object") return [{ type: "graphics", plot3d: plot3d }];
  if (svg) return [{ type: text ? "text" : "graphics", text: text || undefined, svg: svg }];
  if (text) return [{ type: "text", text: text }];
  return [];
}

function itemsFromOutputs(outputs, models, input) {
  const items = [];
  if (Object.prototype.toString.call(outputs) !== "[object Array]") return items;
  for (let i = 0; i < outputs.length; i += 1) {
    const produced = outputToItems(outputs[i], models, input);
    for (let j = 0; j < produced.length; j += 1) items.push(produced[j]);
  }
  return items;
}

function parse(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || Number(data.nbformat) !== NBFORMAT) {
    throw new Error("not a Jupyter notebook (nbformat 4 expected)");
  }
  if (Object.prototype.toString.call(data.cells) !== "[object Array]") {
    throw new Error("notebook has no cells");
  }
  const metadata = data.metadata || {};
  const models = WoxiWidgets.stateFromMetadata(metadata);
  const entries = [];
  const ids = new Set();
  let skippedCells = 0;
  for (let i = 0; i < data.cells.length; i++) {
    const cell = data.cells[i];
    if (!cell || typeof cell !== "object") continue;
    if (cell.cell_type !== "code") {
      skippedCells += 1;
      continue;
    }
    const input = joinLines(cell.source);
    const id = uniqueCellId(cell.id, ids);
    ids.add(id);
    const count = Number.isInteger(cell.execution_count) ? cell.execution_count : null;
    const items = itemsFromOutputs(cell.outputs, models, input);
    entries.push({
      input: input,
      cellId: id,
      executionCount: count,
      items: items,
    });
  }
  if (!entries.length) {
    entries.push({
      input: "",
      cellId: newCellId(),
      executionCount: null,
      items: [],
    });
  }
  return {
    entries: entries,
    skippedCells: skippedCells,
  };
}

export { itemsFromOutputs, NBFORMAT, NBFORMAT_MINOR, parse, serialize };
