//! Formatting: Woxi's own whitespace normaliser, one line per entry.
//!
//! The formatter only moves horizontal whitespace and indentation, never line breaks
//! (see `woxi::lsp::format`), and it refuses to return text whose code changed. So
//! applying it to an entry is safe without re-parsing the result.

use crate::json::{json_escape, json_string_array};

pub(crate) fn format_content(json: &str) -> String {
    let codes = json_string_array(json, "codes");
    let mut out = Vec::with_capacity(codes.len());
    for code in &codes {
        let formatted = woxi::lsp::format::format(code, &woxi::lsp::format::Options::default());
        out.push(format!("\"{}\"", json_escape(&formatted)));
    }
    format!("{{\"codes\":[{}]}}", out.join(","))
}
