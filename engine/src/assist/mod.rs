//! Typing help: one dispatch point for the notebook's `*_request` messages.
//!
//! The frontend asks these while the user types: which symbol names match a prefix
//! (`complete_request`), what a symbol is and which options it takes (`inspect_request`),
//! and whether the entry is finished (`is_complete_request`). The first two read the
//! symbol table the interpreter already carries, so the answers agree with what the
//! interpreter actually implements, and the third uses the interpreter's own parser.
//! Nothing here evaluates the entry: the only evaluation is an `Options[...]` probe
//! through `interpret_to_expr`, which does not record `Out[]` history.

pub(crate) mod complete;
pub(crate) mod diagnostics;
pub(crate) mod format;
pub(crate) mod inspect;
pub(crate) mod prototypes;
pub(crate) mod status;

use crate::assist::complete::completion_content;
use crate::assist::diagnostics::diagnostics_content;
use crate::assist::format::format_content;
use crate::assist::inspect::inspect_content;
use crate::assist::prototypes::{catalog_content, definitions_content, prototypes_content};
use crate::assist::status::is_complete_content;
use crate::json::{json_field_text, reply_error, reply_ok};

pub(crate) fn query_request(json: &str) -> String {
    let msg_type = json_field_text(json, "msg_type").unwrap_or_default();
    match msg_type.as_str() {
        "complete_request" => reply_ok(&msg_type, &completion_content(json)),
        "inspect_request" => reply_ok(&msg_type, &inspect_content(json)),
        "is_complete_request" => reply_ok(&msg_type, &is_complete_content(json)),
        "diagnostics_request" => reply_ok(&msg_type, &diagnostics_content(json)),
        "prototypes_request" => reply_ok(&msg_type, &prototypes_content(json)),
        "definitions_request" => reply_ok(&msg_type, &definitions_content(json)),
        "format_request" => reply_ok(&msg_type, &format_content(json)),
        "catalog_request" => reply_ok(&msg_type, &catalog_content()),
        _ => reply_error(&msg_type, "UnknownMessage", "unknown msg_type"),
    }
}
