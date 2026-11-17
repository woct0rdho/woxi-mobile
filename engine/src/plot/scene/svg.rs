use super::types::Segment;
use super::AXIS_ALIGNED_SLACK;

/// A parsed SVG element: name, attributes and inner text. The pictures the scene supports are
/// flat lists of shapes. Anything nested (`<g>`, `<defs>`) is rejected before its children are
/// read.
pub(super) struct Element<'a> {
    pub(super) name: &'a str,
    pub(super) attrs: Vec<(&'a str, &'a str)>,
    pub(super) text: &'a str,
}

impl<'a> Element<'a> {
    pub(super) fn attr(&self, name: &str) -> Option<&'a str> {
        self.attrs
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| *value)
    }

    pub(super) fn number(&self, name: &str) -> Option<f64> {
        self.attr(name)?.trim().parse().ok()
    }

    pub(super) fn opacity(&self) -> f64 {
        self.attr("opacity")
            .and_then(|value| value.parse().ok())
            .unwrap_or(1.0)
    }

    pub(super) fn stroke_width(&self) -> f64 {
        self.attr("stroke-width")
            .and_then(|value| value.parse().ok())
            .unwrap_or(1.0)
    }

    /// Ink that draws nothing: a zero-width stroke, or no paint at all. The renderer emits these
    /// around a frame, and drawing nothing for them is right.
    pub(super) fn invisible(&self) -> bool {
        self.opacity() <= 0.0
            || (!self.attrs.iter().any(|(key, _)| *key == "stroke")
                && !self.attrs.iter().any(|(key, _)| *key == "fill"))
            || self.attr("stroke-width") == Some("0")
            || (self.attr("fill") == Some("none") && self.attr("stroke") == Some("none"))
    }
}

pub(super) fn elements(svg: &str) -> Option<Vec<Element<'_>>> {
    let mut out = Vec::new();
    let mut rest = svg;
    while let Some(start) = rest.find('<') {
        let after = &rest[start + 1..];
        let end = after.find('>')?;
        let tag = &after[..end];
        rest = &after[end + 1..];
        if tag.starts_with('/') || tag.starts_with('?') || tag.starts_with('!') {
            continue;
        }
        let self_closing = tag.ends_with('/');
        let body = tag.trim_end_matches('/');
        let mut parts = body.splitn(2, char::is_whitespace);
        let name = parts.next().unwrap_or("");
        let mut attrs = Vec::new();
        let mut tail = parts.next().unwrap_or("");
        while let Some(equal) = tail.find('=') {
            let key = tail[..equal].trim();
            let value = &tail[equal + 1..];
            let open = value.find('"')?;
            let close = value[open + 1..].find('"')?;
            attrs.push((key, &value[open + 1..open + 1 + close]));
            tail = &value[open + 1 + close + 1..];
        }
        // Only a text has inner content the scene reads. Every other element keeps its
        // children in the stream, which is what lets an unsupported child be rejected. A text's
        // content is taken whole: Woxi writes a multi-line label as `<tspan>` children of one
        // `<text>`, and those are part of the label, not elements of the picture.
        let text = if self_closing || name != "text" {
            ""
        } else {
            let close = rest.find("</text>")?;
            let inner = &rest[..close];
            rest = &rest[close + "</text>".len()..];
            inner
        };
        out.push(Element { name, attrs, text });
    }
    Some(out)
}

/// `#RGB`, `#RRGGBB` or `rgb(r,g,b)` as `#RRGGBB`.
pub(super) fn color_of(text: &str) -> Option<String> {
    let value = text.trim();
    if let Some(hex) = value.strip_prefix('#') {
        // `#RGB` is what the renderer writes for its gray labels. `#RRGGBB` is the rest.
        return match hex.len() {
            3 => {
                let mut out = String::from("#");
                for ch in hex.chars() {
                    out.push(ch);
                    out.push(ch);
                }
                Some(out.to_uppercase())
            }
            6 => Some(format!("#{}", hex.to_uppercase())),
            _ => None,
        };
    }
    let inner = value.strip_prefix("rgb(")?.strip_suffix(')')?;
    let parts: Vec<u8> = inner
        .split(',')
        .map(|part| part.trim().parse::<u8>().ok())
        .collect::<Option<Vec<u8>>>()?;
    (parts.len() == 3).then(|| format!("#{:02X}{:02X}{:02X}", parts[0], parts[1], parts[2]))
}

/// A dash pattern in the picture's user units. Woxi resolves `Dashing` before writing the
/// attribute (`dash_len` in its SVG writer: negative values are points, positive ones a fraction
/// of the reference, both turned into render-space lengths), so the `stroke-dasharray` numbers
/// here are already user units and must not be converted again.
pub(super) fn dash_of(element: &Element) -> Option<Vec<f64>> {
    let dashes: Vec<f64> = element
        .attr("stroke-dasharray")?
        .split(|ch: char| ch == ',' || ch.is_whitespace())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.trim().parse::<f64>().ok())
        .collect();
    (!dashes.is_empty()).then_some(dashes)
}

/// A length in the text's own units: a bare number is user units, `em` is the font size and
/// `ex` half of it. The renderer writes `dy` both ways around a plot.
pub(super) fn length_em(value: &str, size: f64) -> Option<f64> {
    let (factor, rest) = if let Some(rest) = value.strip_suffix("em") {
        (size, rest)
    } else if let Some(rest) = value.strip_suffix("ex") {
        (size * 0.5, rest)
    } else {
        (1.0, value)
    };
    rest.trim()
        .parse::<f64>()
        .ok()
        .map(|number| number * factor)
}

/// The lines of a text the renderer wrote: one for a plain `<text>`, or the parent text and
/// each `<tspan>` for a multi-line label. Woxi writes one tspan per line with a `dy` relative
/// to the previous baseline (a bare number of user units, not an em). A tspan's `x` is absolute
/// and falls back to the parent's.
pub(super) fn text_lines(inner: &str, x: f64, parent_y: f64, size: f64) -> Vec<(String, f64, f64)> {
    let mut lines = Vec::new();
    let mut baseline = parent_y;
    let mut line_x = x;
    let mut cursor = 0usize;
    while let Some(found) = inner[cursor..].find("<tspan") {
        let start = cursor + found;
        let before = inner[cursor..start].trim();
        if !before.is_empty() {
            lines.push((before.to_string(), line_x, baseline));
        }
        let after = &inner[start + "<tspan".len()..];
        let Some(open_end) = after.find('>') else {
            break;
        };
        let tag = &after[..open_end];
        let Some(close) = after.find("</tspan>") else {
            break;
        };
        let text = after[open_end + 1..close].trim();
        line_x = attribute_value(tag, "x")
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(line_x);
        if let Some(dy) = attribute_value(tag, "dy").and_then(|value| length_em(value, size)) {
            baseline += dy;
        }
        if !text.is_empty() {
            lines.push((text.to_string(), line_x, baseline));
        }
        cursor = start + "<tspan".len() + close + "</tspan>".len();
    }
    let tail = inner[cursor..].trim();
    if !tail.is_empty() {
        lines.push((tail.to_string(), line_x, baseline));
    }
    if lines.is_empty() {
        let whole = inner.trim();
        if !whole.is_empty() {
            lines.push((whole.to_string(), x, parent_y));
        }
    }
    lines
}

pub(super) fn attribute_value<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("{name}=\"");
    let start = tag.find(&needle)? + needle.len();
    let rest = &tag[start..];
    Some(&rest[..rest.find('"')?])
}

pub(super) fn is_series(element: &Element, colors: &[String]) -> bool {
    ["stroke", "fill"].iter().any(|name| {
        element
            .attr(name)
            .and_then(color_of)
            .is_some_and(|color| colors.contains(&color))
    })
}

/// The rotation a text asks for: `rotate(angle, cx, cy)` in the picture's y-down space, which is
/// how `FrameLabel` turns its y label. A transform the scene cannot express (a matrix, a
/// translate) rejects the picture rather than drawing the text in the wrong place.
pub(super) fn rotation_of(element: &Element) -> Option<(f64, f64, f64)> {
    let Some(transform) = element.attr("transform") else {
        return Some((0.0, 0.0, 0.0));
    };
    let inner = transform
        .trim()
        .strip_prefix("rotate(")?
        .strip_suffix(')')?;
    let numbers: Vec<f64> = inner
        .split(|ch: char| ch == ',' || ch.is_whitespace())
        .filter(|part| !part.is_empty())
        .map(|part| part.parse::<f64>().ok())
        .collect::<Option<Vec<f64>>>()?;
    match numbers.as_slice() {
        [angle] => Some((*angle, 0.0, 0.0)),
        [angle, cx, cy] => Some((*angle, *cx, *cy)),
        _ => None,
    }
}

/// One `x,y` token of a polyline.
pub(super) fn pair_of(token: &str) -> Option<(f64, f64)> {
    let (x, y) = token.split_once(',')?;
    Some((x.trim().parse().ok()?, y.trim().parse().ok()?))
}

/// A closed axis-aligned outline, as a framed plot draws its frame: one polyline through the four
/// corners and back to the first. Anything else with more than two points is not a shape the
/// scene models.
pub(super) fn closed_rect(pairs: &[(&str, &str)]) -> Option<[f64; 4]> {
    if pairs.len() < 5 {
        return None;
    }
    let points: Vec<(f64, f64)> = pairs
        .iter()
        .map(|(x, y)| Some((x.trim().parse::<f64>().ok()?, y.trim().parse::<f64>().ok()?)))
        .collect::<Option<Vec<_>>>()?;
    let first = points.first()?;
    let last = points.last()?;
    if (first.0 - last.0).abs() > AXIS_ALIGNED_SLACK
        || (first.1 - last.1).abs() > AXIS_ALIGNED_SLACK
    {
        return None;
    }
    let left = points.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
    let right = points.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
    let top = points.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
    let bottom = points.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
    if !(right > left && bottom > top) {
        return None;
    }
    // Every point on the outline, and all four corners among them: a decorative zigzag that
    // happens to span a rectangle is not the frame.
    let on_edge = |p: &(f64, f64)| {
        (p.0 - left).abs() <= AXIS_ALIGNED_SLACK
            || (p.0 - right).abs() <= AXIS_ALIGNED_SLACK
            || (p.1 - top).abs() <= AXIS_ALIGNED_SLACK
            || (p.1 - bottom).abs() <= AXIS_ALIGNED_SLACK
    };
    if !points.iter().all(on_edge) {
        return None;
    }
    let corner = |cx: f64, cy: f64| {
        points.iter().any(|p| {
            (p.0 - cx).abs() <= AXIS_ALIGNED_SLACK && (p.1 - cy).abs() <= AXIS_ALIGNED_SLACK
        })
    };
    (corner(left, top) && corner(right, top) && corner(left, bottom) && corner(right, bottom))
        .then_some([left, top, right - left, bottom - top])
}

/// The frame of an unframed picture: the extents of its longest horizontal and vertical segments.
pub(super) fn frame_of_segments(segments: &[Segment]) -> Option<[f64; 4]> {
    let mut horizontal: Option<(f64, f64, f64)> = None;
    let mut vertical: Option<(f64, f64, f64)> = None;
    for segment in segments {
        if segment.horizontal() {
            let length = (segment.x2 - segment.x1).abs();
            let low = segment.x1.min(segment.x2);
            let high = segment.x1.max(segment.x2);
            if horizontal.is_none_or(|(best, _, _)| length > best) {
                horizontal = Some((length, low, high));
            }
        } else if segment.vertical() {
            let length = (segment.y2 - segment.y1).abs();
            let low = segment.y1.min(segment.y2);
            let high = segment.y1.max(segment.y2);
            if vertical.is_none_or(|(best, _, _)| length > best) {
                vertical = Some((length, low, high));
            }
        }
    }
    let (_, left, right) = horizontal?;
    let (_, top, bottom) = vertical?;
    (right > left && bottom > top).then_some([left, top, right - left, bottom - top])
}

pub(super) fn segment(element: &Element, at: [f64; 4]) -> Option<Segment> {
    // A two-point segment the scene models runs along an axis: a value line, a tick or a frame
    // edge. A diagonal one would be silently drawn as a vertical or horizontal line by `json`,
    // so the picture is refused instead.
    if (at[1] - at[3]).abs() > AXIS_ALIGNED_SLACK && (at[0] - at[2]).abs() > AXIS_ALIGNED_SLACK {
        return None;
    }
    Some(Segment {
        x1: at[0],
        y1: at[1],
        x2: at[2],
        y2: at[3],
        width: element.stroke_width(),
        color: element.attr("stroke").and_then(color_of)?,
        dashes: dash_of(element),
        kind: 'g',
        value: None,
    })
}
