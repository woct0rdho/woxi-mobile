//! Horizontal spacing for the SVG that Woxi's box layout produces.
//!
//! The layout advances a full monospace cell for every character and only
//! widens the operators it knows by name (`+`, `<`, ...). Two consequences look
//! wrong next to the code-like input: a product (`45 x`) gets a whole word
//! space, and a relation the table does not name (`==`, `->`) gets no space at
//! all. This pass rewrites the x positions of the runs - never their glyphs or
//! their nesting:
//! - the gap of a space run between two factors becomes the thin space the
//!   layout itself uses (`0.32` cell, the gap a `U+2009` gets inside a box
//!   string), and
//! - a relation the layout leaves unspaced gets the margins the layout reserves
//!   for its named operators (`0.60` cell for rules, `0.44` for equality and
//!   comparison, `0.34` for the logical operators).
//!
//! Every enclosing group and the SVG width are adjusted by the same amount, so
//! nothing after the changed gap moves relative to its neighbours. Fractions,
//! radicals and other vector-composed boxes are left alone: their internals are
//! centred by the layout, and their run positions are part of that geometry.

/// Character advance of the monospace face the layout assumes, as a fraction
/// of the font size (see `MONO_ADVANCE` in Woxi's `layout_box`).
const MONO_ADVANCE: f64 = 0.632;

/// Width of the thin space as a fraction of one character advance. Matches the
/// gap Woxi's layout puts around a `U+2009` inside a box string.
const THIN_RATIO: f64 = 0.32;

/// Margins (in character advances per side) for operator tokens the layout
/// emits without its `operator_space` rule. The numbers are that rule's own
/// values: rules `->`/`:>` are relations like `=`. `==`/`!=`/`<=`/`>=`/`<>`
/// are equalities. `&&`/`||` are the ASCII spellings of `∧`/`∨`.
fn operator_margin(token: &str) -> Option<f64> {
    match token {
        "→" | "⧴" => Some(0.60),
        "==" | "!=" | "<=" | ">=" | "<>" | "===" | "=!=" => Some(0.44),
        "&&" | "||" => Some(0.34),
        _ => None,
    }
}

/// One parsed SVG node. Only groups and text carry state. Vector elements
/// (`line`, `path`, ...) are kept verbatim.
enum Node {
    Group {
        attrs: String,
        x: f64,
        y: f64,
        translatable: bool,
        children: Vec<Node>,
    },
    Text {
        attrs: String,
        content: String,
    },
    Raw(String),
}

impl Node {
    fn render(&self, out: &mut String) {
        match self {
            Node::Group {
                attrs,
                x,
                y,
                translatable,
                children,
            } => {
                out.push_str("<g");
                if *translatable {
                    out.push_str(&rewrite_translate(attrs, *x, *y));
                } else {
                    out.push_str(attrs);
                }
                out.push('>');
                for child in children {
                    child.render(out);
                }
                out.push_str("</g>");
            }
            Node::Text { attrs, content } => {
                out.push_str("<text");
                out.push_str(attrs);
                out.push('>');
                out.push_str(content);
                out.push_str("</text>");
            }
            Node::Raw(raw) => out.push_str(raw),
        }
    }
}

/// Replaces the `translate(x,y)` in a group's attribute string, keeping every
/// other attribute as the layout wrote it.
fn rewrite_translate(attrs: &str, x: f64, y: f64) -> String {
    let marker = "transform=\"translate(";
    let Some(start) = attrs.find(marker) else {
        return attrs.to_string();
    };
    let value_start = start + marker.len();
    let Some(close) = attrs[value_start..].find(')') else {
        return attrs.to_string();
    };
    let mut out = String::with_capacity(attrs.len() + 8);
    out.push_str(&attrs[..start]);
    out.push_str(&format!("transform=\"translate({x:.1},{y:.1})"));
    out.push_str(&attrs[value_start + close + 1..]);
    out
}

/// Parses the attribute list of a `translate(...)` group, returning `(x, y)`.
fn parse_translate(attrs: &str) -> Option<(f64, f64)> {
    let marker = "transform=\"translate(";
    let start = attrs.find(marker)? + marker.len();
    let end = attrs[start..].find(')')? + start;
    let mut parts = attrs[start..end].split(',');
    let x = parts.next()?.trim().parse().ok()?;
    let y = parts.next()?.trim().parse().ok()?;
    Some((x, y))
}

fn parse_font_size(attrs: &str) -> f64 {
    let marker = "font-size=\"";
    let Some(start) = attrs.find(marker) else {
        return 0.0;
    };
    let start = start + marker.len();
    let Some(end) = attrs[start..].find('"') else {
        return 0.0;
    };
    attrs[start..start + end].parse().unwrap_or(0.0)
}

/// Decodes the XML entities Woxi's `svg_escape` emits, and numeric references.
fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        rest = &rest[pos..];
        let Some(end) = rest.find(';') else {
            out.push_str(rest);
            return out;
        };
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => {
                let value = entity
                    .strip_prefix("#x")
                    .or_else(|| entity.strip_prefix("#X"))
                    .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                    .or_else(|| entity.strip_prefix('#').and_then(|dec| dec.parse().ok()));
                value.and_then(char::from_u32)
            }
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Index of the `>` that closes the tag starting at `lt`, skipping quoted
/// attribute values.
fn tag_end(src: &str, lt: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut quote = 0u8;
    let mut i = lt;
    while i < bytes.len() {
        let b = bytes[i];
        if quote != 0 {
            if b == quote {
                quote = 0;
            }
        } else if b == b'"' || b == b'\'' {
            quote = b;
        } else if b == b'>' {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn parse_children(src: &str) -> (Vec<Node>, usize) {
    let mut nodes = Vec::new();
    let mut i = 0;
    while i < src.len() {
        let Some(rel) = src[i..].find('<') else {
            nodes.push(Node::Raw(src[i..].to_string()));
            i = src.len();
            break;
        };
        if rel > 0 {
            nodes.push(Node::Raw(src[i..i + rel].to_string()));
            i += rel;
        }
        if src[i..].starts_with("</") {
            return (nodes, i);
        }
        let Some(end) = tag_end(src, i) else {
            nodes.push(Node::Raw(src[i..].to_string()));
            i = src.len();
            break;
        };
        let tag = &src[i..=end];
        if tag.starts_with("<g") && !tag.ends_with("/>") {
            let attrs = tag[2..tag.len() - 1].to_string();
            let (children, close) = parse_children(&src[end + 1..]);
            let Some(close_end) = tag_end(&src[end + 1..], close) else {
                nodes.push(Node::Raw(tag.to_string()));
                i = end + 1;
                continue;
            };
            let (x, y) = parse_translate(&attrs).unwrap_or((0.0, 0.0));
            nodes.push(Node::Group {
                attrs: attrs.clone(),
                x,
                y,
                translatable: parse_translate(&attrs).is_some(),
                children,
            });
            i = end + 1 + close_end + 1;
        } else if tag.starts_with("<text") && !tag.ends_with("/>") {
            let attrs = tag[5..tag.len() - 1].to_string();
            let Some(close) = src[end + 1..].find("</text>") else {
                nodes.push(Node::Raw(tag.to_string()));
                i = end + 1;
                continue;
            };
            let content = src[end + 1..end + 1 + close].to_string();
            nodes.push(Node::Text { attrs, content });
            i = end + 1 + close + "</text>".len();
        } else {
            nodes.push(Node::Raw(tag.to_string()));
            i = end + 1;
        }
    }
    (nodes, i)
}

/// What a row child is, for the spacing rules.
enum Atom {
    /// A run of spaces between two factors. `cell` is one character advance.
    Space { chars: usize, cell: f64 },
    /// A relation the layout left without margins. `margin` is in cells.
    Operator {
        margin: f64,
        cell: f64,
        chars: usize,
    },
    /// A box whose internals must not be touched (fraction, radical, frame).
    Opaque,
    /// Anything else, including nested rows.
    Other,
}

fn atom_of(node: &Node) -> Atom {
    let Node::Group { children, .. } = node else {
        return Atom::Opaque;
    };
    // A fraction bar, radical path or rule is geometry, not text: its position
    // is part of the surrounding layout and must not be respaced.
    if children.iter().any(|child| match child {
        Node::Raw(raw) => {
            raw.starts_with("<line")
                || raw.starts_with("<path")
                || raw.starts_with("<rect")
                || raw.starts_with("<circle")
                || raw.starts_with("<ellipse")
                || raw.starts_with("<polygon")
                || raw.starts_with("<polyline")
                || raw.starts_with("<use")
        }
        _ => false,
    }) {
        return Atom::Opaque;
    }
    let [Node::Text { attrs, content }] = children.as_slice() else {
        return Atom::Other;
    };
    let cell = parse_font_size(attrs) * MONO_ADVANCE;
    let text = decode_entities(content);
    if !text.is_empty() && text.chars().all(|c| c == ' ') {
        return Atom::Space {
            chars: text.chars().count(),
            cell,
        };
    }
    let token = text.trim();
    if token.len() == text.len() {
        if let Some(margin) = operator_margin(token) {
            return Atom::Operator {
                margin,
                cell,
                chars: token.chars().count(),
            };
        }
    }
    Atom::Other
}

/// The x of a translatable group, if it has one.
fn group_x(node: &Node) -> Option<f64> {
    match node {
        Node::Group {
            x,
            translatable: true,
            ..
        } => Some(*x),
        _ => None,
    }
}

fn shift_group_x(node: &mut Node, delta: f64) {
    if let Node::Group {
        x,
        translatable: true,
        ..
    } = node
    {
        *x += delta;
    }
}

/// A fraction laid out as `[numerator] [bar] [denominator]`: the bar is a
/// `line` element from `x1="0"` to the fraction's width.
fn is_fraction(children: &[Node]) -> bool {
    matches!(
        children,
        [Node::Group { translatable: true, .. }, Node::Raw(bar), Node::Group { translatable: true, .. }]
            if bar.starts_with("<line")
    )
}

fn line_x2(raw: &str) -> Option<f64> {
    let marker = "x2=\"";
    let start = raw.find(marker)? + marker.len();
    let end = raw[start..].find('"')? + start;
    raw[start..end].parse().ok()
}

fn rewrite_line_x2(raw: &str, x2: f64) -> String {
    let marker = "x2=\"";
    let Some(start) = raw.find(marker) else {
        return raw.to_string();
    };
    let value_start = start + marker.len();
    let Some(len) = raw[value_start..].find('"') else {
        return raw.to_string();
    };
    format!(
        "{}x2=\"{x2:.2}\"{}",
        &raw[..start],
        &raw[value_start + len + 1..]
    )
}

/// The content width of a box, in the layout's own units. `None` when the box
/// contains geometry whose extent cannot be read from the SVG (a radical, a
/// stretched delimiter): such a fraction is left untouched.
fn node_width(node: &Node) -> Option<f64> {
    match node {
        Node::Text { attrs, content } => Some(
            decode_entities(content).chars().count() as f64 * parse_font_size(attrs) * MONO_ADVANCE,
        ),
        Node::Group { children, .. } => {
            if let Some(bar) = children.iter().find_map(|child| match child {
                Node::Raw(raw) if raw.starts_with("<line") => Some(raw),
                _ => None,
            }) {
                return line_x2(bar);
            }
            let mut right: f64 = 0.0;
            for child in children {
                let x = group_x(child).unwrap_or(0.0);
                right = right.max(x + node_width(child)?);
            }
            Some(right)
        }
        Node::Raw(_) => None,
    }
}

/// The width of a row's children, from its left edge to the rightmost child.
fn row_width(children: &[Node]) -> Option<f64> {
    let mut right: f64 = 0.0;
    for child in children {
        right = right.max(group_x(child).unwrap_or(0.0) + node_width(child)?);
    }
    Some(right)
}

/// Respaces the numerator and denominator of a fraction, then re-centres both
/// rows and re-sizes the bar to the wider one plus the layout's 2 px padding a
/// side. Returns how much the fraction's width changed.
fn respace_fraction(children: &mut [Node]) -> f64 {
    // Widths must be readable before anything moves. A radical in a row would
    // make the re-centring guesswork.
    let old_bar = match children {
        [Node::Group { children: num, .. }, Node::Raw(bar), Node::Group { children: den, .. }] => {
            if row_width(num).is_none() || row_width(den).is_none() {
                return 0.0;
            }
            let Some(old_bar) = line_x2(bar) else {
                return 0.0;
            };
            old_bar
        }
        _ => return 0.0,
    };
    let d_num = match &mut children[0] {
        Node::Group { children, .. } => respace_group(children),
        _ => return 0.0,
    };
    let d_den = match &mut children[2] {
        Node::Group { children, .. } => respace_group(children),
        _ => return 0.0,
    };
    if d_num == 0.0 && d_den == 0.0 {
        return 0.0;
    }
    let (Some(w_num), Some(w_den)) = (
        match &children[0] {
            Node::Group { children, .. } => row_width(children),
            _ => None,
        },
        match &children[2] {
            Node::Group { children, .. } => row_width(children),
            _ => None,
        },
    ) else {
        return 0.0;
    };
    // The layout sizes the bar as the wider row plus 2 px on each side.
    let bar = w_num.max(w_den) + 4.0;
    if let Node::Group { x, .. } = &mut children[0] {
        *x = (bar - w_num) / 2.0;
    }
    if let Node::Group { x, .. } = &mut children[2] {
        *x = (bar - w_den) / 2.0;
    }
    if let Node::Raw(raw) = &mut children[1] {
        *raw = rewrite_line_x2(raw, bar);
    }
    bar - old_bar
}

/// Applies the spacing rules to one group's children and returns the change of
/// the group's width.
fn respace_group(children: &mut [Node]) -> f64 {
    let mut shift = 0.0_f64;
    for i in 0..children.len() {
        // The shift accumulated from earlier siblings applies to this child.
        let original_x = group_x(&children[i]);
        shift_group_x(&mut children[i], shift);
        let atom = atom_of(&children[i]);
        let width_delta = match atom {
            // A fraction is re-centred and its bar re-sized when its contents
            // got narrower. Other geometry-composed boxes stay as they are.
            Atom::Opaque => match &mut children[i] {
                Node::Group { children, .. } if is_fraction(children) => respace_fraction(children),
                _ => 0.0,
            },
            _ => match &mut children[i] {
                Node::Group { children, .. } => respace_group(children),
                _ => 0.0,
            },
        };
        shift += width_delta;
        match atom {
            // A product: replace the word space the layout inserted by the
            // thin space it reserves inside a box string.
            Atom::Space { chars, cell } => {
                let Some(next_x) = children.get(i + 1).and_then(group_x) else {
                    continue;
                };
                let Some(space_x) = original_x else { continue };
                let gap = next_x - space_x;
                let target = THIN_RATIO * cell * chars as f64;
                if gap > target {
                    shift += target - gap;
                }
            }
            // A relation the layout forgot to space: give it the margins its
            // own operator table uses, symmetrically. A relation the layout
            // already spaced (TraditionalForm writes the real glyph, which its
            // table knows) has a non-zero gap on its right and is left alone.
            Atom::Operator {
                margin,
                cell,
                chars,
            } => {
                let Some(next_x) = children.get(i + 1).and_then(group_x) else {
                    continue;
                };
                let Some(op_x) = original_x else { continue };
                let width = chars as f64 * cell;
                if next_x - (op_x + width) > 0.5 {
                    continue;
                }
                let margin = margin * cell;
                shift_group_x(&mut children[i], margin);
                shift += 2.0 * margin;
            }
            Atom::Opaque | Atom::Other => {}
        }
    }
    shift
}

/// Rewrites the horizontal spacing of a typeset SVG. Returns the input
/// unchanged when it does not have the expected `svg > g > ...` shape.
pub(crate) fn respace_svg(svg: &str) -> String {
    let Some(open) = svg.find("<svg") else {
        return svg.to_string();
    };
    let Some(open_end) = tag_end(svg, open) else {
        return svg.to_string();
    };
    let (mut nodes, _) = parse_children(&svg[open_end + 1..]);
    let delta = match nodes.as_mut_slice() {
        // A result that is a single fraction: its bar is the whole width.
        [Node::Group { children, .. }] if is_fraction(children) => respace_fraction(children),
        _ => respace_group(&mut nodes),
    };
    let mut body = String::new();
    for node in &nodes {
        node.render(&mut body);
    }
    let head = rewrite_width(&svg[..=open_end], delta);
    format!("{head}{body}</svg>")
}

fn rewrite_width(head: &str, delta: f64) -> String {
    let marker = "width=\"";
    let Some(pos) = head.find(marker) else {
        return head.to_string();
    };
    let value_start = pos + marker.len();
    let Some(value_len) = head[value_start..].find('"') else {
        return head.to_string();
    };
    let Ok(width) = head[value_start..value_start + value_len].parse::<f64>() else {
        return head.to_string();
    };
    let width = (width + delta).max(1.0).ceil() as i64;
    format!(
        "{}width=\"{width}\"{}",
        &head[..pos],
        &head[value_start + value_len + 1..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn svg_of(statement: &str) -> String {
        let result = woxi::interpret_with_stdout(statement).expect("evaluate");
        result.output_svg.expect("typeset output")
    }

    fn width_of(svg: &str) -> f64 {
        let pos = svg.find("width=\"").expect("width") + 7;
        let end = svg[pos..].find('"').expect("width end");
        svg[pos..pos + end].parse().expect("number")
    }

    /// Absolute x and decoded text of every text run, in document order.
    fn runs(svg: &str) -> Vec<(f64, String)> {
        let open = svg.find("<svg").expect("svg");
        let open_end = tag_end(svg, open).expect("svg tag");
        let (nodes, _) = parse_children(&svg[open_end + 1..]);
        fn walk(nodes: &[Node], x: f64, out: &mut Vec<(f64, String)>) {
            for node in nodes {
                match node {
                    Node::Group {
                        x: gx, children, ..
                    } => walk(children, x + gx, out),
                    Node::Text { content, .. } => out.push((x, decode_entities(content))),
                    Node::Raw(_) => {}
                }
            }
        }
        let mut out = Vec::new();
        walk(&nodes, 0.0, &mut out);
        out
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 0.15
    }

    #[test]
    fn rule_gets_the_margins_of_its_operator_table() {
        let svg = respace_svg(&svg_of("x -> 1"));
        let runs = runs(&svg);
        assert!(runs.len() >= 3);
        // 0.632 cell at 14 px is 8.85 px. The rule reserves 0.60 cell a side.
        assert!(close(runs[1].0, 8.8 + 5.3), "{runs:?}");
        assert!(close(runs[2].0, 17.7 + 10.6), "{runs:?}");
        assert_eq!(width_of(&svg), 38.0);
    }

    #[test]
    fn equality_gets_margins_too() {
        let svg = respace_svg(&svg_of("x == 1"));
        let runs = runs(&svg);
        assert!(close(runs[1].0, 8.8 + 3.9), "{runs:?}");
        assert!(close(runs[2].0, 26.5 + 7.8), "{runs:?}");
    }

    #[test]
    fn product_uses_the_thin_space_of_the_layout() {
        let svg = respace_svg(&svg_of("45 x^8 y^2"));
        let runs = runs(&svg);
        // 0.32 cell a side. The space runs themselves stay where they were.
        assert!(close(runs[2].0, 20.5), "{runs:?}");
        assert!(close(runs[5].0, 38.4), "{runs:?}");
        let width = width_of(&svg);
        assert!((54.0..=56.0).contains(&width), "width {width}");
    }

    #[test]
    fn binary_operator_keeps_its_margins() {
        let svg = respace_svg(&svg_of("x + 1"));
        let runs = runs(&svg);
        assert!(close(runs[1].0, 12.7), "{runs:?}");
        assert!(close(runs[2].0, 25.5), "{runs:?}");
        assert_eq!(width_of(&svg), 35.0);
    }

    #[test]
    fn simple_fraction_is_untouched() {
        let before = svg_of("1/2");
        assert_eq!(before, respace_svg(&before));
    }

    #[test]
    fn product_in_a_fraction_is_respaced_and_the_bar_follows() {
        let before = svg_of("(3 x)/2");
        let after = respace_svg(&before);
        let runs = runs(&after);
        // The space run then the `x`: the gap is the thin space, not a cell.
        let space = runs
            .iter()
            .position(|(_, text)| text.chars().all(|c| c == ' '))
            .expect("space run");
        let gap = runs[space + 1].0 - runs[space].0;
        assert!(close(gap, THIN_RATIO * 14.0 * MONO_ADVANCE), "{runs:?}");
        // The bar is re-sized to the narrower row plus 2 px a side, and the SVG
        // follows it.
        let bar: f64 = after
            .split("x2=\"")
            .nth(1)
            .and_then(|s| s.split('"').next())
            .and_then(|s| s.parse().ok())
            .expect("bar width");
        assert!(close(bar, 24.6), "bar {bar}");
        assert!(width_of(&after) < width_of(&before));
    }

    #[test]
    fn traditional_form_is_left_alone() {
        // Its box formatter already writes thin spaces and real operator
        // glyphs, so the layout has spaced it correctly.
        for statement in ["TraditionalForm[45 x^8 y^2]", "TraditionalForm[x -> 1]"] {
            let before = svg_of(statement);
            assert_eq!(before, respace_svg(&before), "{statement}");
        }
    }

    #[test]
    fn nested_terms_propagate_their_width() {
        let before = svg_of("Expand[(x + y)^3]");
        let after = respace_svg(&before);
        assert!(
            width_of(&after) < width_of(&before),
            "width {} -> {}",
            width_of(&before),
            width_of(&after)
        );
        // The plus signs keep the layout's 0.44 cell margin on both sides even
        // though the terms around them grew narrower.
        let runs = runs(&after);
        let cell = 14.0 * MONO_ADVANCE;
        for (i, (x, text)) in runs.iter().enumerate() {
            if text != "+" {
                continue;
            }
            let (next_x, _) = runs[i + 1];
            assert!(close(next_x - (x + cell), 0.44 * cell), "{runs:?}");
        }
    }

    #[test]
    fn lists_and_calls_are_left_alone() {
        for statement in ["{1, 2, 3}", "f[x, y]"] {
            let before = svg_of(statement);
            assert_eq!(before, respace_svg(&before), "{statement}");
        }
    }
}
