// Standard Jupyter widget state for a `Manipulate` panel.
//
// ipywidgets saves a panel as a notebook-level model graph in
// `metadata.widgets['application/vnd.jupyter.widget-state+json']`, and each output holds
// `application/vnd.jupyter.widget-view+json` with the root model id. The file remains a
// valid notebook. A frontend without ipywidgets falls back to the cell's SVG/text output.
//
// This module writes only standard `@jupyter-widgets/base` and `@jupyter-widgets/controls`
// models (2.0.0): a VBox root, an HTML view, and the sliders, dropdowns and checkboxes the
// Manipulate parser produces. It never writes a custom module or a custom MIME type. The
// Woxi body itself stays in the cell source. `manipulateBody` reads it back on demand.

const STATE_MIME = "application/vnd.jupyter.widget-state+json";
const VIEW_MIME = "application/vnd.jupyter.widget-view+json";
const VERSION_MAJOR = 2;
const VERSION_MINOR = 0;
const MODEL_VERSION = "2.0.0";
const CONTROLS_MODULE = "@jupyter-widgets/controls";
const SLIDER_STEPS = 100;
const DEFAULT_SLIDER_STEP = 0.1;

// The first argument of `Manipulate[...]`, with the same top-level bracket/string/comment
// rules the interpreter's parser uses. This is only for restoring a panel. The source is
// the standard place for the body.
function manipulateBody(input) {
  const text = String(input || "").trim();
  const open = text.indexOf("[");
  if (open < 0 || text.slice(0, open).trim().toLowerCase() !== "manipulate") return "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  let comment = 0;
  for (let i = open + 1; i < text.length; i += 1) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (comment > 0) {
      if (ch === "(" && next === "*") {
        comment += 1;
        i += 1;
      } else if (ch === "*" && next === ")") {
        comment -= 1;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === "(" && next === "*") {
      comment = 1;
      i += 1;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "[" || ch === "{" || ch === "(") {
      depth += 1;
    } else if (ch === "]" || ch === "}" || ch === ")") {
      if (ch === "]" && depth === 0) return "";
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      return text.slice(open + 1, i).trim();
    }
  }
  return "";
}

function stateFromMetadata(metadata) {
  const widgets = metadata && metadata.widgets;
  const raw = widgets && widgets[STATE_MIME];
  if (!raw || raw.version_major !== VERSION_MAJOR || !raw.state) return null;
  if (typeof raw.state !== "object") return null;
  return raw.state;
}

function modelName(record) {
  if (!record || typeof record !== "object") return "";
  return String(record.model_name || (record.state && record.state._model_name) || "");
}

function modelState(record) {
  return record && record.state && typeof record.state === "object" ? record.state : {};
}

function viewFromHtml(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (!text) return {};
  return /^<svg\b/i.test(text) ? { svg: text } : { text: text };
}

// A root VBox plus its HTML view and control models, or null when the graph contains a
// model this app does not implement. In that case the caller keeps the ordinary SVG/text
// output and does not write a dangling widget view.
function panel(models, rootId) {
  if (!models || !rootId) return null;
  const root = models[rootId];
  if (!root || modelName(root) !== "VBoxModel") return null;
  const children = modelState(root).children;
  if (Object.prototype.toString.call(children) !== "[object Array]") return null;
  let view = null;
  const controls = [];
  for (let i = 0; i < children.length; i += 1) {
    const id = String(children[i] || "").replace(/^IPY_MODEL_/, "");
    const record = models[id];
    if (!record) return null;
    const name = modelName(record);
    const state = modelState(record);
    if (name === "HTMLModel") {
      view = viewFromHtml(state.value);
      continue;
    }
    if (name === "LabelModel") {
      view = { text: String(state.value === undefined ? "" : state.value) };
      continue;
    }
    const label = String(state.description || "") || "c" + controls.length;
    if (name === "IntSliderModel" || name === "FloatSliderModel") {
      const min = Number(state.min);
      const max = Number(state.max);
      const step = Number(state.step);
      if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
      controls.push({
        kind: name === "IntSliderModel" ? "discrete" : "continuous",
        name: label,
        min: min,
        max: max,
        step: Number.isFinite(step) ? step : undefined,
        initial: String(state.value === undefined ? min : state.value),
      });
      continue;
    }
    if (name === "DropdownModel") {
      const values = state._options_labels;
      if (Object.prototype.toString.call(values) !== "[object Array]" || !values.length) {
        return null;
      }
      const index = Number(state.index);
      const selected = Number.isInteger(index) ? values[index] : state.value;
      controls.push({
        kind: "discrete",
        name: label,
        values: values.map(function (value) {
          return String(value);
        }),
        initial: String(selected === undefined || selected === null ? values[0] : selected),
      });
      continue;
    }
    if (name === "CheckboxModel") {
      controls.push({
        kind: "checkbox",
        name: label,
        initial: state.value ? "true" : "false",
      });
      continue;
    }
    // A model this app does not render.
    return null;
  }
  if (!view || !controls.length) return null;
  return { controls: controls, initial: view };
}

function savedPanel(entry, itemIndex) {
  return (entry && entry.widgets && entry.widgets[itemIndex]) || null;
}

function valuesOf(entry, itemIndex, item) {
  const saved = savedPanel(entry, itemIndex);
  if (saved && saved.values) return saved.values;
  const values = {};
  const controls = (item && item.controls) || [];
  for (let i = 0; i < controls.length; i += 1) {
    values[controls[i].name || "c" + i] = controls[i].initial;
  }
  return values;
}

function viewOf(entry, itemIndex, item) {
  const saved = savedPanel(entry, itemIndex);
  if (saved && saved.view) return saved.view;
  return (item && item.initial) || {};
}

function modelId(cellId, entryIndex, itemIndex, suffix) {
  const base = String(cellId || "cell" + entryIndex).replace(/[^0-9a-zA-Z_-]/g, "");
  return (base || "cell" + entryIndex) + "m" + itemIndex + suffix;
}

function modelRecord(name, view, moduleName, state) {
  return {
    model_name: name,
    model_module: moduleName,
    model_module_version: MODEL_VERSION,
    state: Object.assign(
      {
        _model_name: name,
        _model_module: moduleName,
        _model_module_version: MODEL_VERSION,
        _view_name: view,
        _view_module: moduleName,
        _view_module_version: MODEL_VERSION,
      },
      state
    ),
  };
}

function addViewModel(models, viewId, view) {
  if (view && view.svg) {
    models[viewId] = modelRecord("HTMLModel", "HTMLView", CONTROLS_MODULE, {
      value: String(view.svg),
      description: "",
      placeholder: "",
    });
    return;
  }
  models[viewId] = modelRecord("LabelModel", "LabelView", CONTROLS_MODULE, {
    value: String((view && view.text) || ""),
    description: "",
  });
}

function buildPanel(entry, cellId, entryIndex, itemIndex, item) {
  const controls = (item && item.controls) || [];
  if (!controls.length || !item.body) return null;
  const values = valuesOf(entry, itemIndex, item);
  const view = viewOf(entry, itemIndex, item);
  if (!view || (!view.svg && !view.text)) return null;

  const base = modelId(cellId, entryIndex, itemIndex, "");
  const viewId = base + "v";
  const rootId = base + "r";
  const models = {};
  const children = ["IPY_MODEL_" + viewId];
  addViewModel(models, viewId, view);

  for (let i = 0; i < controls.length; i += 1) {
    const control = controls[i];
    const name = String(control.name || "c" + i);
    const initial = values[name] !== undefined ? values[name] : control.initial;
    const controlId = base + "c" + i;
    children.push("IPY_MODEL_" + controlId);
    if (control.kind === "checkbox") {
      models[controlId] = modelRecord("CheckboxModel", "CheckboxView", CONTROLS_MODULE, {
        value: String(initial).toLowerCase() === "true",
        description: name,
        indent: false,
      });
      continue;
    }
    if (control.values && control.values.length) {
      const labels = control.values.map(function (value) {
        return String(value);
      });
      let index = labels.indexOf(String(initial));
      if (index < 0) index = 0;
      models[controlId] = modelRecord("DropdownModel", "DropdownView", CONTROLS_MODULE, {
        _options_labels: labels,
        index: index,
        description: name,
      });
      continue;
    }
    const min = Number(control.min);
    const max = Number(control.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    const step = Number(control.step);
    const isInteger =
      control.kind !== "continuous" &&
      (!Number.isFinite(step) || Number.isInteger(step)) &&
      Number.isInteger(min) &&
      Number.isInteger(max);
    let value = Number(initial);
    if (!Number.isFinite(value)) value = min;
    value = Math.max(min, Math.min(max, value));
    if (isInteger) {
      models[controlId] = modelRecord("IntSliderModel", "IntSliderView", CONTROLS_MODULE, {
        value: Math.round(value),
        min: Math.round(min),
        max: Math.round(max),
        step: Number.isFinite(step) && step > 0 ? Math.round(step) : 1,
        description: name,
        readout: true,
        readout_format: "d",
        orientation: "horizontal",
      });
    } else {
      const fallbackStep = (max - min) / SLIDER_STEPS || DEFAULT_SLIDER_STEP;
      models[controlId] = modelRecord("FloatSliderModel", "FloatSliderView", CONTROLS_MODULE, {
        value: value,
        min: min,
        max: max,
        step: Number.isFinite(step) && step > 0 ? step : fallbackStep,
        description: name,
        readout: true,
        readout_format: ".2f",
        orientation: "horizontal",
      });
    }
  }

  models[rootId] = modelRecord("VBoxModel", "VBoxView", CONTROLS_MODULE, {
    children: children,
    box_style: "",
  });
  return { rootId: rootId, models: models };
}

// Build the notebook-level widget metadata and the root view id for each manipulate item.
// The key is `${entryIndex}:${itemIndex}` so `serialize` can add the output MIME without
// reparsing the model graph. `cellIds` is the repaired id array from serialization. Without
// it, the entry's own id is used for callers that only need the view lookup.
function build(entries, cellIds) {
  const models = {};
  const views = {};
  let any = false;
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    const items = entry && Array.isArray(entry.items) ? entry.items : [];
    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const item = items[itemIndex];
      if (!item || item.type !== "manipulate") continue;
      let cellId = "cell" + entryIndex;
      if (cellIds) cellId = cellIds[entryIndex];
      else if (entry && entry.cellId) cellId = entry.cellId;
      const built = buildPanel(entry, cellId, entryIndex, itemIndex, item);
      if (!built) continue;
      Object.assign(models, built.models);
      views[entryIndex + ":" + itemIndex] = built.rootId;
      any = true;
    }
  }
  return {
    state: any
      ? { version_major: VERSION_MAJOR, version_minor: VERSION_MINOR, state: models }
      : null,
    views: views,
  };
}

export {
  build,
  DEFAULT_SLIDER_STEP,
  manipulateBody,
  panel,
  SLIDER_STEPS,
  STATE_MIME,
  stateFromMetadata,
  VERSION_MAJOR,
  VERSION_MINOR,
  VIEW_MIME,
  viewOf,
};
