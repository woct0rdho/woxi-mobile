// Interpreter output -> notebook HTML.
// The engine answers with Woxi's structured output items:
//   {"type":"text","text":"x^3/3","svg":"<svg ...>"}    typeset result
//   {"type":"graphics","svg":"<svg ...>"}               plot / graphics
//   {"type":"print","text":"..."}                       Print output
//   {"type":"warning","text":"..."}                     interpreter message
//   {"type":"error","text":"..."}                       parse / evaluation error
//   {"type":"manipulate","body":"...","controls":[...],
//    "initial":{"svg":"..."}}                           interactive controls
// This module turns them into the HTML the notebook renders, and re-creates the
// Manipulate controls that live-update their view.

(function (global) {
  'use strict';

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Typeset SVGs carry width/height but often no viewBox, so CSS cannot scale them.
  // Add one and a class hook before handing them to the notebook.
  function svgTag(svg, cls) {
    return String(svg).replace(/^<svg\b([^>]*)>/, function (match, attrs) {
      var out = attrs;
      var width = /width="([0-9.]+)"/.exec(attrs);
      var height = /height="([0-9.]+)"/.exec(attrs);
      if (width && height && !/viewBox=/.test(attrs)) {
        out += ' viewBox="0 0 ' + width[1] + ' ' + height[1] + '"';
      }
      if (!/class=/.test(out)) out += ' class="' + cls + '"';
      return '<svg' + out + '>';
    });
  }

  function controlHtml(control, index) {
    var name = control.name || ('c' + index);
    var kind = control.kind || '';
    var value = control.initial;
    var attrs = ' data-woxi-control="' + escapeHtml(name) + '" data-woxi-kind="' + escapeHtml(kind) + '"';
    var input;

    if (kind === 'checkbox') {
      var checked = String(value).toLowerCase() === 'true' ? ' checked' : '';
      input = '<input type="checkbox"' + attrs + checked + '>';
    } else if (control.values && control.values.length) {
      var options = '';
      for (var i = 0; i < control.values.length; i++) {
        var option = control.values[i];
        var selected = String(option) === String(value) ? ' selected' : '';
        options += '<option value="' + escapeHtml(option) + '"' + selected + '>' +
          escapeHtml(option) + '</option>';
      }
      input = '<select' + attrs + '>' + options + '</select>';
    } else if (typeof control.min === 'number' && typeof control.max === 'number') {
      var step = control.step;
      if (step === undefined || step === null) {
        var range = control.max - control.min;
        step = range > 0 ? range / 100 : 0.1;
      }
      input = '<input type="range"' + attrs + ' min="' + control.min + '" max="' + control.max +
        '" step="' + step + '" value="' +
        (typeof value === 'number' ? value : control.min) + '">';
    } else {
      input = '<input type="text"' + attrs + ' value="' + escapeHtml(value) + '">';
    }

    return '<label class="woxi-control">' +
      '<span class="woxi-control-label">' + escapeHtml(name) + '</span>' +
      input +
      '<span class="woxi-control-value" data-woxi-value="' + escapeHtml(name) + '">' +
      escapeHtml(String(value)) + '</span>' +
      '</label>';
  }

  function manipulateHtml(item) {
    var controls = item.controls || [];
    var parts = [];
    for (var i = 0; i < controls.length; i++) parts.push(controlHtml(controls[i], i));
    var view = item.initial && item.initial.svg
      ? svgTag(item.initial.svg, 'woxi-svg')
      : '<span>' + escapeHtml((item.initial && item.initial.text) || '') + '</span>';

    return '<div class="woxi-out woxi-manipulate" data-woxi-body="' + escapeHtml(item.body || '') + '">' +
      '<div class="woxi-out-graphic woxi-manipulate-view">' + view + '</div>' +
      (parts.length ? '<div class="woxi-manipulate-controls">' + parts.join('') + '</div>' : '') +
      '</div>';
  }

  // The inner HTML of a graphics output: the SVG, ready to be re-inserted when a
  // plot is re-rendered at another view (see plot-interact.js).
  function graphicInnerHtml(item) {
    return svgTag(item.svg, 'woxi-graphic');
  }

  function itemToHtml(item) {
    if (!item || !item.type) return '';
    switch (item.type) {
      case 'text':
        return item.svg
          ? '<div class="woxi-out woxi-out-math">' + svgTag(item.svg, 'woxi-svg') + '</div>'
          : '<div class="woxi-out woxi-out-text">' + escapeHtml(item.text) + '</div>';
      case 'graphics': {
        // A 2D plot carries a handle and the range it shows, so the plot can be
        // panned and zoomed without re-evaluating what the user typed.
        var view = item.plot
          ? ' data-woxi-plot="' + escapeHtml(JSON.stringify(item.plot)) + '"'
          : '';
        return '<div class="woxi-out woxi-out-graphic' + (item.plot ? ' woxi-plot' : '') + '"' +
          view + '>' + graphicInnerHtml(item) + '</div>';
      }
      case 'print':
        return '<div class="woxi-out woxi-out-print">' + escapeHtml(item.text) + '</div>';
      case 'warning':
        return '<div class="woxi-out woxi-out-warning">' + escapeHtml(item.text) + '</div>';
      case 'error':
        return '<div class="woxi-out woxi-out-error">' + escapeHtml(item.text) + '</div>';
      case 'manipulate':
        return manipulateHtml(item);
      default:
        return '<div class="woxi-out woxi-out-text">' + escapeHtml(item.text || '') + '</div>';
    }
  }

  // Parses the engine's JSON answer and renders it (empty string when there is none).
  function renderItems(json) {
    if (!json) return '';
    var items;
    try {
      items = JSON.parse(json);
    } catch (err) {
      return '<div class="woxi-out woxi-out-error">Unreadable engine answer: ' + escapeHtml(err.message) + '</div>';
    }
    if (!items || !items.length) return '';
    var html = '';
    for (var i = 0; i < items.length; i++) html += itemToHtml(items[i]);
    return html;
  }

  // Woxi's renderer reserves fixed label areas (65 render units on the left, 40 at
  // the bottom, plus a 10-unit margin) and lays the drawing out inside them, so a
  // plot carries a wide empty strip between its tick labels and the edge of the
  // image. Trim each graphics SVG to the ink it actually draws - axis, tick
  // labels, titles and the curve all count - plus a small pad, and stretch the
  // background rectangle to the trimmed viewBox so the plot still fills its card.
  // This works for any plot type because it only measures what was drawn.
  var FIT_PAD_FRACTION = 0.012; // of the canvas width, in user units

  function inkBackground(svg, baseW, baseH) {
    var children = svg.children || [];
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (child.tagName && child.tagName.toLowerCase() === 'rect') {
        var w = parseFloat(child.getAttribute('width'));
        var h = parseFloat(child.getAttribute('height'));
        if (w >= baseW * 0.98 && h >= baseH * 0.98) return child;
      }
    }
    return null;
  }

  // Writes a box onto an SVG, and stretches the background rectangle to it so the
  // plot still fills its card. `mark` records how the box was chosen: `1` for a
  // measurement of this element, `frozen` for the geometry of an earlier frame that
  // a gesture is holding on to (which a later measurement is free to replace).
  function applyBox(svg, box, background, mark) {
    svg.setAttribute('viewBox', box.viewBox);
    svg.setAttribute('width', String(box.width));
    svg.setAttribute('height', String(box.height));
    // CSS gives the element `width: 100%; height: auto`, so the rendered height
    // comes from the intrinsic ratio. State that ratio explicitly instead of
    // relying on the browser recomputing it from the attributes.
    if (svg.style) svg.style.aspectRatio = box.width + ' / ' + box.height;
    svg.setAttribute('data-woxi-fit', mark);
    if (background) {
      background.setAttribute('x', String(box.x));
      background.setAttribute('y', String(box.y));
      background.setAttribute('width', String(box.width));
      background.setAttribute('height', String(box.height));
    }
  }

  // Puts a specific crop on the plot in `root`. Used to interpolate between the
  // geometry a gesture froze and the tighter trim that follows it, so the frame does
  // not jump when the finger lifts.
  function setGeometry(root, box) {
    var svg = root && root.querySelector ? root.querySelector('svg') : null;
    if (!svg) return;
    var background = inkBackground(svg, box.width, box.height);
    applyBox(svg, box, background, '1');
  }

  // The geometry a plot currently has, so a gesture can hold it still while its
  // tick labels change underneath.
  function svgGeometry(root) {
    var svg = root && root.querySelector ? root.querySelector('svg') : null;
    if (!svg) return null;
    var parts = (svg.getAttribute('viewBox') || '').split(/[ ,]+/).map(parseFloat);
    if (parts.length !== 4 || !(parts[2] > 0) || !(parts[3] > 0)) return null;
    return {
      x: parts[0],
      y: parts[1],
      width: parts[2],
      height: parts[3],
      viewBox: parts.join(' '),
    };
  }

  function fitOneGraphicsSvg(svg, frozen) {
    if (!svg) return;
    if (svg.getAttribute('data-woxi-fit') === '1' && !frozen) return;
    var baseW = 0;
    var baseH = 0;
    var minX = 0;
    var minY = 0;
    var viewBox = (svg.getAttribute('viewBox') || '').split(/[ ,]+/);
    if (viewBox.length === 4) {
      minX = parseFloat(viewBox[0]) || 0;
      minY = parseFloat(viewBox[1]) || 0;
      baseW = parseFloat(viewBox[2]);
      baseH = parseFloat(viewBox[3]);
    }
    if (!(baseW > 0) || !(baseH > 0)) {
      baseW = parseFloat(svg.getAttribute('width'));
      baseH = parseFloat(svg.getAttribute('height'));
    }
    if (!(baseW > 0) || !(baseH > 0)) return;

    var background = inkBackground(svg, baseW, baseH);

    // A gesture in progress keeps the frame the finger landed on, so the plot
    // cannot change size under the hand (tick labels move the ink bounds).
    if (frozen && frozen.viewBox) {
      applyBox(svg, frozen, background, 'frozen');
      return;
    }

    // getBBox only reports rendered content, so hiding the background rectangle
    // makes the measurement describe the actual drawing.
    var hidden = null;
    if (background) {
      hidden = background.style.display;
      background.style.display = 'none';
    }
    var ink = null;
    try {
      ink = svg.getBBox();
    } catch (err) {
      ink = null;
    }
    if (background) background.style.display = hidden || '';
    if (!ink || !(ink.width > 0) || !(ink.height > 0)) return;

    var pad = Math.min(6, Math.max(2, baseW * FIT_PAD_FRACTION));
    var x = Math.max(minX, ink.x - pad);
    var y = Math.max(minY, ink.y - pad);
    var w = Math.min(minX + baseW - x, ink.width + 2 * pad);
    var h = Math.min(minY + baseH - y, ink.height + 2 * pad);
    if (!(w > 0) || !(h > 0)) return;

    applyBox(svg, { x: x, y: y, width: w, height: h, viewBox: x + ' ' + y + ' ' + w + ' ' + h },
      background, '1');
  }

  // Trims every graphics SVG under `root` (plots, charts, contour and 3D renders,
  // and the view of a Manipulate). `root` may be the notebook output or the
  // graphics container of a Manipulate itself. Typeset math is left untouched.
  // `frozen` keeps an existing geometry instead of measuring.
  function fitGraphics(root, frozen) {
    if (!root || !root.querySelectorAll) return;
    var svgs = root.querySelectorAll('.woxi-out-graphic svg');
    if (!svgs.length && root.matches && root.matches('.woxi-out-graphic')) {
      svgs = root.querySelectorAll('svg');
    }
    for (var i = 0; i < svgs.length; i++) fitOneGraphicsSvg(svgs[i], frozen);
  }

  global.WoxiRender = {
    renderItems: renderItems,
    escapeHtml: escapeHtml,
    svgTag: svgTag,
    fitGraphics: fitGraphics,
    graphicInnerHtml: graphicInnerHtml,
    svgGeometry: svgGeometry,
    setGeometry: setGeometry,
  };
})(window);
