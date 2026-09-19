// Notebook file format: Jupyter's .ipynb, nbformat 4.
//
// The shapes here follow the ones Woxi itself uses in Jupyter: the kernel metadata comes
// from Woxi's kernelspec (`kernelspec/woxi/kernel.json`) and from the `kernel_info` reply
// of its kernel, and the outputs follow what that kernel publishes - a result is an
// `execute_result` carrying `text/plain` and, when the engine typeset it, `image/svg+xml`.
// A plot is an `execute_result` with the SVG and an empty `text/plain`. Printed text is a
// stdout stream and warnings and errors are stderr streams, errors prefixed with "Error: ".
// Strings are stored one line per entry, each keeping its newline, as Woxi's own writer
// does.
//
// Two deliberate differences from Woxi's exporter, both so the file is valid nbformat 4.5:
// cells get the `id` every 4.5 notebook must have (Woxi's exporter omits it), and the
// kernelspec names the kernel that is actually installed, `woxi`, rather than `wolfram`
// (Woxi's exporter writes the latter, which no installed kernel answers to). Cells that
// have not been evaluated keep `execution_count: null` instead of a number no session
// handed out.
//
// Only the part of the format this app uses is handled: code cells carry one Woxi input
// each, markdown and raw cells are skipped when reading and never written, and outputs are
// written but ignored on load - Woxi recomputes every entry, which is what keeps a document
// consistent with the interpreter that opens it. A notebook of plain code cells therefore
// round-trips through this app unchanged. Anything else keeps its code and loses the rest.

(function (global) {
  'use strict';

  var NBFORMAT = 4;
  var NBFORMAT_MINOR = 5;
  var EXTENSION = '.ipynb';
  var MIME = 'application/x-ipynb+json';

  // From kernelspec/woxi/kernel.json in ad-si/Woxi.
  var KERNELSPEC = {
    display_name: 'Woxi (Wolfram Language)',
    language: 'wolfram',
    name: 'woxi',
  };

  // From the language_info of Woxi's kernel_info reply. Its `version` is left out: the
  // engine does not report the Woxi version it embeds, and a stale copy would be worse
  // than none.
  var LANGUAGE_INFO = {
    name: 'wolfram',
    mimetype: 'application/vnd.wolfram.mathematica',
    file_extension: '.wls',
    pygments_lexer: 'mathematica',
    codemirror_mode: 'mathematica',
    nbconvert_exporter: 'text',
  };

  function utf8Bytes(text) {
    return new TextEncoder().encode(text);
  }

  // base64 (as expected by NativeBridge) for a UTF-8 string, chunked.
  function utf8ToBase64(text) {
    var bytes = utf8Bytes(text);
    var chunk = 0x8000;
    var binary = '';
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToUtf8(base64) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  // One entry per line, each keeping its newline. Empty text is a single empty string,
  // which is what Woxi's writer emits too.
  function splitLines(text) {
    var value = text === undefined || text === null ? '' : String(text);
    if (!value) return [''];
    var lines = value.split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      out.push(i < lines.length - 1 ? lines[i] + '\n' : lines[i]);
    }
    return out;
  }

  // A cell's `source` may be a string or a list of lines in any notebook.
  function joinSource(source) {
    if (typeof source === 'string') return source;
    if (Object.prototype.toString.call(source) === '[object Array]') return source.join('');
    return '';
  }

  // Jupyter's own cell ids are eight random hex digits (nbformat's new_code_cell).
  function cellId() {
    var hex = '0123456789abcdef';
    var out = '';
    for (var i = 0; i < 8; i++) out += hex.charAt(Math.floor(Math.random() * 16));
    return out;
  }

  function stream(name, text) {
    var value = String(text === undefined || text === null ? '' : text);
    if (value && value.charAt(value.length - 1) !== '\n') value += '\n';
    return { output_type: 'stream', name: name, text: splitLines(value) };
  }

  function executeResult(data, executionCount) {
    return {
      output_type: 'execute_result',
      execution_count: executionCount,
      data: data,
      metadata: {},
    };
  }

  function outputsFor(entry, executionCount) {
    if (!entry || !entry.items) return [];
    var items = null;
    try {
      items = JSON.parse(entry.items);
    } catch (err) {
      return [];
    }
    if (Object.prototype.toString.call(items) !== '[object Array]') return [];
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item || typeof item !== 'object') continue;
      switch (item.type) {
        case 'text': {
          var data = { 'text/plain': splitLines(item.text) };
          if (item.svg) data['image/svg+xml'] = splitLines(item.svg);
          out.push(executeResult(data, executionCount));
          break;
        }
        case 'graphics':
          if (item.svg) {
            out.push(executeResult({ 'image/svg+xml': splitLines(item.svg), 'text/plain': [''] },
                                   executionCount));
          }
          break;
        case 'manipulate':
          // No notebook equivalent: keep the graphic the panel starts from.
          if (item.initial && item.initial.svg) {
            out.push(executeResult({ 'image/svg+xml': splitLines(item.initial.svg), 'text/plain': [''] },
                                   executionCount));
          }
          break;
        case 'print':
          out.push(stream('stdout', item.text));
          break;
        case 'warning':
          out.push(stream('stderr', item.text));
          break;
        case 'error':
          out.push(stream('stderr', 'Error: ' + String(item.text || '')));
          break;
        default:
          break;
      }
    }
    return out;
  }

  function serialize(doc) {
    var entries = (doc && doc.entries) || [];
    var cells = [];
    var executed = 0;
    for (var i = 0; i < entries.length; i++) {
      var hasOutput = !!entries[i].items;
      if (hasOutput) executed += 1;
      var outputs = hasOutput ? outputsFor(entries[i], executed) : [];
      cells.push({
        cell_type: 'code',
        execution_count: outputs.length ? executed : null,
        id: cellId(),
        metadata: {},
        source: splitLines(entries[i].input || ''),
        outputs: outputs,
      });
    }
    return JSON.stringify({
      nbformat: NBFORMAT,
      nbformat_minor: NBFORMAT_MINOR,
      metadata: {
        kernelspec: KERNELSPEC,
        language_info: LANGUAGE_INFO,
        title: (doc && doc.title) || 'Untitled',
      },
      cells: cells,
    }, null, 2);
  }

  function parse(text) {
    var data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Number(data.nbformat) !== NBFORMAT) {
      throw new Error('not a Jupyter notebook (nbformat 4 expected)');
    }
    if (Object.prototype.toString.call(data.cells) !== '[object Array]') {
      throw new Error('notebook has no cells');
    }
    var metadata = data.metadata || {};
    var title = typeof metadata.title === 'string' && metadata.title ? metadata.title : 'Untitled';
    var entries = [];
    var skippedCells = 0;
    for (var i = 0; i < data.cells.length; i++) {
      var cell = data.cells[i];
      if (!cell || typeof cell !== 'object') continue;
      if (cell.cell_type !== 'code') {
        skippedCells += 1;
        continue;
      }
      var input = joinSource(cell.source).replace(/[\s\uFEFF]+$/, '');
      if (!input) continue;
      entries.push({ input: input });
    }
    if (!entries.length) entries.push({ input: '' });
    return { title: title, entries: entries, skippedCells: skippedCells };
  }

  function suggestFileName(title) {
    var base = (title || 'Untitled').replace(/[\\/:*?"<>|]+/g, '').trim() || 'Untitled';
    if (base.length > 60) base = base.slice(0, 60);
    return base + EXTENSION;
  }

  function displayTitle(fileName) {
    return String(fileName || '').replace(/\.ipynb$/i, '') || 'Untitled';
  }

  global.WoxiNotebook = {
    NBFORMAT: NBFORMAT,
    NBFORMAT_MINOR: NBFORMAT_MINOR,
    EXTENSION: EXTENSION,
    MIME: MIME,
    serialize: serialize,
    parse: parse,
    suggestFileName: suggestFileName,
    displayTitle: displayTitle,
    utf8ToBase64: utf8ToBase64,
    base64ToUtf8: base64ToUtf8,
  };
})(window);
