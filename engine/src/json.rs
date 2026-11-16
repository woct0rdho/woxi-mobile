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

/// A JSON array of already-encoded values.
pub(crate) fn json_array(values: impl IntoIterator<Item = String>) -> String {
    let values: Vec<String> = values.into_iter().collect();
    format!("[{}]", values.join(","))
}

/// A JSON object from its fields, in the order given. `None` leaves a field out, which is
/// how an optional one stays optional without the caller tracking commas.
pub(crate) fn json_object(fields: &[(&str, Option<String>)]) -> String {
    let mut out = String::with_capacity(64);
    out.push('{');
    let mut first = true;
    for (key, value) in fields {
        let Some(value) = value else {
            continue;
        };
        if !first {
            out.push(',');
        }
        first = false;
        out.push('"');
        out.push_str(key);
        out.push_str("\":");
        out.push_str(value);
    }
    out.push('}');
    out
}

/// A `[x, y]` range as JSON.
pub(crate) fn json_range(range: (f64, f64)) -> String {
    json_array([json_number(range.0), json_number(range.1)])
}

/// The byte offset of `"key":` outside a JSON string, or `None`. The field readers used
/// to search the raw request text, so a code string containing `"cursor_pos"` or
/// `"notebook_codes"` could be mistaken for the real field. The requests are flat
/// objects of scalars/arrays under `content`, so one string-aware pass is enough.
fn find_key(json: &str, key: &str) -> Option<usize> {
    let needle = format!("\"{key}\"");
    let bytes = json.as_bytes();
    let mut i = 0;
    let mut in_string = false;
    let mut escaped = false;
    while i < bytes.len() {
        let byte = bytes[i];
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if byte == b'"' {
            if json[i..].starts_with(&needle) {
                let mut after = i + needle.len();
                while after < bytes.len() && bytes[after].is_ascii_whitespace() {
                    after += 1;
                }
                if after < bytes.len() && bytes[after] == b':' {
                    return Some(i);
                }
            }
            in_string = true;
        }
        i += 1;
    }
    None
}

/// The message shape used by the plot-interaction channel: one request object in,
/// one reply object out. `msg_type` says what to do, `content` carries the fields,
/// and a reply reports `status` with an `ename`/`evalue` pair on failure, the way a
/// Jupyter message does.
pub(crate) fn json_field_text(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let at = find_key(json, key)? + needle.len();
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

/// A boolean field that may be absent, so a request can default it (a missing picture means
/// "send the markup", which is what a gesture frame leaves out by omitting the flag).
pub(crate) fn json_field_bool_opt(json: &str, key: &str) -> Option<bool> {
    let needle = format!("\"{key}\"");
    let at = find_key(json, key)? + needle.len();
    let rest = json[at..].trim_start().strip_prefix(':')?.trim_start();
    Some(rest.starts_with("true"))
}

pub(crate) fn json_field_number(json: &str, key: &str) -> Option<f64> {
    let needle = format!("\"{key}\"");
    let at = find_key(json, key)? + needle.len();
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
    let at = find_key(json, key)? + needle.len();
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
    let Some(at) = find_key(json, key) else {
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
                    Some('b') => value.push('\u{8}'),
                    Some('f') => value.push('\u{c}'),
                    Some('u') => {
                        let hex: String = chars.by_ref().take(4).collect();
                        if let Some(ch) =
                            u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32)
                        {
                            value.push(ch);
                        }
                    }
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

#[cfg(test)]
mod tests {
    use super::{json_field_number, json_field_text, json_string_array};

    #[test]
    fn a_code_string_that_names_a_field_does_not_win_over_the_real_field() {
        let json = r#"{"content":{"code":"\"cursor_pos\":","cursor_pos":3,"limit":24,"notebook_codes":["Sin[x]",""]}}"#;
        assert_eq!(
            json_field_text(json, "code").as_deref(),
            Some("\"cursor_pos\":")
        );
        assert_eq!(json_field_number(json, "cursor_pos"), Some(3.0));
        assert_eq!(json_field_number(json, "limit"), Some(24.0));
        assert_eq!(
            json_string_array(json, "notebook_codes"),
            vec!["Sin[x]", ""]
        );
    }

    #[test]
    fn a_field_named_in_a_string_is_skipped_even_with_escaped_quotes() {
        let json = r#"{"content":{"code":"\"notebook_codes\": [1]","notebook_codes":["Plot"]}}"#;
        assert_eq!(json_string_array(json, "notebook_codes"), vec!["Plot"]);
    }

    #[test]
    fn unicode_escapes_in_an_array_are_decoded() {
        let json = r#"{"codes":["a\u0000b","c\u00e9"]}"#;
        assert_eq!(json_string_array(json, "codes"), vec!["a\0b", "c\u{e9}"]);
    }
}
