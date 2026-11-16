// The text side of typing assistance: where the caret is in a Wolfram expression, which
// brackets are open, which call it is inside, and what the nearest operand is. Pure string
// functions. The controller (`assist.js`) decides what to show and talks to the engine.

function isIdentChar(ch) {
  return /[A-Za-z0-9$`]/.test(ch);
}

// The identifier that ends at `caret`, plus where it starts.
function prefixSpan(code, caret) {
  let start = caret;
  while (start > 0 && isIdentChar(code.charAt(start - 1))) start -= 1;
  return { start: start, end: caret, text: code.slice(start, caret) };
}

// The end of the identifier that starts at (or continues through) `at`. A chip accepted
// while the caret is inside a name replaces the whole name, not just the part before the
// caret.
function identifierEnd(code, at) {
  let end = at;
  while (end < code.length && isIdentChar(code.charAt(end))) end += 1;
  return end;
}

const CLOSER = { "[": "]", "{": "}", "(": ")" };

// The end of the string that starts at `at` (which must be a quote). `closed` is false
// when the string runs off the end of the slice.
function stringEnd(code, at, end) {
  let i = at + 1;
  while (i < end) {
    const ch = code.charAt(i);
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') return { end: i + 1, closed: true };
    i += 1;
  }
  return { end: end, closed: false };
}

// Walks the structural characters of code[start..end], skipping strings and comments.
// `visit(kind, index, ch)` receives `open`, `close` or `comma`. Returning true stops the
// walk. The returned state is what the caret is inside when the slice ends, so callers
// that start in the middle of a string or comment can resume correctly.
//
// This is the one state machine for brackets, associations, strings and comments. The
// caret queries, the option-name scan and the bracket matcher all go through it. A fix
// for nested comments or association closers does not have to be repeated six times.
function walkStructure(code, start, end, visit, initial) {
  let i = start;
  let inString = !!(initial && initial.inString);
  let commentDepth = (initial && initial.commentDepth) || 0;
  while (i < end) {
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

    let kind = "";
    let width = 0;
    let token = ch;
    if (ch === "<" && code.charAt(i + 1) === "|") {
      kind = "open";
      width = 2;
      token = "<";
    } else if (ch === "|" && code.charAt(i + 1) === ">") {
      kind = "close";
      width = 2;
      token = "|";
    } else if (ch === "[" || ch === "{" || ch === "(") {
      kind = "open";
      width = 1;
    } else if (ch === "]" || ch === "}" || ch === ")") {
      kind = "close";
      width = 1;
    } else if (ch === ",") {
      kind = "comma";
      width = 1;
    }

    if (kind) {
      if (visit(kind, i, token)) {
        return { inString: inString, commentDepth: commentDepth };
      }
      i += width;
      continue;
    }
    i += 1;
  }
  return { inString: inString, commentDepth: commentDepth };
}

// The calls the caret is inside, innermost last. Strings and comments are skipped
// so a `[` inside `"..."` never opens a call. Each frame keeps the start of the
// argument it is currently in, so the argument queries do not scan the text again.
function scanContext(code, caret) {
  const stack = [];
  const state = walkStructure(code, 0, caret, function (kind, index, ch) {
    if (kind === "open") {
      let head = "";
      if (ch === "[") head = prefixSpan(code, index).text;
      stack.push({
        open: index,
        ch: ch,
        head: head,
        args: 1,
        argStart: index + (ch === "<" ? 2 : 1),
      });
      return;
    }
    if (kind === "close") {
      if (stack.length) stack.pop();
      return;
    }
    // The comma belongs to the innermost open group. A top-level comma does not
    // start a call argument. Only the frames below the caret do.
    if (stack.length) {
      const top = stack[stack.length - 1];
      top.args += 1;
      top.argStart = index + 1;
    }
  });
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
    inString: state.inString,
    commentDepth: state.commentDepth,
  };
}

// The brackets (and quote) that would close the input, outermost last.
function closersFor(code, caret) {
  const ctx = scanContext(code, caret);
  if (ctx.commentDepth > 0) return "";
  let tail = "";
  for (let i = ctx.stack.length - 1; i >= 0; i -= 1) {
    const opener = ctx.stack[i].ch;
    const closer = opener === "<" ? "|>" : CLOSER[opener];
    if (!closer) return "";
    tail += closer;
  }
  if (ctx.inString) tail += '"';
  return tail;
}

// Where the argument the caret is in starts: after the previous top-level comma, or
// after the bracket that opened it. The frame is already on `scanContext`. Callers read
// `ctx.stack[...].argStart` (or `ctx.call.argStart`) instead of walking the text again.

// Where the argument of the call opened at `open` starts, for the caret at `caret`.
// Only commas at the call's own depth split arguments. Nested brackets, strings and
// comments do not. This is what makes an option value such as `Frame -> {1, |}`
// one argument rather than two.
function callArgumentStart(code, open, caret, ctx) {
  ctx = ctx || scanContext(code, caret);
  for (let i = ctx.stack.length - 1; i >= 0; i -= 1) {
    if (ctx.stack[i].open === open) return ctx.stack[i].argStart;
  }
  return open + 1;
}

// The range of one argument of the call opened at `open`, by zero-based index. A missing
// argument is the empty range at the call's closing bracket, which lets a caller append
// it with the usual separator.
function callArgumentRange(code, open, index) {
  const close = matchForward(code, open);
  const end = close < 0 ? code.length : close;
  let depth = 0;
  let start = open + 1;
  let count = 0;
  let found = null;
  walkStructure(code, open + 1, end, function (kind, at) {
    if (kind === "open") {
      depth += 1;
      return false;
    }
    if (kind === "close") {
      if (depth > 0) depth -= 1;
      return false;
    }
    if (kind === "comma" && depth === 0) {
      if (count === index) {
        found = { start: start, end: at };
        return true;
      }
      count += 1;
      start = at + 1;
    }
    return false;
  });
  if (found) return found;
  if (count === index) return { start: start, end: end };
  return { start: end, end: end, missing: true };
}

// The option rule at the start of an argument: `Name -> ...` or `Name :> ...`.
// The same pattern decides the option names used by the call, the left side of a
// completion's option context, and the roles of the curated prototypes. One pattern
// keeps context-qualified names (`Ctx`Name`) recognized by all of them.
const OPTION_RULE = /^\s*([A-Za-z][A-Za-z0-9$`]*)\s*(?:->|:>)/;

function optionRuleName(argument) {
  const match = OPTION_RULE.exec(argument);
  return match ? match[1] : "";
}

// The option rule the caret is in: `Name -> value` or `Name :> value` at the start
// of the current argument. `value` is the text between the arrow and the caret.
function optionRuleAt(code, open, caret, ctx) {
  const start = callArgumentStart(code, open, caret, ctx);
  const argument = code.slice(start, caret);
  const match = OPTION_RULE.exec(argument);
  if (!match) return null;
  return { option: match[1], value: argument.slice(match[0].length) };
}

// Where the argument the caret is in ends: the next top-level comma or closing
// bracket of the innermost open group. The caret can be inside a string or comment. The
// walker resumes from that state before looking for the delimiter. `nextSlot` uses the
// call-level `callArgumentRange` instead, so a nested list does not trap the caret.
function argumentEnd(code, caret, ctx) {
  ctx = ctx || scanContext(code, caret);
  const level = ctx.stack.length;
  let depth = level;
  let end = code.length;
  walkStructure(
    code,
    caret,
    code.length,
    function (kind, index) {
      if (kind === "open") {
        depth += 1;
        return false;
      }
      if (kind === "close") {
        if (depth <= level) {
          end = index;
          return true;
        }
        depth -= 1;
        return false;
      }
      if (kind === "comma" && depth === level) {
        end = index;
        return true;
      }
      return false;
    },
    { inString: ctx.inString, commentDepth: ctx.commentDepth }
  );
  return end;
}

// The index of the closer that matches the opener at `at`, or -1. Strings and
// `(* comments *)` are skipped, so a bracket inside them does not count.
function matchForward(code, at) {
  const open = code.charAt(at);
  if (open === "<" && code.charAt(at + 1) !== "|") return -1;
  if (open !== "<" && !CLOSER[open]) return -1;
  let depth = 1;
  let found = -1;
  walkStructure(code, open === "<" ? at + 2 : at + 1, code.length, function (kind, index) {
    if (kind === "open") {
      depth += 1;
      return false;
    }
    if (kind === "close") {
      depth -= 1;
      if (depth === 0) {
        found = index;
        return true;
      }
    }
    return false;
  });
  return found;
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
    return { start: start, end: stringEnd(code, i, code.length).end };
  }
  if (ch === "(" || ch === "{" || (ch === "<" && code.charAt(i + 1) === "|")) {
    const matched = matchForward(code, i);
    if (matched < 0) return null;
    return { start: start, end: ch === "<" ? matched + 2 : matched + 1 };
  }
  return null;
}

// Adds the option name at the start of one argument (a rule) or the names of a
// top-level options list (`{Frame -> True, Axes -> False}`). Only the list's own
// top level contributes names. A rule inside an `Epilog` value does not.
function addOptionName(names, segment) {
  const option = optionRuleName(segment);
  if (option) names[option] = true;
}

function addOptionArgument(names, argument) {
  const text = argument.trim();
  if (!text) return;
  if (text.charAt(0) !== "{") {
    addOptionName(names, text);
    return;
  }
  const close = matchForward(text, 0);
  if (close < 0) return;
  let depth = 0;
  let start = 1;
  walkStructure(text, 1, close, function (kind, index) {
    if (kind === "open") {
      depth += 1;
      return false;
    }
    if (kind === "close") {
      if (depth > 0) depth -= 1;
      return false;
    }
    if (kind === "comma" && depth === 0) {
      addOptionName(names, text.slice(start, index));
      start = index + 1;
    }
    return false;
  });
  addOptionName(names, text.slice(start, close));
}

// The option names written at the top level of the call opened at `open`, with
// strings, comments and nested brackets skipped. The old regex looked through all of
// them, so a `Frame ->` in an Epilog or in a string outside the call counted as used.
function optionNamesInCall(code, open) {
  const names = {};
  const close = matchForward(code, open);
  const end = close < 0 ? code.length : close;
  let depth = 0;
  let start = open + 1;
  walkStructure(code, open + 1, end, function (kind, index) {
    if (kind === "open") {
      depth += 1;
      return false;
    }
    if (kind === "close") {
      if (depth > 0) depth -= 1;
      return false;
    }
    if (kind === "comma" && depth === 0) {
      addOptionArgument(names, code.slice(start, index));
      start = index + 1;
    }
    return false;
  });
  addOptionArgument(names, code.slice(start, end));
  return names;
}

export {
  argumentEnd,
  callArgumentRange,
  closersFor,
  identifierEnd,
  matchForward,
  operandAt,
  optionNamesInCall,
  optionRuleAt,
  optionRuleName,
  prefixSpan,
  scanContext,
};
