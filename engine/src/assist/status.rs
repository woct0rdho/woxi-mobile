//! Completeness: whether an entry is unfinished, invalid, or ready to run.

use crate::json::json_field_text;

/// Bracket depth, ignoring string literals and `(* comments *)`. A positive result
/// means the input stops inside an opening bracket or an unterminated string, which
/// is what "not finished yet" looks like while typing.
pub(crate) fn bracket_depth(code: &str) -> i32 {
    let mut depth: i32 = 0;
    let mut chars = code.chars().peekable();
    let mut in_string = false;
    let mut comment_depth = 0usize;
    while let Some(ch) = chars.next() {
        if comment_depth > 0 {
            if ch == '(' && chars.peek() == Some(&'*') {
                chars.next();
                comment_depth += 1;
            } else if ch == '*' && chars.peek() == Some(&')') {
                chars.next();
                comment_depth -= 1;
            }
            continue;
        }
        if in_string {
            match ch {
                '\\' => {
                    chars.next();
                }
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '(' if chars.peek() == Some(&'*') => {
                chars.next();
                comment_depth = 1;
            }
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            _ => {}
        }
        if depth < 0 {
            return depth;
        }
    }
    if in_string || comment_depth > 0 {
        depth.max(1)
    } else {
        depth
    }
}

/// Whether the input stops on an operator (`1 + `), which the parser reports as an
/// error but the user is still writing.
pub(crate) fn ends_with_operator(code: &str) -> bool {
    let trimmed = code.trim_end();
    if trimmed.is_empty() {
        return false;
    }
    const TAILS: [&str; 15] = [
        "->", ":=", "/;", "/@", "//", "/.", ";;", "==", "<=", ">=", "!=", "&&", "||", "=.", "<>",
    ];
    if TAILS.iter().any(|tail| trimmed.ends_with(tail)) {
        return true;
    }
    matches!(
        trimmed.chars().last(),
        Some('+' | '-' | '*' | '/' | '^' | ',' | '=' | '&' | '|' | '@' | '~' | '<' | '>' | ':')
    )
}

pub(crate) fn is_complete_status(code: &str) -> &'static str {
    if code.trim().is_empty() {
        return "complete";
    }
    let depth = bracket_depth(code);
    if depth > 0 || ends_with_operator(code) {
        "incomplete"
    } else if depth < 0 || woxi::parse(code).is_err() {
        "invalid"
    } else {
        "complete"
    }
}

pub(crate) fn is_complete_content(json: &str) -> String {
    let code = json_field_text(json, "code").unwrap_or_default();
    let status = is_complete_status(&code);
    format!("{{\"status\":\"{status}\",\"indent\":\"\"}}")
}
