//! JSON helpers: escaping, the flat field readers a request body needs, and the reply envelopes.

/// Minimal JSON string escaping (the interpreter output is the payload).
pub(crate) fn json_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

pub(crate) fn json_number(value: f64) -> String {
    if value.is_finite() {
        format!("{value}")
    } else {
        "null".to_string()
    }
}

/// The message shape used by the plot-interaction channel: one request object in,
/// one reply object out. `msg_type` says what to do, `content` carries the fields,
/// and a reply reports `status` with an `ename`/`evalue` pair on failure, the way a
/// Jupyter message does.
pub(crate) fn json_field_text(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let at = json.find(&needle)? + needle.len();
    let rest = json[at..].trim_start().strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    // Unescape as we go: user code arrives as a JSON string, so a `"PlotLabel -> \"hi\""`
    // must come back out exactly as it was typed.
    let mut value = String::new();
    let mut chars = rest.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => return Some(value),
            '\\' => match chars.next()? {
                'n' => value.push('\n'),
                't' => value.push('\t'),
                'r' => value.push('\r'),
                'b' => value.push('\u{8}'),
                'f' => value.push('\u{c}'),
                'u' => {
                    let hex: String = chars.by_ref().take(4).collect();
                    value.push(char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?);
                }
                other => value.push(other),
            },
            other => value.push(other),
        }
    }
    None
}

pub(crate) fn json_field_number(json: &str, key: &str) -> Option<f64> {
    let needle = format!("\"{key}\"");
    let at = json.find(&needle)? + needle.len();
    let rest = json[at..].trim_start().strip_prefix(':')?.trim_start();
    let end = rest
        .find(|c: char| {
            !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+' || c == 'e' || c == 'E')
        })
        .unwrap_or(rest.len());
    if end == 0 {
        return None;
    }
    rest[..end].parse().ok()
}

pub(crate) fn json_field_numbers(json: &str, key: &str) -> Option<Vec<f64>> {
    let needle = format!("\"{key}\"");
    let at = json.find(&needle)? + needle.len();
    let rest = json[at..].trim_start().strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('[')?;
    let end = rest.find(']')?;
    rest[..end]
        .split(',')
        .map(|part| part.trim().parse::<f64>().ok())
        .collect()
}

pub(crate) fn json_handle(json: &str) -> Option<u64> {
    json_field_number(json, "handle").map(|value| value as u64)
}

/// The range a request asks for, as `((x0, x1), (y0, y1))`.
pub(crate) fn json_view(json: &str) -> Option<((f64, f64), (f64, f64))> {
    let x = json_field_numbers(json, "x")?;
    let y = json_field_numbers(json, "y")?;
    if x.len() != 2 || y.len() != 2 {
        return None;
    }
    if x.iter().chain(y.iter()).any(|value| !value.is_finite()) {
        return None;
    }
    if x[0] >= x[1] || y[0] >= y[1] {
        return None;
    }
    Some(((x[0], x[1]), (y[0], y[1])))
}

pub(crate) fn reply_ok(msg_type: &str, content: &str) -> String {
    format!(
        "{{\"msg_type\":\"{}_reply\",\"status\":\"ok\",\"content\":{}}}",
        msg_type, content
    )
}

pub(crate) fn reply_error(msg_type: &str, ename: &str, evalue: &str) -> String {
    format!(
        "{{\"msg_type\":\"{}_reply\",\"status\":\"error\",\"ename\":\"{}\",\"evalue\":\"{}\"}}",
        msg_type,
        json_escape(ename),
        json_escape(evalue)
    )
}

/// A JSON array of strings under `key`. The notebook queries send arrays of entry
/// texts, which is the only array shape they need.
pub(crate) fn json_string_array(json: &str, key: &str) -> Vec<String> {
    let needle = format!("\"{key}\"");
    let Some(at) = json.find(&needle) else {
        return Vec::new();
    };
    let rest = &json[at + needle.len()..];
    let Some(start) = rest.find('[') else {
        return Vec::new();
    };
    let mut chars = rest[start + 1..].chars().peekable();
    let mut out = Vec::new();
    while let Some(ch) = chars.next() {
        if ch == ']' {
            break;
        }
        if ch != '"' {
            continue;
        }
        let mut value = String::new();
        while let Some(ch) = chars.next() {
            match ch {
                '"' => break,
                '\\' => match chars.next() {
                    Some('n') => value.push('\n'),
                    Some('t') => value.push('\t'),
                    Some('r') => value.push('\r'),
                    Some(other) => value.push(other),
                    None => break,
                },
                other => value.push(other),
            }
        }
        out.push(value);
    }
    out
}
