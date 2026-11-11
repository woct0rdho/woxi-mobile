//! Plot engine tests: the statement a gesture captures, the requests it sends, the
//! pictures and samples they answer with, and the protocol around them.

use woxi::syntax::Expr;

mod capture;
mod frames;
mod gesture;
mod registration;
mod samples;
mod views;

fn reset() {
    woxi::clear_state();
    super::clear_plot_views();
}

fn parse(src: &str) -> Expr {
    woxi::syntax::string_to_expr(src).expect("parses")
}

fn handle_of(items: &str) -> u64 {
    let at = items.find("\"id\":").expect("plot payload") + 5;
    let rest = &items[at..];
    let end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    rest[..end].parse().expect("handle")
}

fn view_request(kind: &str, handle: u64, x: (f64, f64), y: (f64, f64)) -> String {
    format!(
            "{{\"msg_type\":\"{kind}\",\"content\":{{\"handle\":{handle},\"x\":[{},{}],\"y\":[{},{}]}}}}",
            x.0, x.1, y.0, y.1
        )
}

/// The picture's data rectangle (the fill-less frame), read back from a reply. A
/// gesture maps data onto this rectangle, so its shape is what a view has to keep:
/// a contour is square, a `Plot` is 1.6 wide, whatever the requested range was.
fn frame_size(reply: &str) -> (f64, f64) {
    let attribute = |element: &str, name: &str| -> Option<f64> {
        let needle = format!("{name}=\\\"");
        let at = element.find(&needle)? + needle.len();
        element[at..].split('\\').next()?.parse().ok()
    };
    let mut at = 0usize;
    while let Some(found) = reply[at..].find("<rect") {
        let start = at + found;
        let rest = &reply[start..];
        let end = rest.find("/>").map(|value| value + 2).unwrap_or(rest.len());
        let element = &rest[..end];
        at = start + 1;
        if !element.contains("fill=\\\"none\\\"") {
            continue;
        }
        if let (Some(width), Some(height)) =
            (attribute(element, "width"), attribute(element, "height"))
        {
            return (width, height);
        }
    }
    (0.0, 0.0)
}

/// The grid the canvas maps the points onto, read out of an item's layer payload.
fn layer_grid(items: &str) -> [f64; 4] {
    let at = items.find("\"data\":{\"x\":[").expect("layer payload") + 13;
    let rest = &items[at..];
    let numbers: Vec<f64> = rest[..rest.find(']').unwrap()]
        .split(',')
        .filter_map(|value| value.parse().ok())
        .collect();
    let after = rest[rest.find(']').unwrap() + 1..].to_string();
    let at = after.find("\"y\":[").expect("y grid") + 5;
    let tail = &after[at..];
    let mut numbers: Vec<f64> = numbers;
    numbers.extend(
        tail[..tail.find(']').unwrap()]
            .split(',')
            .filter_map(|value| value.parse::<f64>().ok()),
    );
    assert_eq!(numbers.len(), 4, "grid");
    [numbers[0], numbers[1], numbers[2], numbers[3]]
}

/// The `x` or `y` range of a reply's plot payload.
fn payload_range(items: &str, field: &str) -> (f64, f64) {
    let needle = format!("\"{field}\":[");
    let at = items.find(&needle).expect("range field") + needle.len();
    let rest = &items[at..];
    let numbers: Vec<f64> = rest[..rest.find(']').expect("end")]
        .split(',')
        .filter_map(|value| value.parse().ok())
        .collect();
    assert_eq!(numbers.len(), 2, "{items}");
    (numbers[0], numbers[1])
}

/// The scene's `rect` field: where the range sits in the picture's own user units.
fn picture_rect(items: &str) -> [f64; 4] {
    let at = items.find("\"rect\":[").expect("scene rect field") + 8;
    let rest = &items[at..];
    let numbers: Vec<f64> = rest[..rest.find(']').expect("end")]
        .split(',')
        .filter_map(|value| value.parse().ok())
        .collect();
    assert_eq!(numbers.len(), 4, "{items}");
    [numbers[0], numbers[1], numbers[2], numbers[3]]
}

/// The scene's `frame` field, in user units.
fn scene_frame(items: &str) -> [f64; 4] {
    let at = items.find("\"frame\":[").expect("scene frame field") + 9;
    let rest = &items[at..];
    let numbers: Vec<f64> = rest[..rest.find(']').expect("end")]
        .split(',')
        .filter_map(|value| value.parse().ok())
        .collect();
    assert_eq!(numbers.len(), 4, "{items}");
    // The scene writes the frame as x, y, width, height. The rect's y pair is bottom-first,
    // in the order of the range (the lowest data value maps to the larger user y).
    [
        numbers[0],
        numbers[1] + numbers[3],
        numbers[0] + numbers[2],
        numbers[1],
    ]
}

/// The SVG of an item, unescaped from the JSON string it travels in.
fn svg_of(reply: &str) -> String {
    let at = reply.find("\"svg\":\"").expect("svg field") + 7;
    let rest = &reply[at..];
    let end = rest.find("\",\"").expect("end of svg");
    rest[..end].replace("\\\"", "\"")
}

/// The picture's frame in user units, measured the way the client measures it: the
/// extents of the longest horizontal and vertical segments (the axes) or the biggest
/// fill-less rectangle, whichever covers more.
fn frame_extent(reply: &str) -> [f64; 4] {
    let svg = svg_of(reply);
    let text = |element: &str, name: &str| -> Option<String> {
        element
            .split(&format!("{name}=\""))
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .map(|value| value.trim().to_string())
    };
    let attribute = |element: &str, name: &str| -> Option<f64> {
        text(element, name).and_then(|value| value.parse().ok())
    };
    let mut horizontal: Option<[f64; 3]> = None;
    let mut vertical: Option<[f64; 3]> = None;
    for part in svg.split("<line").skip(1) {
        let Some(tag) = part.split('>').next() else {
            continue;
        };
        let (Some(x1), Some(y1), Some(x2), Some(y2)) = (
            attribute(tag, "x1"),
            attribute(tag, "y1"),
            attribute(tag, "x2"),
            attribute(tag, "y2"),
        ) else {
            continue;
        };
        let dx = (x2 - x1).abs();
        let dy = (y2 - y1).abs();
        if dy <= 0.5 && horizontal.is_none_or(|h| dx > h[0]) {
            horizontal = Some([dx, x1.min(x2), x1.max(x2)]);
        }
        if dx <= 0.5 && vertical.is_none_or(|v| dy > v[0]) {
            vertical = Some([dy, y1.min(y2), y1.max(y2)]);
        }
    }
    let axes = match (horizontal, vertical) {
        (Some(h), Some(v)) => Some([h[1], v[1], h[2], v[2]]),
        _ => None,
    };
    let mut rect: Option<[f64; 4]> = None;
    for part in svg.split("<rect").skip(1) {
        let Some(tag) = part.split('>').next() else {
            continue;
        };
        // Only a fill-less rectangle is a frame. The background has a fill.
        if text(tag, "fill").is_some_and(|fill| fill != "none") {
            continue;
        }
        let (Some(x), Some(y), Some(width), Some(height)) = (
            attribute(tag, "x"),
            attribute(tag, "y"),
            attribute(tag, "width"),
            attribute(tag, "height"),
        ) else {
            continue;
        };
        let area = width * height;
        if rect.is_none_or(|r| area > (r[2] - r[0]) * (r[3] - r[1])) {
            rect = Some([x, y, x + width, y + height]);
        }
    }
    match (axes, rect) {
        (Some(axes), Some(rect)) => {
            let axes_area = (axes[2] - axes[0]) * (axes[3] - axes[1]);
            let rect_area = (rect[2] - rect[0]) * (rect[3] - rect[1]);
            if rect_area > axes_area {
                rect
            } else {
                axes
            }
        }
        (axes, rect) => axes.or(rect).expect("a frame"),
    }
}

fn frame_ratio(reply: &str) -> f64 {
    let frame = frame_extent(reply);
    (frame[3] - frame[1]) / (frame[2] - frame[0])
}

/// The extent of the drawn polylines, in the picture's own user units. The SVG travels
/// as a JSON string, so its quotes are escaped.
fn drawn_extent(reply: &str) -> [f64; 4] {
    let mut bounds = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    let mut rest = reply;
    while let Some(at) = rest.find("<polyline") {
        rest = &rest[at..];
        let Some(start) = rest.find("points=\\\"") else {
            break;
        };
        let body = &rest[start + "points=\\\"".len()..];
        let Some(end) = body.find("\\\"") else {
            break;
        };
        for pair in body[..end].split_whitespace() {
            let mut parts = pair.split(',');
            let (Some(x), Some(y)) = (parts.next(), parts.next()) else {
                continue;
            };
            if let (Ok(x), Ok(y)) = (x.parse::<f64>(), y.parse::<f64>()) {
                bounds[0] = bounds[0].min(x);
                bounds[1] = bounds[1].min(y);
                bounds[2] = bounds[2].max(x);
                bounds[3] = bounds[3].max(y);
            }
        }
        rest = &body[end..];
    }
    bounds
}

/// The values of one axis's ticks in a scene, read from the reply without a JSON parser.
fn scene_tick_values(reply: &str, axis: &str) -> Vec<f64> {
    let at = reply.find("\"ticks\":[").expect("ticks") + 9;
    let rest = &reply[at..];
    let end = rest.find("],\"texts\":").expect("ticks end");
    rest[..end]
        .split("},{")
        .filter(|tick| tick.contains(&format!("\"o\":\"{axis}\"")))
        .filter_map(|tick| {
            let v = tick.split("\"v\":").nth(1)?;
            v.split(',').next()?.trim().parse().ok()
        })
        .collect()
}
