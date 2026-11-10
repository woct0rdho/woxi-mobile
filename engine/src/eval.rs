//! Evaluation: one entry at a time, and the items its statements produce.

use crate::json::json_escape;
use crate::manipulate::{
    is_plain_symbol, manipulate_initial_svg, manipulate_json, parse_bindings, parse_manipulate,
    render_body,
};
use crate::output::{graphics_item_with_plot, item, residual_text};
use crate::plot::{held_statement, literal_statement, register_plot, Held};

pub(crate) fn evaluate_statement_items(stmt: &str, held: Option<Held>) -> Vec<String> {
    let mut items = Vec::new();
    // Bare literals are answered by an interpreter fast path that does not record
    // `%` history. See `literal_statement`.
    let evaluated = literal_statement(stmt);
    match woxi::interpret_with_stdout(&evaluated) {
        Ok(result) => {
            let stdout = result.stdout.trim_end();
            if !stdout.is_empty() {
                items.push(item("print", stdout, None));
            }
            for warning in &result.warnings {
                items.push(item("warning", warning, None));
            }

            let graphics = result
                .graphics
                .as_deref()
                .filter(|svg| !svg.trim().is_empty());
            let typeset = result
                .output_svg
                .as_deref()
                .filter(|svg| !svg.trim().is_empty());

            // Interactive controls are emitted with the rendered view they start on.
            if let Some((body, controls)) = parse_manipulate(stmt) {
                let initial = manipulate_initial_svg(&body, &controls)
                    .or_else(|| graphics.or(typeset).map(|svg| svg.to_string()));
                items.push(manipulate_json(&body, &controls, initial.as_deref()));
                return items;
            }

            if let Some(svg) = graphics {
                let plot = woxi::get_last_output()
                    .as_ref()
                    .and_then(|expr| register_plot(expr, &held));
                items.push(graphics_item_with_plot(svg, plot.as_deref()));
                let residual = residual_text(&result.result);
                if !residual.is_empty() {
                    items.push(item("text", &residual, None));
                }
            } else if let Some(svg) = typeset {
                items.push(item("text", &result.result, Some(svg)));
            } else if result.result != "\0" {
                items.push(item("text", &result.result, None));
            }
        }
        Err(error) => items.push(item("error", &format!("{error}"), None)),
    }
    items
}

pub(crate) fn evaluate_all(input: &str) -> String {
    let mut items = Vec::new();
    for statement in woxi::split_into_statements(input) {
        if statement.trim().is_empty() {
            continue;
        }
        // Captured before the statement runs, so the interpreter's `%` still refers
        // to the previous result while the statement is being evaluated.
        let held = held_statement(&statement);
        items.extend(evaluate_statement_items(&statement, held));
    }
    format!("[{}]", items.join(","))
}

/// Re-renders a `Manipulate` body with new control values.
/// `bindings_json` maps variable names to InputForm values, e.g. `{"a":"2.5"}`.
pub(crate) fn evaluate_manipulate(body: &str, bindings_json: &str) -> String {
    let bindings: Vec<(String, String)> = parse_bindings(bindings_json)
        .into_iter()
        .filter(|(name, _)| is_plain_symbol(name))
        .collect();
    if bindings.is_empty() {
        return "{}".to_string();
    }
    match render_body(body, &bindings) {
        Some(svg) => format!("{{\"svg\":\"{}\"}}", json_escape(&svg)),
        None => "{}".to_string(),
    }
}
