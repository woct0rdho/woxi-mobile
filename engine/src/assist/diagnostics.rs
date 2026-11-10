//! Diagnostics: Woxi's own analysis of one entry, with the fix a spelling hint implies.

use crate::assist::complete::remember_usage;
use crate::assist::status::is_complete_status;
use crate::json::{json_escape, json_field_text};

/// Syntax, spelling and unsupported-symbol problems in one entry, from Woxi's own
/// forgiving tokenizer and parser.
///
/// Unfinished input has no diagnostics: while a call is still being typed, every
/// missing bracket would be an error. The reply says so with `status: incomplete`
/// instead, which the caller can ignore.
pub(crate) fn diagnostics_content(json: &str) -> String {
    use woxi::lsp::analysis;

    let code = json_field_text(json, "code").unwrap_or_default();
    remember_usage(&code);
    let status = is_complete_status(&code);
    if status == "incomplete" {
        return "{\"status\":\"incomplete\",\"items\":[]}".to_string();
    }

    let tokens = analysis::tokenize(&code);
    let definitions = analysis::find_definitions(&code, &tokens);
    let mut rows = Vec::new();
    for item in analysis::diagnostics(&code, &tokens, &definitions) {
        let severity = match item.severity {
            analysis::Severity::Error => "error",
            analysis::Severity::Warning => "warning",
            analysis::Severity::Information => "info",
        };
        // A spelling hint already carries the name it meant, but as prose. Look the
        // suggestion up again so the frontend gets an edit instead of a sentence.
        let mut fix = String::new();
        if item.code == "spelling" {
            if let Some(token) = analysis::symbol_at(&tokens, item.range.0) {
                let name = token.text(&code);
                if let Some(suggestion) = analysis::spelling_suggestion(name) {
                    fix = format!(
                        ",\"fix\":{{\"label\":\"Replace with {}\",\"insert\":\"{}\",\"start\":{},\"end\":{}}}",
                        json_escape(suggestion),
                        json_escape(suggestion),
                        token.start,
                        token.end
                    );
                }
            }
        }
        rows.push(format!(
            "{{\"start\":{},\"end\":{},\"severity\":\"{severity}\",\"code\":\"{}\",\"message\":\"{}\"{fix}}}",
            item.range.0,
            item.range.1,
            json_escape(item.code),
            json_escape(&item.message)
        ));
    }
    format!(
        " {{\"status\":\"{status}\",\"items\":[{}]}}",
        rows.join(",")
    )
    .trim_start()
    .to_string()
}
