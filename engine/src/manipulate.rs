//! Manipulate: reading a control spec and re-rendering the body with new slider values.

use crate::json::json_escape;

/// One control of a `Manipulate[...]`, parsed from the source text.
pub(crate) struct Control {
    name: String,
    kind: &'static str, // "continuous" | "discrete" | "checkbox"
    min: Option<f64>,
    max: Option<f64>,
    step: Option<f64>,
    values: Vec<String>,
    initial: String,
}

/// Splits `s` on top-level commas (ignoring commas inside (), [], {}).
pub(crate) fn split_top_level(s: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut current = String::new();
    let mut in_string = false;
    let mut escaped = false;
    for ch in s.chars() {
        if in_string {
            current.push(ch);
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
            '"' => {
                in_string = true;
                current.push(ch);
            }
            '(' | '[' | '{' => {
                depth += 1;
                current.push(ch);
            }
            ')' | ']' | '}' => {
                depth -= 1;
                current.push(ch);
            }
            ',' if depth == 0 => {
                parts.push(current.trim().to_string());
                current = String::new();
            }
            _ => current.push(ch),
        }
    }
    let tail = current.trim().to_string();
    if !tail.is_empty() {
        parts.push(tail);
    }
    parts
}

pub(crate) fn strip_braces(s: &str) -> &str {
    let t = s.trim();
    if t.starts_with('{') && t.ends_with('}') && t.len() >= 2 {
        &t[1..t.len() - 1]
    } else {
        t
    }
}

/// Parses `Manipulate[body, {name, ...}, ...]` into (body, controls).
pub(crate) fn parse_manipulate(stmt: &str) -> Option<(String, Vec<Control>)> {
    let trimmed = stmt.trim();
    let open = trimmed.find('[')?;
    if !trimmed[..open].trim().eq_ignore_ascii_case("Manipulate") {
        return None;
    }
    if !trimmed.ends_with(']') {
        return None;
    }
    let inner = &trimmed[open + 1..trimmed.len() - 1];
    let args = split_top_level(inner);
    if args.len() < 2 {
        return None;
    }
    let body = args[0].clone();
    let mut controls = Vec::new();
    for spec in &args[1..] {
        let fields = split_top_level(strip_braces(spec));
        if fields.len() < 2 {
            return None; // unsupported control form: fall back to plain output
        }
        let name = fields[0].trim().to_string();
        let rest: Vec<String> = fields[1..].iter().map(|f| f.trim().to_string()).collect();
        let numeric = |s: &str| s.parse::<f64>().ok();

        // {a, 1, 5} | {a, 1, 5, 0.1} | {a, 1, 5, 0.1, 1} | {a, {1, 2, 3}} | {b, True}
        if rest.len() == 1 {
            let value = &rest[0];
            let bare = strip_braces(value).to_string();
            if bare.eq_ignore_ascii_case("true") || bare.eq_ignore_ascii_case("false") {
                controls.push(Control {
                    name,
                    kind: "checkbox",
                    min: None,
                    max: None,
                    step: None,
                    values: Vec::new(),
                    initial: bare.to_lowercase(),
                });
                continue;
            }
            let values = split_top_level(&bare);
            if values.len() > 1 {
                controls.push(Control {
                    name,
                    kind: "discrete",
                    min: None,
                    max: None,
                    step: None,
                    values: values.clone(),
                    initial: values[0].clone(),
                });
                continue;
            }
            return None;
        }

        let (min, max) = (numeric(&rest[0]), numeric(&rest[1]));
        if let (Some(min), Some(max)) = (min, max) {
            let step = rest.get(2).and_then(|s| numeric(s));
            let initial = rest.get(3).and_then(|s| numeric(s)).unwrap_or(min);
            controls.push(Control {
                name,
                kind: if step.is_some() {
                    "discrete"
                } else {
                    "continuous"
                },
                min: Some(min),
                max: Some(max),
                step,
                values: Vec::new(),
                initial: format!("{initial}"),
            });
        } else {
            return None;
        }
    }
    Some((body, controls))
}

pub(crate) fn manipulate_json(
    body: &str,
    controls: &[Control],
    initial_svg: Option<&str>,
) -> String {
    let mut json = String::from("{\"type\":\"manipulate\",\"body\":\"");
    json.push_str(&json_escape(body));
    json.push_str("\",\"controls\":[");
    for (index, control) in controls.iter().enumerate() {
        if index > 0 {
            json.push(',');
        }
        json.push_str("{\"kind\":\"");
        json.push_str(control.kind);
        json.push_str("\",\"name\":\"");
        json.push_str(&json_escape(&control.name));
        json.push_str("\",\"initial\":\"");
        json.push_str(&json_escape(&control.initial));
        json.push('"');
        if let Some(min) = control.min {
            json.push_str(&format!(",\"min\":{min}"));
        }
        if let Some(max) = control.max {
            json.push_str(&format!(",\"max\":{max}"));
        }
        if let Some(step) = control.step {
            json.push_str(&format!(",\"step\":{step}"));
        }
        if !control.values.is_empty() {
            json.push_str(",\"values\":[");
            for (i, value) in control.values.iter().enumerate() {
                if i > 0 {
                    json.push(',');
                }
                json.push_str(&format!("\"{}\"", json_escape(value)));
            }
            json.push(']');
        }
        json.push('}');
    }
    json.push_str("],\"initial\":{");
    match initial_svg {
        Some(svg) => json.push_str(&format!("\"svg\":\"{}\"", json_escape(svg))),
        None => json.push_str("\"text\":\"\""),
    }
    json.push_str("}}");
    json
}

/// Renders a `Manipulate` body with its initial control values.
///
/// Evaluating the body (rather than the whole `Manipulate[...]` statement) is what
/// gives the widget its starting picture: the statement itself only echoes its source.
pub(crate) fn manipulate_initial_svg(body: &str, controls: &[Control]) -> Option<String> {
    let bindings: Vec<(String, String)> = controls
        .iter()
        .filter(|control| is_plain_symbol(&control.name))
        .map(|control| (control.name.clone(), control.initial.clone()))
        .collect();
    render_body(body, &bindings)
}

/// Substitutes bindings before the body is evaluated (`With`, not `/.`: with
/// `ReplaceAll` the body would already have been evaluated, and `Plot` never sees the
/// substituted value).
pub(crate) fn render_body(body: &str, bindings: &[(String, String)]) -> Option<String> {
    let expression = if bindings.is_empty() {
        body.to_string()
    } else {
        let assignments: Vec<String> = bindings
            .iter()
            .map(|(name, value)| format!("{name} = {value}"))
            .collect();
        format!("With[{{{}}}, {}]", assignments.join(", "), body)
    };
    let result = woxi::interpret_with_stdout(&expression).ok()?;
    result
        .graphics
        .or(result.output_svg)
        .filter(|svg| !svg.trim().is_empty())
}

pub(crate) fn is_plain_symbol(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_alphanumeric() || ch == '_' || ch == '@')
}

/// Tiny parser for the flat `{"name":"InputForm"}` binding objects we produce.
pub(crate) fn parse_bindings(json: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let bytes: Vec<char> = json.chars().collect();
    let mut index = 0;
    while index < bytes.len() {
        // key
        while index < bytes.len() && bytes[index] != '"' {
            index += 1;
        }
        if index >= bytes.len() {
            break;
        }
        index += 1;
        let mut key = String::new();
        while index < bytes.len() && bytes[index] != '"' {
            if bytes[index] == '\\' && index + 1 < bytes.len() {
                index += 1;
            }
            key.push(bytes[index]);
            index += 1;
        }
        index += 1;
        // colon + value
        while index < bytes.len() && bytes[index] != '"' {
            index += 1;
        }
        if index >= bytes.len() {
            break;
        }
        index += 1;
        let mut value = String::new();
        while index < bytes.len() && bytes[index] != '"' {
            if bytes[index] == '\\' && index + 1 < bytes.len() {
                index += 1;
                if bytes[index] == 'n' {
                    value.push('\n');
                    index += 1;
                    continue;
                }
            }
            value.push(bytes[index]);
            index += 1;
        }
        index += 1;
        if !key.is_empty() {
            out.push((key, value));
        }
    }
    out
}
