//! Inspect: the description, status, attributes, arity and options of one symbol.

use crate::assist::complete::{
    category_of, cursor_of, identifier_at_cursor, is_symbol_name, status_name,
};
use crate::json::{json_escape, json_field_text};
use woxi::syntax::Expr;

/// The options a symbol takes with their declared defaults, in declaration order.
/// `Options[f]` is evaluated through `interpret_to_expr`, which does not record
/// `Out[]` history.
pub(crate) fn options_of(name: &str) -> Vec<(String, String)> {
    if !is_symbol_name(name) {
        return Vec::new();
    }
    let Ok(value) = woxi::interpret_to_expr(&format!("Options[{name}]")) else {
        return Vec::new();
    };
    let Expr::List(rules) = &value else {
        return Vec::new();
    };
    let mut options = Vec::new();
    for rule in rules.iter() {
        // Options may be declared with a delayed rule (`DisplayFunction :> ...`), which
        // Woxi 0.4 uses for several of Plot's defaults.
        let (pattern, replacement) = match rule {
            Expr::Rule {
                pattern,
                replacement,
            }
            | Expr::RuleDelayed {
                pattern,
                replacement,
            } => (pattern, replacement),
            _ => continue,
        };
        if let Expr::Identifier(option) = pattern.as_ref() {
            let default = woxi::syntax::expr_to_input_form(replacement);
            options.push((option.clone(), default));
        }
    }
    options
}

/// The attributes a symbol carries (`HoldAll`, `Listable`, ...). Read through
/// `Attributes[...]`, which does not record `Out[]` history. They are the part of a
/// symbol's behaviour an experienced user actually reasons about: whether its
/// arguments are evaluated is often the whole question.
pub(crate) fn attributes_of(name: &str) -> Vec<String> {
    if !is_symbol_name(name) {
        return Vec::new();
    }
    let Ok(value) = woxi::interpret_to_expr(&format!("Attributes[{name}]")) else {
        return Vec::new();
    };
    let Expr::List(items) = &value else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| match item {
            Expr::Identifier(name) => Some(name.clone()),
            _ => None,
        })
        .collect()
}

pub(crate) fn inspect_content(json: &str) -> String {
    let code = json_field_text(json, "code").unwrap_or_default();
    let cursor = cursor_of(json, &code);
    let name = identifier_at_cursor(&code, cursor);
    if !is_symbol_name(name) {
        return "{\"found\":false,\"data\":{},\"metadata\":{}}".to_string();
    }

    let implemented = !woxi::evaluator::functions::is_known_wolfram_function(name);
    let description = woxi::evaluator::functions::get_builtin_function_info(name)
        .map(|info| info.description.to_string())
        .unwrap_or_default();
    let (category, doc) = category_of(name);
    let options = options_of(name);
    let arity = woxi::evaluator::dispatch::arg_count::get_arg_count_range(name);
    let arity_json = match arity {
        Some((min, max)) if max == usize::MAX => format!("[{min},null]"),
        Some((min, max)) => format!("[{min},{max}]"),
        None => "null".to_string(),
    };

    let mut lines = vec![name.to_string()];
    if !description.is_empty() {
        lines.push(description.clone());
    }
    if !options.is_empty() {
        let names: Vec<&str> = options.iter().map(|(option, _)| option.as_str()).collect();
        lines.push(format!("Options: {}", names.join(", ")));
    }
    if let Some((min, max)) = arity {
        lines.push(if max == usize::MAX {
            format!("{min} or more arguments")
        } else if min == max {
            format!("{min} argument(s)")
        } else {
            format!("{min} to {max} arguments")
        });
    }
    if let Some(url) = doc {
        lines.push(url.to_string());
    }

    let option_json: Vec<String> = options
        .iter()
        .map(|(option, _)| format!("\"{}\"", json_escape(option)))
        .collect();
    let default_json: Vec<String> = options
        .iter()
        .map(|(option, default)| {
            format!("[\"{}\",\"{}\"]", json_escape(option), json_escape(default))
        })
        .collect();
    let attribute_json: Vec<String> = attributes_of(name)
        .iter()
        .map(|attribute| format!("\"{}\"", json_escape(attribute)))
        .collect();
    format!(
        "{{\"found\":true,\"data\":{{\"text/plain\":\"{}\"}},\"metadata\":{{\"_woxi\":{{\"name\":\"{}\",\"description\":\"{}\",\"implemented\":{},\"status\":\"{}\",\"attributes\":[{}],\"category\":\"{}\",\"doc\":\"{}\",\"arity\":{},\"options\":[{}],\"optionDefaults\":[{}]}}}}}}",
        json_escape(&lines.join("\n")),
        json_escape(name),
        json_escape(&description),
        if implemented { 1 } else { 0 },
        status_name(name),
        attribute_json.join(","),
        json_escape(category),
        json_escape(doc.unwrap_or("")),
        arity_json,
        option_json.join(","),
        default_json.join(",")
    )
}
