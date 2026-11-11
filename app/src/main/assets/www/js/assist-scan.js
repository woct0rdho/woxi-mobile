// The text side of typing assistance: where the caret is in a Wolfram expression, which
// brackets are open, which call it is inside, and what the nearest operand is. Pure string
// functions. The controller (`assist.js`) decides what to show and talks to the engine.

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isIdentChar(ch) {
  return /[A-Za-z0-9$`]/.test(ch);
}

// The identifier that ends at `caret`, plus where it starts.
function prefixSpan(code, caret) {
  let start = caret;
  while (start > 0 && isIdentChar(code.charAt(start - 1))) start -= 1;
  return { start: start, end: caret, text: code.slice(start, caret) };
}

const CLOSER = { "[": "]", "{": "}", "(": ")" };

// The calls the caret is inside, innermost last. Strings and comments are skipped
// so a `[` inside `"..."` never opens a call.
function scanContext(code, caret) {
  const stack = [];
  let inString = false;
  let commentDepth = 0;
  let i = 0;
  while (i < caret) {
    const ch = code.charAt(i);
    if (commentDepth > 0) {
      if (ch === "(" && code.charAt(i + 1) === "*") {
        commentDepth += 1;
        i += 2;
        continue;
      }
      if (ch === "*" && code.charAt(i + 1) === ")") {
        commentDepth -= 1;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      i += 1;
      continue;
    }
    if (ch === "(" && code.charAt(i + 1) === "*") {
      commentDepth = 1;
      i += 2;
      continue;
    }
    if (ch === "[" || ch === "{" || ch === "(") {
      let head = "";
      if (ch === "[") head = prefixSpan(code, i).text;
      stack.push({ open: i, ch: ch, head: head, args: 1 });
      i += 1;
      continue;
    }
    if (ch === "]" || ch === "}" || ch === ")") {
      if (stack.length) stack.pop();
      i += 1;
      continue;
    }
    if (ch === "," && stack.length) {
      stack[stack.length - 1].args += 1;
    }
    i += 1;
  }
  const inner = stack.length ? stack[stack.length - 1] : null;
  // The call the caret is in is the innermost `[...]`, even when the caret sits in a
  // `{...}` argument of it: the signature and the option position belong to the call.
  let call = null;
  for (let k = stack.length - 1; k >= 0; k -= 1) {
    if (stack[k].ch === "[") {
      call = stack[k];
      break;
    }
  }
  return {
    stack: stack,
    open: inner,
    call: call,
    head: call ? call.head : "",
    argIndex: call ? call.args - 1 : 0,
    inString: inString,
    commentDepth: commentDepth,
  };
}

// The brackets (and quote) that would close the input, outermost last.
function closersFor(code, caret) {
  const ctx = scanContext(code, caret);
  if (ctx.commentDepth > 0) return "";
  let tail = "";
  for (let i = ctx.stack.length - 1; i >= 0; i -= 1) {
    const closer = CLOSER[ctx.stack[i].ch];
    if (!closer) return "";
    tail += closer;
  }
  if (ctx.inString) tail += '"';
  return tail;
}

// Where the argument the caret is in starts: after the previous top-level comma, or
// after the bracket that opened it.
function argumentStart(code, caret) {
  let depth = 0;
  for (let i = caret - 1; i >= 0; i -= 1) {
    const ch = code.charAt(i);
    if (ch === "]" || ch === "}" || ch === ")") depth += 1;
    else if (ch === "[" || ch === "{" || ch === "(") {
      if (depth === 0) return i + 1;
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      return i + 1;
    }
  }
  return 0;
}

// Where the argument the caret is in ends: the next top-level comma or closing
// bracket of the enclosing call.
function argumentEnd(code, caret) {
  let depth = 0;
  for (let i = caret; i < code.length; i += 1) {
    const ch = code.charAt(i);
    if (ch === '"') {
      i += 1;
      while (i < code.length && code.charAt(i) !== '"') {
        if (code.charAt(i) === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === "[" || ch === "{" || ch === "(") depth += 1;
    else if (ch === "]" || ch === "}" || ch === ")") {
      if (depth === 0) return i;
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      return i;
    }
  }
  return code.length;
}

// The index of the closer that matches the opener at `at`, or -1. Strings and
// `(* comments *)` are skipped, so a bracket inside them does not count.
function matchForward(code, at) {
  const open = code.charAt(at);
  const closer = open === "<" ? ">" : CLOSER[open];
  if (!closer) return -1;
  let depth = 0;
  for (let i = at; i < code.length; i += 1) {
    const ch = code.charAt(i);
    if (ch === '"') {
      i += 1;
      while (i < code.length && code.charAt(i) !== '"') {
        if (code.charAt(i) === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === "(" && code.charAt(i + 1) === "*") {
      let comment = 1;
      i += 2;
      while (i < code.length && comment) {
        if (code.charAt(i) === "(" && code.charAt(i + 1) === "*") {
          comment += 1;
          i += 2;
          continue;
        }
        if (code.charAt(i) === "*" && code.charAt(i + 1) === ")") {
          comment -= 1;
          i += 2;
          continue;
        }
        i += 1;
      }
      continue;
    }
    if (open === "<") {
      if (ch === "<" && code.charAt(i + 1) === "|") depth += 1;
      else if (ch === "|" && code.charAt(i + 1) === ">") {
        depth -= 1;
        if (depth === 0) return i;
      }
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// The operand that starts at `at`, after spaces: a function call, an identifier, a
// number, a string or a bracketed group. An operator or a delimiter is not an operand,
// so there is nothing to wrap there. Only one operand is measured - an expression such
// as `x + 1` is wrapped by selecting it.
function operandAt(code, at) {
  let i = at;
  while (i < code.length && /\s/.test(code.charAt(i))) i += 1;
  if (i >= code.length) return null;
  const start = i;
  const ch = code.charAt(i);
  if (/[A-Za-z$`]/.test(ch)) {
    while (i < code.length && /[A-Za-z0-9$`]/.test(code.charAt(i))) i += 1;
    let afterName = i;
    while (afterName < code.length && /\s/.test(code.charAt(afterName))) afterName += 1;
    if (code.charAt(afterName) === "[") {
      const close = matchForward(code, afterName);
      if (close >= 0) return { start: start, end: close + 1 };
    }
    return { start: start, end: i };
  }
  if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(code.charAt(i + 1)))) {
    while (i < code.length && /[0-9.]/.test(code.charAt(i))) i += 1;
    return { start: start, end: i };
  }
  if (ch === '"') {
    i += 1;
    while (i < code.length) {
      if (code.charAt(i) === "\\") i += 1;
      else if (code.charAt(i) === '"') {
        i += 1;
        break;
      }
      i += 1;
    }
    return { start: start, end: i };
  }
  if (ch === "(" || ch === "{" || (ch === "<" && code.charAt(i + 1) === "|")) {
    const matched = matchForward(code, i);
    if (matched < 0) return null;
    return { start: start, end: ch === "<" ? matched + 2 : matched + 1 };
  }
  return null;
}

function nextSlotCaret(code, caret) {
  const end = argumentEnd(code, caret);
  if (end >= code.length) return null;
  if (code.charAt(end) === ",") {
    let next = end + 1;
    while (next < code.length && code.charAt(next) === " ") next += 1;
    return next;
  }
  return end;
}

export {
  argumentEnd,
  argumentStart,
  closersFor,
  escapeHtml,
  nextSlotCaret,
  operandAt,
  prefixSpan,
  scanContext,
};
