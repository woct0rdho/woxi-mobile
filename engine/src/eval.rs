//! Evaluation: one entry at a time, and the items its statements produce.

use crate::manipulate::{
    is_plain_symbol, manipulate_initial, manipulate_json, parse_bindings, parse_manipulate,
    render_body, rendered_json,
};
use crate::output::{graphics_item_with_plot, graphics_item_with_plot3d, item, residual_text};
use crate::plot::{capture_statement, register_plot, repair_graphic, repair_svg_contour, Capture};

/// Splits a cell on top-level semicolons, respecting brackets and quoted strings. Woxi's
/// statement splitter keeps `a = 2; Plot[...]` together, and `string_to_expr` parses only
/// the first expression of a string, so a cell that holds several statements has to be
/// split here before the last one is parsed.
pub(crate) fn split_semicolons(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    let mut start = 0usize;
    for (index, ch) in text.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            ';' if depth == 0 => {
                parts.push(&text[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    parts.push(&text[start..]);
    parts
}

/// The interpreter answers bare numbers, quoted strings and simple braced lists on a fast
/// path that does not record `%`/`Out[]` history, which makes `%` after such a cell resolve
/// to whatever came before it. Parenthesizing the statement routes it through the normal
/// path, which does record it. The value and its typesetting are unchanged.
pub(crate) fn literal_statement(statement: &str) -> String {
    let trimmed = statement.trim();
    if trimmed.is_empty() || trimmed.ends_with(';') {
        return statement.to_string();
    }
    let literal = trimmed.parse::<i64>().is_ok()
        || (trimmed.contains('.') && trimmed.parse::<f64>().is_ok())
        || (trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"'))
        || (trimmed.starts_with('{') && trimmed.ends_with('}'));
    if literal {
        format!("({trimmed})")
    } else {
        statement.to_string()
    }
}

pub(crate) fn evaluate_statement_items(stmt: &str, capture: Capture) -> Vec<String> {
    let mut items = Vec::new();
    // Bare literals are answered by an interpreter fast path that does not record
    // `%` history. See `literal_statement`.
    let evaluated = literal_statement(stmt);
    match woxi::interpret_with_stdout(&evaluated) {
        Ok(mut result) => {
            let stdout = result.stdout.trim_end();
            if !stdout.is_empty() {
                items.push(item("print", stdout, None));
            }
            for warning in &result.warnings {
                items.push(item("warning", warning, None));
            }

            let contour = capture.contour();
            let mut output = woxi::get_last_output();
            let repaired_svg = if contour {
                if let Some(expr) = output.as_mut() {
                    repair_graphic(expr);
                }
                output.as_ref().and_then(|expr| match expr {
                    woxi::syntax::Expr::Graphics { svg, .. } if !svg.trim().is_empty() => {
                        Some(svg.clone())
                    }
                    _ => None,
                })
            } else {
                None
            };
            let mut graphics = result.graphics.take();
            // A wrapped output has no direct `Graphics` at the top level. Its
            // rendered string is the only picture available here.
            if contour && repaired_svg.is_none() {
                if let Some(svg) = graphics.as_mut() {
                    *svg = repair_svg_contour(svg);
                }
            }
            let graphics = graphics.as_deref().filter(|svg| !svg.trim().is_empty());

            // Interactive controls are emitted with the view they start on.
            if let Some((body, controls)) = parse_manipulate(stmt) {
                let initial = manipulate_initial(&body, &controls);
                items.push(manipulate_json(&body, &controls, initial.as_ref()));
                return items;
            }

            if let Some(scene3d) = output
                .as_ref()
                .and_then(|expr| crate::scene3d::scene3d(expr, stmt))
            {
                items.push(graphics_item_with_plot3d(&scene3d));
                let residual = residual_text(&result.result);
                if !residual.is_empty() {
                    items.push(item("text", &residual, None));
                }
            } else if let Some(svg) = graphics {
                // A direct `Graphics` now carries the repaired SVG. For a wrapped
                // output (`Legended`, `Show`, ...) the repaired `result.graphics` is
                // the picture the item gets.
                let svg = repaired_svg.as_deref().unwrap_or(svg);
                // The payload and the samples of an interactive plot. The samples are the
                // picture's own points: there is no pre-sample, so the first gesture starts from
                // exactly the range the picture shows. A two-axis renderer reports those points
                // mirrored in y, which `plot_layer` undoes.
                let (plot, layer) = match output
                    .as_ref()
                    .and_then(|expr| register_plot(expr, &capture))
                {
                    Some((payload, samples)) => (Some(payload), Some(samples)),
                    None => (None, None),
                };
                items.push(graphics_item_with_plot(
                    Some(svg),
                    plot.as_deref(),
                    layer.as_deref(),
                ));
                let residual = residual_text(&result.result);
                if !residual.is_empty() {
                    items.push(item("text", &residual, None));
                }
            } else if let Some(svg) = result
                .output_svg
                .as_deref()
                .filter(|svg| !svg.trim().is_empty())
            {
                let svg = crate::typeset::respace_svg(svg);
                items.push(item("text", &result.result, Some(&svg)));
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
        let capture = capture_statement(&statement);
        items.extend(evaluate_statement_items(&statement, capture));
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
    rendered_json(render_body(body, &bindings).as_ref())
}

#[cfg(test)]
mod tests {
    use super::{evaluate_all, literal_statement, split_semicolons};

    fn reset() {
        woxi::clear_state();
    }

    #[test]
    fn bare_literals_are_parenthesized() {
        assert_eq!(literal_statement("42"), "(42)");
        assert_eq!(literal_statement(" 3.5 "), "(3.5)");
        assert_eq!(literal_statement("\"hi\""), "(\"hi\")");
        assert_eq!(literal_statement("{1, 2}"), "({1, 2})");
        assert_eq!(literal_statement("42;"), "42;");
        assert_eq!(literal_statement("a = 1"), "a = 1");
        assert_eq!(
            literal_statement("Plot[Sin[x], {x, 0, 1}]"),
            "Plot[Sin[x], {x, 0, 1}]"
        );
    }

    #[test]
    fn semicolons_split_at_top_level_only() {
        assert_eq!(split_semicolons("a = 2; Plot[a x, {x, 0, 1}]").len(), 2);
        assert_eq!(split_semicolons("f[1;2]; g").len(), 2);
        assert_eq!(split_semicolons("\"a;b\"; c").len(), 2);
        assert_eq!(split_semicolons("a = 2").len(), 1);
    }

    #[test]
    fn percent_sees_bare_literals() {
        reset();
        evaluate_all("42");
        let items = evaluate_all("%");
        assert!(items.contains("\"text\":\"42\""), "{items}");
    }
}
