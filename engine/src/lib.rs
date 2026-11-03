//! Android JNI wrapper around the Woxi Wolfram Language interpreter.
//!
//! The wrapper exposes the notebook interface the frontend needs, because the helpers
//! that turn interpreter output into these JSON items are internal to Woxi:
//! - `evaluateAll(input)`  -> JSON array of output items
//! - `evaluateManipulate(body, bindingsJson)` -> JSON `{svg|text}`
//! - `plotRequest(json)` -> JSON reply, see below
//! - `queryRequest(json)` -> JSON reply for typing help, see below
//! - `clear()`, `setDarkMode(enabled)`
//!
//! Item JSON shape, so the notebook frontend can render every kind of output with
//! one code path. It corresponds to Jupyter's output messages: `print` and `warning`
//! are `stream`, `text` is `execute_result`, `graphics` and `manipulate` are
//! `display_data`, `error` is `error`.
//!
//! ```json
//! [{"type":"text","text":"x^3/3","svg":"<svg ...>"},
//!  {"type":"graphics","svg":"<svg ...>","plot":{"id":3,"x":[-6.28,6.28],"y":[-1,1]}},
//!  {"type":"print","text":"..."},
//!  {"type":"warning","text":"..."},
//!  {"type":"error","text":"..."},
//!  {"type":"manipulate","body":"...","controls":[...],"initial":{"svg":"..."}}]
//! ```
//!
//! A 2D plot carries a `plot` field: a handle for the rendered graphic, like a
//! Jupyter `display_id`, plus the data range it currently shows. `s` says the plot
//! can be re-sampled (`plot_refine`, rewriting its iterators), `dn` says it samples a
//! fixed parameter domain and can only be redrawn with more points (`plot_densify`).
//! Re-evaluating the entry produces a fresh handle, i.e. the original view.
//!
//! Plot interactions use one request/reply pair per message, in the shape of a
//! Jupyter message (a `msg_type`, a `content` object, and a reply that reports
//! `status` with `ename`/`evalue` on failure):
//!
//! ```json
//! {"msg_type":"plot_view","content":{"handle":3,"x":[-1,1],"y":[-1,1]}}
//! {"msg_type":"plot_view_reply","status":"ok","content":{"type":"graphics",...}}
//! {"msg_type":"plot_view_reply","status":"error","ename":"ExpiredHandle","evalue":"..."}
//! ```
//!
//! `plot_retain`/`plot_release` keep the handle registry tied to live frontend
//! controllers, so a deleted cell frees its plot data.
//!
//! Typing help uses the same envelope, with the names from the Jupyter messaging
//! spec (`complete_request`, `inspect_request`, `is_complete_request`) so the frontend
//! could later talk to a real kernel unchanged:
//!
//! ```json
//! {"msg_type":"complete_request","content":{"code":"Plo","cursor_pos":3,"limit":24}}
//! {"msg_type":"complete_reply","status":"ok","content":{
//!   "matches":["Plot","Plot3D"],"cursor_start":0,"cursor_end":3,
//!   "metadata":{"_jupyter_types_experimental":[{"text":"Plot",...}],
//!               "_woxi":[{"implemented":1,"category":"plotting","doc":"..."}]}}}
//! ```
//!
//! `catalog_request` is a Woxi extension (Jupyter has no message for the whole
//! namespace). It only reports the number of symbols and the version they came from. None of these messages execute the
//! entry they are asked about, and none of them touch `%` history.
//!
//! All evaluation happens in the calling thread. The Kotlin side keeps a single-threaded executor so interpreter
//! state stays consistent, with views served before background re-sampling.

use jni::errors::LogErrorAndDefault;
use jni::objects::{JClass, JString};
use jni::sys::{jboolean, jstring};
use jni::{Env, EnvUnowned};

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::sync::LazyLock;

use woxi::syntax::Expr;

// helpers

/// Minimal JSON string escaping (the interpreter output is the payload).
fn json_escape(text: &str) -> String {
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

fn item(kind: &str, text: &str, svg: Option<&str>) -> String {
    match svg {
        Some(svg) => format!(
            "{{\"type\":\"{}\",\"text\":\"{}\",\"svg\":\"{}\"}}",
            kind,
            json_escape(text),
            json_escape(svg)
        ),
        None => format!(
            "{{\"type\":\"{}\",\"text\":\"{}\"}}",
            kind,
            json_escape(text)
        ),
    }
}

fn graphics_item(svg: &str) -> String {
    format!("{{\"type\":\"graphics\",\"svg\":\"{}\"}}", json_escape(svg))
}

/// Like [`graphics_item`], with the interactive-view handle of a 2D plot.
fn graphics_item_with_plot(svg: &str, plot: Option<&str>) -> String {
    match plot {
        Some(plot) => format!(
            "{{\"type\":\"graphics\",\"svg\":\"{}\",\"plot\":{}}}",
            json_escape(svg),
            plot
        ),
        None => graphics_item(svg),
    }
}

/// Result text with the graphics placeholders removed (`-Graphics-` etc.).
fn residual_text(result: &str) -> String {
    result
        .replace("-Graphics-", "")
        .replace("-Graphics3D-", "")
        .replace("-Image-", "")
        .replace("-Sound-", "")
        .trim()
        .to_string()
}

// manipulate

/// One control of a `Manipulate[...]`, parsed from the source text.
struct Control {
    name: String,
    kind: &'static str, // "continuous" | "discrete" | "checkbox"
    min: Option<f64>,
    max: Option<f64>,
    step: Option<f64>,
    values: Vec<String>,
    initial: String,
}

/// Splits `s` on top-level commas (ignoring commas inside (), [], {}).
fn split_top_level(s: &str) -> Vec<String> {
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

fn strip_braces(s: &str) -> &str {
    let t = s.trim();
    if t.starts_with('{') && t.ends_with('}') && t.len() >= 2 {
        &t[1..t.len() - 1]
    } else {
        t
    }
}

/// Parses `Manipulate[body, {name, ...}, ...]` into (body, controls).
fn parse_manipulate(stmt: &str) -> Option<(String, Vec<Control>)> {
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

fn manipulate_json(body: &str, controls: &[Control], initial_svg: Option<&str>) -> String {
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
fn manipulate_initial_svg(body: &str, controls: &[Control]) -> Option<String> {
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
fn render_body(body: &str, bindings: &[(String, String)]) -> Option<String> {
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

fn is_plain_symbol(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_alphanumeric() || ch == '_' || ch == '@')
}

// interactive plot views
//
// A rendered 2D plot is kept under a handle, the way a Jupyter kernel keeps the
// outputs it may be asked to re-render. The stored graphic has its SVG dropped:
// the renderer rebuilds the picture from the plot data the expression carries, so
// showing the same plot at another `PlotRange` costs a re-render (a few
// milliseconds) instead of re-evaluating the user's expression.

struct PlotView {
    /// The graphic the gestures re-render at other ranges, SVG removed.
    graphic: Expr,
    /// The x range the picture's data covers (the range the function was sampled
    /// over, or the extent of the primitives).
    data: (f64, f64),
    /// The y range the data covers, for plots that sample two axes (contour and
    /// field plots). `None` when the plot only samples x, where a y coverage check
    /// would be meaningless.
    data_y: Option<(f64, f64)>,
    /// The statement that produced the graphic, unevaluated, so it can be re-run to
    /// sample a different range. `None` when the plot has no iterator to rewrite.
    call: Option<PlotCall>,
    /// How many live frontend controllers hold this handle. A view is dropped when
    /// the last one goes away, so a deleted cell does not keep its data forever.
    refs: u32,
    /// Monotonic use counter, so eviction at the cap drops the least recently
    /// touched plot rather than the oldest registered one.
    touched: u64,
}

/// Where a plot samples its data, inside the parsed statement.
#[derive(Clone)]
struct PlotCall {
    expr: Expr,
    sites: Vec<Site>,
    /// The call samples a fixed parameter domain (`ParametricPlot`, `PolarPlot`),
    /// so its bounds must never be rewritten. It can still be redrawn with more
    /// points when the view is zoomed in.
    densify: bool,
}

/// One iterator argument of a sampling call, and which axis it drives.
#[derive(Clone, PartialEq)]
struct Site {
    /// Argument indices from the root of [`PlotCall::expr`].
    path: Vec<usize>,
    /// 0 = x, 1 = y.
    axis: u8,
}

/// Heads whose iterators describe the graphic's own axes, and which iterator
/// arguments they are. This is deliberately a table rather than an inference from
/// numbers: a parameter's range can look exactly like an axis range
/// (`ParametricPlot[{Cos[t], Sin[t]}, {t, 0, Pi/2}]`), and a contour's x and y
/// ranges are often identical, which no amount of comparing arithmetic can
/// resolve. Anything not listed here is never re-sampled - those plots still pan
/// and zoom from cached data, they just do not ask for new samples.
///
/// `x` and `y` are argument indices of the iterator (`{var, min, max}`), with
/// options following them.
struct PlotKind {
    head: &'static str,
    x: usize,
    y: Option<usize>,
}

const PLOT_KINDS: &[PlotKind] = &[
    PlotKind {
        head: "Plot",
        x: 1,
        y: None,
    },
    PlotKind {
        head: "LogPlot",
        x: 1,
        y: None,
    },
    PlotKind {
        head: "LogLinearPlot",
        x: 1,
        y: None,
    },
    PlotKind {
        head: "LogLogPlot",
        x: 1,
        y: None,
    },
    PlotKind {
        head: "ReImPlot",
        x: 1,
        y: None,
    },
    PlotKind {
        head: "ContourPlot",
        x: 1,
        y: Some(2),
    },
    PlotKind {
        head: "DensityPlot",
        x: 1,
        y: Some(2),
    },
    PlotKind {
        head: "RegionPlot",
        x: 1,
        y: Some(2),
    },
    PlotKind {
        head: "VectorPlot",
        x: 1,
        y: Some(2),
    },
    PlotKind {
        head: "StreamPlot",
        x: 1,
        y: Some(2),
    },
    PlotKind {
        head: "StreamDensityPlot",
        x: 1,
        y: Some(2),
    },
];

/// Extra room sampled around the visible range, so a small pan stays inside the
/// data instead of asking for another re-sample.
const REFINE_PAD: f64 = 0.25;

fn padded(range: (f64, f64)) -> (f64, f64) {
    let pad = (range.1 - range.0).abs() * REFINE_PAD;
    (range.0 - pad, range.1 + pad)
}

thread_local! {
    static PLOT_VIEWS: RefCell<HashMap<u64, PlotView>> = RefCell::new(HashMap::new());
    static NEXT_PLOT_VIEW: Cell<u64> = const { Cell::new(1) };
    static NEXT_TOUCH: Cell<u64> = const { Cell::new(1) };
}

/// How many rendered plots stay addressable. Older handles are dropped, and the
/// frontend stops treating a plot as interactive when its handle turns out to be
/// gone, so an evicted plot degrades to a still picture instead of retrying.
const MAX_PLOT_VIEWS: usize = 64;

/// The plot data behind a rendered graphic, when there is any.
fn plot_source(expr: &Expr) -> Option<&woxi::syntax::PlotSource> {
    match expr {
        Expr::Graphics {
            is_3d: false,
            source: Some(source),
            ..
        } => Some(source),
        _ => None,
    }
}

/// The data range a rendered 2D graphic currently shows, or `None` when it is not
/// the kind of picture that can be panned. Plots that carry a plot source state
/// their range. The others (`ContourPlot`, `DensityPlot`, user `Graphics[...]`)
/// keep their primitives in data coordinates, so the range follows from them.
fn plot_ranges(expr: &Expr) -> Option<((f64, f64), (f64, f64))> {
    if let Some(source) = plot_source(expr) {
        return Some((source.x_range, source.y_range));
    }
    match expr {
        Expr::Graphics {
            is_3d: false,
            structure: Some(structure),
            ..
        } => primitive_bounds(structure),
        _ => None,
    }
}

fn number_of(expr: &Expr) -> Option<f64> {
    match expr {
        Expr::Real(value) => Some(*value),
        Expr::Integer(value) => Some(*value as f64),
        Expr::UnaryOp {
            op: woxi::syntax::UnaryOperator::Minus,
            operand,
        } => Some(-number_of(operand)?),
        _ => None,
    }
}

fn point_of(expr: &Expr) -> Option<(f64, f64)> {
    match expr {
        Expr::List(items) if items.len() == 2 => {
            Some((number_of(&items[0])?, number_of(&items[1])?))
        }
        _ => None,
    }
}

fn add_point(x: f64, y: f64, min: &mut [f64; 2], max: &mut [f64; 2], count: &mut usize) {
    if !x.is_finite() || !y.is_finite() {
        return;
    }
    min[0] = min[0].min(x);
    min[1] = min[1].min(y);
    max[0] = max[0].max(x);
    max[1] = max[1].max(y);
    *count += 1;
}

/// Collects the coordinates of the drawing primitives a graphic holds.
fn collect_bounds(expr: &Expr, min: &mut [f64; 2], max: &mut [f64; 2], count: &mut usize) {
    // Primitives are named, but only the ones that mean coordinates are followed,
    // so option values (`Thickness[0.01]`) cannot be mistaken for data.
    const COORDINATE_HEADS: [&str; 10] = [
        "Line",
        "Point",
        "Polygon",
        "Arrow",
        "Rectangle",
        "Style",
        "Directive",
        "Tooltip",
        "Annotation",
        "Graphics",
    ];
    match expr {
        Expr::List(items) => {
            if let Some((x, y)) = point_of(expr) {
                add_point(x, y, min, max, count);
                return;
            }
            for item in items {
                collect_bounds(item, min, max, count);
            }
        }
        Expr::FunctionCall { name, args } => match name.as_str() {
            // The first argument of a graphics complex is its point list.
            "GraphicsComplex" => {
                if let Some(points) = args.first() {
                    collect_bounds(points, min, max, count);
                }
            }
            "Circle" | "Disk" => {
                if let (Some(center), Some(radius)) = (
                    args.first().and_then(point_of),
                    args.get(1).and_then(number_of),
                ) {
                    add_point(center.0 - radius, center.1 - radius, min, max, count);
                    add_point(center.0 + radius, center.1 + radius, min, max, count);
                }
            }
            other if COORDINATE_HEADS.contains(&other) => {
                for arg in args {
                    collect_bounds(arg, min, max, count);
                }
            }
            _ => {}
        },
        _ => {}
    }
}

fn primitive_bounds(structure: &Expr) -> Option<((f64, f64), (f64, f64))> {
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    let mut count = 0usize;
    collect_bounds(structure, &mut min, &mut max, &mut count);
    if count == 0 || max[0] <= min[0] || max[1] <= min[1] {
        return None;
    }
    Some(((min[0], max[0]), (min[1], max[1])))
}

fn json_number(value: f64) -> String {
    if value.is_finite() {
        format!("{value}")
    } else {
        "null".to_string()
    }
}

fn plot_payload(
    id: u64,
    x: (f64, f64),
    y: (f64, f64),
    data: (f64, f64),
    data_y: Option<(f64, f64)>,
    sample: bool,
    densify: bool,
) -> String {
    let data_y = match data_y {
        Some(range) => format!("[{},{}]", json_number(range.0), json_number(range.1)),
        None => "null".to_string(),
    };
    format!(
        "{{\"id\":{},\"x\":[{},{}],\"y\":[{},{}],\"d\":[{},{}],\"dy\":{},\"s\":{},\"dn\":{}}}",
        id,
        json_number(x.0),
        json_number(x.1),
        json_number(y.0),
        json_number(y.1),
        json_number(data.0),
        json_number(data.1),
        data_y,
        sample,
        densify
    )
}

// re-running the plot call to sample the visible range

/// Does an iterator argument look like `{var, ...}`? The bounds are not touched:
/// evaluating a bound such as `{x, 0, ++n}` would run user code, so the shape is all
/// that is checked here.
fn looks_like_iterator(expr: &Expr) -> bool {
    match expr {
        Expr::List(items) => {
            items.len() >= 3 && items.len() <= 4 && matches!(items[0], Expr::Identifier(_))
        }
        _ => false,
    }
}

/// Heads that sample a fixed parameter domain. Their bounds are never rewritten -
/// that would change the curve - but they can be redrawn with more points.
const DENSIFY_HEADS: &[&str] = &["ParametricPlot", "PolarPlot"];

/// Sampling density for a densified re-render. Parametric and polar plots clamp
/// `PlotPoints` at 2000, and the default is 500.
fn densify_points(level: u32) -> usize {
    match level {
        0 | 1 => 750,
        2 => 1500,
        _ => 2000,
    }
}

/// Splits a cell on top-level semicolons, respecting brackets and quoted strings.
/// Woxi's statement splitter keeps `a = 2; Plot[...]` together, and
/// `string_to_expr` parses only the first expression of a string, so a cell that
/// holds several statements has to be split here before the last one is parsed.
fn split_semicolons(text: &str) -> Vec<&str> {
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

/// Can this expression be evaluated again without running anything except the
/// plot? A `Show` only re-renders its arguments, a `Set` only stores the value it is
/// given, and a list of those is the same. Everything else - `Module`, `Table`, a
/// `CompoundExpression`, an arbitrary wrapper - may have side effects, so a plot
/// inside it keeps its cached data and is never re-sampled: doing nothing is better
/// than silently re-running user code on every gesture.
fn resample_safe(expr: &Expr) -> bool {
    match expr {
        Expr::FunctionCall { name, args } => {
            if PLOT_KINDS.iter().any(|kind| kind.head == name.as_str())
                || DENSIFY_HEADS.contains(&name.as_str())
            {
                return true;
            }
            match name.as_str() {
                "Show" => args.iter().any(resample_safe),
                "Set" | "SetDelayed" => args.get(1).is_some_and(resample_safe),
                _ => false,
            }
        }
        Expr::List(items) => !items.is_empty() && items.iter().all(resample_safe),
        _ => false,
    }
}

/// The head of a top-level call that samples a fixed parameter domain.
fn densify_head(expr: &Expr) -> Option<&'static str> {
    match expr {
        Expr::FunctionCall { name, .. } => DENSIFY_HEADS
            .iter()
            .find(|head| **head == name.as_str())
            .copied(),
        _ => None,
    }
}

/// The interpreter answers bare numbers, quoted strings and simple braced lists on
/// a fast path that does not record `%`/`Out[]` history, which makes `%` after such
/// a cell resolve to whatever came before it. Parenthesising the statement routes it
/// through the normal path, which does record it. The value and its typesetting are
/// unchanged.
fn literal_statement(statement: &str) -> String {
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

/// The iterator arguments of every listed plot call in the statement, by position.
/// No bound is evaluated and no head outside [`PLOT_KINDS`] is considered.
fn collect_plot_sites(expr: &Expr, path: &mut Vec<usize>, out: &mut Vec<Site>) {
    match expr {
        Expr::FunctionCall { name, args } => {
            if let Some(kind) = PLOT_KINDS.iter().find(|kind| kind.head == name.as_str()) {
                let take = |index: usize, axis: u8, path: &mut Vec<usize>, out: &mut Vec<Site>| {
                    if args.get(index).is_some_and(looks_like_iterator) {
                        path.push(index);
                        out.push(Site {
                            path: path.clone(),
                            axis,
                        });
                        path.pop();
                    }
                };
                take(kind.x, 0, path, out);
                if let Some(y) = kind.y {
                    take(y, 1, path, out);
                }
            }
            for (index, arg) in args.iter().enumerate() {
                path.push(index);
                collect_plot_sites(arg, path, out);
                path.pop();
            }
        }
        Expr::List(items) => {
            for (index, item) in items.iter().enumerate() {
                path.push(index);
                collect_plot_sites(item, path, out);
                path.pop();
            }
        }
        Expr::CompoundExpr(items) => {
            for (index, item) in items.iter().enumerate() {
                path.push(index);
                collect_plot_sites(item, path, out);
                path.pop();
            }
        }
        _ => {}
    }
}

fn iterator_with_bounds(expr: &Expr, bounds: (f64, f64)) -> Expr {
    match expr {
        Expr::List(items) if items.len() == 3 || items.len() == 4 => {
            let mut rebuilt = vec![items[0].clone(), Expr::Real(bounds.0), Expr::Real(bounds.1)];
            if items.len() == 4 {
                rebuilt.push(items[3].clone());
            }
            Expr::List(rebuilt.into())
        }
        other => other.clone(),
    }
}

fn with_plot_range(call: &Expr, view: ((f64, f64), (f64, f64))) -> Expr {
    match call {
        Expr::FunctionCall { name, args } => {
            let mut args: Vec<Expr> = args.iter().cloned().collect();
            args.push(Expr::Rule {
                pattern: Box::new(Expr::Identifier("PlotRange".to_string())),
                replacement: Box::new(range_expr(view.0, view.1)),
            });
            Expr::FunctionCall {
                name: name.clone(),
                args: args.into(),
            }
        }
        other => other.clone(),
    }
}

/// Rebuilds the statement with every sampling site bound to the visible range,
/// padded so that a small pan does not need another re-sample.
fn rewrite_sampling(
    expr: &Expr,
    view: ((f64, f64), (f64, f64)),
    sites: &[Site],
    path: &mut Vec<usize>,
) -> Expr {
    let owns_site = sites
        .iter()
        .any(|site| site.path.len() == path.len() + 1 && site.path[..path.len()] == path[..]);
    match expr {
        Expr::FunctionCall { name, args } => {
            let mut rebuilt: Vec<Expr> = Vec::with_capacity(args.len());
            for (index, arg) in args.iter().enumerate() {
                path.push(index);
                match sites.iter().find(|site| site.path == *path) {
                    Some(site) => {
                        let range = if site.axis == 0 { view.0 } else { view.1 };
                        rebuilt.push(iterator_with_bounds(arg, padded(range)));
                    }
                    None => rebuilt.push(rewrite_sampling(arg, view, sites, path)),
                }
                path.pop();
            }
            let call = Expr::FunctionCall {
                name: name.clone(),
                args: rebuilt.into(),
            };
            if owns_site {
                with_plot_range(&call, view)
            } else {
                call
            }
        }
        Expr::List(items) => {
            let mut rebuilt = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                path.push(index);
                rebuilt.push(rewrite_sampling(item, view, sites, path));
                path.pop();
            }
            Expr::List(rebuilt.into())
        }
        Expr::CompoundExpr(items) => {
            let mut rebuilt = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                path.push(index);
                rebuilt.push(rewrite_sampling(item, view, sites, path));
                path.pop();
            }
            Expr::CompoundExpr(rebuilt)
        }
        other => other.clone(),
    }
}

// registration and re-rendering

/// The plot call of a statement, kept unevaluated so a gesture can re-run it to
/// sample the visible range. The capture is a pure parse: nothing is evaluated, so
/// the interpreter's `%`/`Out[]` history is untouched. Only the last statement of a
/// cell is captured, and only when re-running it cannot run anything else.
struct Held {
    expr: Expr,
    sites: Vec<Site>,
}

fn held_statement(statement: &str) -> Option<Held> {
    let last = split_semicolons(statement)
        .into_iter()
        .rev()
        .find(|part| !part.trim().is_empty())?;
    let expr = woxi::syntax::string_to_expr(last.trim()).ok()?;
    if !resample_safe(&expr) {
        return None;
    }
    // Only the shape of the iterators matters. Bounds are left alone.
    let mut sites = Vec::new();
    let mut path = Vec::new();
    collect_plot_sites(&expr, &mut path, &mut sites);
    if sites.is_empty() && densify_head(&expr).is_none() {
        return None;
    }
    Some(Held { expr, sites })
}

/// Registers the graphic of the statement that just ran, if it is a 2D plot that
/// can be re-rendered at another range. Returns the `plot` payload for its item.
fn register_plot(graphic: &Expr, held: &Option<Held>) -> Option<String> {
    let ranges = plot_ranges(graphic)?;
    let id = NEXT_PLOT_VIEW.with(|next| {
        let id = next.get();
        next.set(id + 1);
        id
    });
    let call = held.as_ref().map(|held| PlotCall {
        expr: held.expr.clone(),
        sites: held.sites.clone(),
        densify: held.sites.is_empty(),
    });
    let resample = call.as_ref().is_some_and(|call| !call.sites.is_empty());
    let densify = call.as_ref().is_some_and(|call| call.densify);
    // Two-axis plots are only covered when both iterators can be re-sampled.
    let data_y = match &call {
        Some(call) if call.sites.iter().any(|site| site.axis == 1) => Some(ranges.1),
        _ => None,
    };
    let payload = plot_payload(id, ranges.0, ranges.1, ranges.0, data_y, resample, densify);
    PLOT_VIEWS.with(|views| {
        let mut views = views.borrow_mut();
        if views.len() >= MAX_PLOT_VIEWS {
            // Least recently touched first, and a plot no controller holds before
            // one that is still on screen.
            let victim = views
                .iter()
                .min_by_key(|(_, view)| (view.refs > 0, view.touched))
                .map(|(id, _)| *id);
            if let Some(victim) = victim {
                views.remove(&victim);
            }
        }
        let mut stored = graphic.clone();
        if let Expr::Graphics { svg, .. } = &mut stored {
            svg.clear();
        }
        views.insert(
            id,
            PlotView {
                graphic: stored,
                data: ranges.0,
                data_y,
                call,
                refs: 0,
                touched: next_touch(),
            },
        );
    });
    Some(payload)
}

fn next_touch() -> u64 {
    NEXT_TOUCH.with(|next| {
        let value = next.get();
        next.set(value + 1);
        value
    })
}

fn touch_view(id: u64) {
    PLOT_VIEWS.with(|views| {
        if let Some(view) = views.borrow_mut().get_mut(&id) {
            view.touched = next_touch();
        }
    });
}

/// Ties a handle to one more frontend controller (a duplicated cell copies the
/// markup, so two controllers can address the same plot).
fn retain_view(id: u64) {
    PLOT_VIEWS.with(|views| {
        if let Some(view) = views.borrow_mut().get_mut(&id) {
            view.refs = view.refs.saturating_add(1);
            view.touched = next_touch();
        }
    });
}

/// Drops the handle once the last controller that showed it is gone.
fn release_view(id: u64) {
    PLOT_VIEWS.with(|views| {
        let mut views = views.borrow_mut();
        let last = match views.get_mut(&id) {
            Some(view) => {
                view.refs = view.refs.saturating_sub(1);
                view.refs == 0
            }
            None => false,
        };
        if last {
            views.remove(&id);
        }
    });
}

fn clear_plot_views() {
    PLOT_VIEWS.with(|views| views.borrow_mut().clear());
}

fn range_expr(x: (f64, f64), y: (f64, f64)) -> Expr {
    let axis =
        |range: (f64, f64)| Expr::List(vec![Expr::Real(range.0), Expr::Real(range.1)].into());
    Expr::List(vec![axis(x), axis(y)].into())
}

/// The message shape used by the plot-interaction channel: one request object in,
/// one reply object out. `msg_type` says what to do, `content` carries the fields,
/// and a reply reports `status` with an `ename`/`evalue` pair on failure, the way a
/// Jupyter message does.
fn json_field_text(json: &str, key: &str) -> Option<String> {
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

fn json_field_number(json: &str, key: &str) -> Option<f64> {
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

fn json_field_numbers(json: &str, key: &str) -> Option<Vec<f64>> {
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

fn json_handle(json: &str) -> Option<u64> {
    json_field_number(json, "handle").map(|value| value as u64)
}

/// The range a request asks for, as `((x0, x1), (y0, y1))`.
fn json_view(json: &str) -> Option<((f64, f64), (f64, f64))> {
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

/// Why a plot request failed. The name and message go into the reply, so the
/// frontend can tell an expired handle (stop) from a render failure (retry later).
enum PlotFailure {
    /// No such handle: released, evicted, or the session was reset.
    Expired,
    /// The plot exists but cannot serve this kind of request.
    Unsupported,
    /// The render was attempted and failed.
    Failed,
}

impl PlotFailure {
    fn ename(&self) -> &'static str {
        match self {
            PlotFailure::Expired => "ExpiredHandle",
            PlotFailure::Unsupported => "UnsupportedPlotRequest",
            PlotFailure::Failed => "RenderFailed",
        }
    }

    fn evalue(&self) -> &'static str {
        match self {
            PlotFailure::Expired => "the plot handle no longer exists",
            PlotFailure::Unsupported => "the plot cannot be asked for this",
            PlotFailure::Failed => "the plot did not render",
        }
    }
}

fn reply_ok(msg_type: &str, content: &str) -> String {
    format!(
        "{{\"msg_type\":\"{}_reply\",\"status\":\"ok\",\"content\":{}}}",
        msg_type, content
    )
}

fn reply_error(msg_type: &str, ename: &str, evalue: &str) -> String {
    format!(
        "{{\"msg_type\":\"{}_reply\",\"status\":\"error\",\"ename\":\"{}\",\"evalue\":\"{}\"}}",
        msg_type,
        json_escape(ename),
        json_escape(evalue)
    )
}

fn plot_range_rule(view: ((f64, f64), (f64, f64))) -> Expr {
    Expr::Rule {
        pattern: Box::new(Expr::Identifier("PlotRange".to_string())),
        replacement: Box::new(range_expr(view.0, view.1)),
    }
}

/// Re-renders a registered plot at another data range, from Woxi's cached plot
/// data.
fn render_view(id: u64, (x, y): ((f64, f64), (f64, f64))) -> Result<String, PlotFailure> {
    let (stored, data, data_y, sample, densify) = PLOT_VIEWS
        .with(|views| {
            views.borrow().get(&id).map(|view| {
                (
                    view.graphic.clone(),
                    view.data,
                    view.data_y,
                    view.call
                        .as_ref()
                        .is_some_and(|call| !call.sites.is_empty()),
                    view.call.as_ref().is_some_and(|call| call.densify),
                )
            })
        })
        .ok_or(PlotFailure::Expired)?;

    let show = Expr::FunctionCall {
        name: "Show".to_string(),
        args: vec![stored, plot_range_rule((x, y))].into(),
    };
    let rendered =
        woxi::evaluator::evaluate_expr_to_expr(&show).map_err(|_| PlotFailure::Failed)?;
    let svg = match &rendered {
        Expr::Graphics { svg, .. } if !svg.trim().is_empty() => svg.clone(),
        _ => return Err(PlotFailure::Failed),
    };

    // Report the range that was asked for. Woxi's plot source keeps the range the
    // plot was created with, so reading it back would undo the gesture instead of
    // accumulating it (a drag would always start from the original view).
    // The stored graphic stays as it was registered: `PlotRange` is absolute, so
    // every gesture renders from the original picture, whatever came before.
    touch_view(id);
    let payload = plot_payload(id, x, y, data, data_y, sample, densify);
    Ok(graphics_item_with_plot(&svg, Some(&payload)))
}

/// Samples a registered plot again over the visible range and renders it there.
/// This is what adds data outside the range the plot was created with (zooming
/// out, or panning away) and finer detail inside it (zooming in on something that
/// oscillates faster than the original sampling could follow).
fn render_refine(id: u64, view: ((f64, f64), (f64, f64))) -> Result<String, PlotFailure> {
    let call = PLOT_VIEWS
        .with(|views| views.borrow().get(&id).and_then(|view| view.call.clone()))
        .ok_or(PlotFailure::Expired)?;
    if call.sites.is_empty() {
        // A fixed parameter domain: there is nothing to rewrite, only more points
        // to draw, which is a different request (`plot_densify`).
        return Err(PlotFailure::Unsupported);
    }

    let mut path = Vec::new();
    let rewritten = rewrite_sampling(&call.expr, view, &call.sites, &mut path);
    let rendered =
        woxi::evaluator::evaluate_expr_to_expr(&rewritten).map_err(|_| PlotFailure::Failed)?;
    let svg = match &rendered {
        Expr::Graphics { svg, .. } if !svg.trim().is_empty() => svg.clone(),
        _ => return Err(PlotFailure::Failed),
    };
    // The range the plot now samples. It is the padded iterator, not what the
    // graphic reports: Woxi's plot source keeps the `PlotRange` it was drawn with
    // (the view), while the extra room sampled around it is what the next pan uses
    // before another re-sample is needed.
    let data = padded(view.0);
    let data_y = if call.sites.iter().any(|site| site.axis == 1) {
        Some(padded(view.1))
    } else {
        None
    };
    // The newly sampled graphic serves the cheap `Show`-based view path from now on.
    // The call itself is kept so the next refine samples from the original again.
    let mut stored = rendered;
    if let Expr::Graphics { svg, .. } = &mut stored {
        svg.clear();
    }
    PLOT_VIEWS.with(|views| {
        if let Some(entry) = views.borrow_mut().get_mut(&id) {
            entry.graphic = stored;
            entry.data = data;
            entry.data_y = data_y;
            entry.touched = next_touch();
        }
    });

    let payload = plot_payload(id, view.0, view.1, data, data_y, true, false);
    Ok(graphics_item_with_plot(&svg, Some(&payload)))
}

fn plot_points_rule(points: usize) -> Expr {
    Expr::Rule {
        pattern: Box::new(Expr::Identifier("PlotPoints".to_string())),
        replacement: Box::new(Expr::Integer(points as i128)),
    }
}

/// Replaces (or adds) the sampling density of a call. Woxi takes the first of two
/// options with the same name, so an existing `PlotPoints` has to be replaced, not
/// appended to.
fn with_plot_points(call: &Expr, points: usize) -> Expr {
    match call {
        Expr::FunctionCall { name, args } => {
            let mut rebuilt: Vec<Expr> = Vec::with_capacity(args.len() + 1);
            let mut replaced = false;
            for arg in args.iter() {
                let is_points = matches!(
                    arg,
                    Expr::Rule { pattern, .. }
                        if matches!(&**pattern, Expr::Identifier(option) if option == "PlotPoints")
                );
                if is_points {
                    rebuilt.push(plot_points_rule(points));
                    replaced = true;
                } else {
                    rebuilt.push(arg.clone());
                }
            }
            if !replaced {
                rebuilt.push(plot_points_rule(points));
            }
            Expr::FunctionCall {
                name: name.clone(),
                args: rebuilt.into(),
            }
        }
        other => other.clone(),
    }
}

/// Draws a plot that samples a fixed parameter domain with more points, cropped to
/// the view. The domain never changes, so this adds detail inside it rather than
/// extending it - the opposite trade-off from a re-sample, and the only one that is
/// correct for a parametric or polar curve.
fn render_densify(
    id: u64,
    view: ((f64, f64), (f64, f64)),
    level: u32,
) -> Result<String, PlotFailure> {
    let (call, data) = PLOT_VIEWS
        .with(|views| {
            views.borrow().get(&id).and_then(|entry| {
                entry
                    .call
                    .clone()
                    .filter(|call| call.densify)
                    .map(|call| (call, entry.data))
            })
        })
        .ok_or(PlotFailure::Unsupported)?;

    let denser = woxi::evaluator::evaluate_expr_to_expr(&with_plot_points(
        &call.expr,
        densify_points(level),
    ))
    .map_err(|_| PlotFailure::Failed)?;
    if !matches!(denser, Expr::Graphics { .. }) {
        return Err(PlotFailure::Failed);
    }
    let show = Expr::FunctionCall {
        name: "Show".to_string(),
        args: vec![denser.clone(), plot_range_rule(view)].into(),
    };
    let cropped = woxi::evaluator::evaluate_expr_to_expr(&show).map_err(|_| PlotFailure::Failed)?;
    let svg = match &cropped {
        Expr::Graphics { svg, .. } if !svg.trim().is_empty() => svg.clone(),
        _ => return Err(PlotFailure::Failed),
    };
    // The denser picture serves the cheap `Show` path from now on. The call stays as
    // the user wrote it, so a later level samples from the original again.
    let mut stored = denser;
    if let Expr::Graphics { svg, .. } = &mut stored {
        svg.clear();
    }
    PLOT_VIEWS.with(|views| {
        if let Some(entry) = views.borrow_mut().get_mut(&id) {
            entry.graphic = stored;
            entry.touched = next_touch();
        }
    });
    let payload = plot_payload(id, view.0, view.1, data, None, false, true);
    Ok(graphics_item_with_plot(&svg, Some(&payload)))
}

/// One request, one reply. This is the whole plot-interaction channel.
fn plot_request(json: &str) -> String {
    let msg_type = json_field_text(json, "msg_type").unwrap_or_default();
    match msg_type.as_str() {
        "plot_view" | "plot_refine" | "plot_densify" => {
            let handle = json_handle(json);
            let view = json_view(json);
            let (Some(id), Some(view)) = (handle, view) else {
                return reply_error(
                    &msg_type,
                    "BadRequest",
                    "handle and x/y ranges are required",
                );
            };
            let result = match msg_type.as_str() {
                "plot_view" => render_view(id, view),
                "plot_refine" => render_refine(id, view),
                _ => {
                    let level = json_field_number(json, "level").unwrap_or(1.0).max(1.0) as u32;
                    render_densify(id, view, level)
                }
            };
            match result {
                Ok(item) => reply_ok(&msg_type, &item),
                Err(failure) => reply_error(&msg_type, failure.ename(), failure.evalue()),
            }
        }
        "plot_retain" => {
            if let Some(id) = json_handle(json) {
                retain_view(id);
            }
            reply_ok(&msg_type, "{}")
        }
        "plot_release" => {
            if let Some(id) = json_handle(json) {
                release_view(id);
            }
            reply_ok(&msg_type, "{}")
        }
        _ => reply_error(&msg_type, "UnknownMessage", "unknown msg_type"),
    }
}

// typing help
//
// The frontend asks these while the user types: which symbol names match a prefix
// (`complete_request`), what a symbol is and which options it takes
// (`inspect_request`), and whether the entry is finished (`is_complete_request`).
// The first two read the symbol table the interpreter already carries, so the
// answers agree with what the interpreter actually implements, and the third uses
// the interpreter's own parser. Nothing here evaluates the entry: the only
// evaluation is an `Options[...]` probe through `interpret_to_expr`, which does not
// record `Out[]` history.

/// Upper bound on a completion reply, whatever the request asks for.
const MAX_MATCHES: usize = 200;

/// Every symbol the interpreter knows, with whether Woxi implements it. Built once
/// from the `functions.csv` embedded in the interpreter, so a rebuild of the engine
/// is the only thing that can change it. `is_known_wolfram_function` is the
/// interpreter's own answer for "this name exists in Wolfram Language but Woxi does
/// not run it yet", which is the flag the completion list needs.
static SYMBOLS: LazyLock<Vec<(&'static str, bool)>> = LazyLock::new(|| {
    let mut table: Vec<(&'static str, bool)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for name in woxi::evaluator::functions::get_builtin_function_names() {
        if seen.insert(name) {
            table.push((
                name,
                !woxi::evaluator::functions::is_known_wolfram_function(name),
            ));
        }
    }
    for name in woxi::evaluator::functions::known_wolfram_function_names() {
        if seen.insert(name) {
            table.push((name, false));
        }
    }
    table.sort_unstable();
    table
});

fn symbol_table() -> &'static [(&'static str, bool)] {
    SYMBOLS.as_slice()
}

/// Whether `name` is a plain symbol name: the `Options[...]` probe below builds code
/// from it, so anything that could carry an operator or a bracket is refused.
fn is_symbol_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '$' => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '$' || ch == '`')
}

fn is_identifier_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '$' || ch == '`'
}

/// The identifier that ends at `cursor`, with the byte offset it starts at. The
/// caret is clamped to a character boundary: the request comes from JavaScript,
/// whose string offsets are UTF-16 code units.
fn identifier_before(code: &str, cursor: usize) -> (usize, &str) {
    let mut end = cursor.min(code.len());
    while end > 0 && !code.is_char_boundary(end) {
        end -= 1;
    }
    let mut start = end;
    for (index, ch) in code[..end].char_indices().rev() {
        if !is_identifier_char(ch) {
            break;
        }
        start = index;
    }
    (start, &code[start..end])
}

/// The identifier the caret is in or next to. Used by `inspect_request`, where the
/// caret may sit inside the name rather than after it.
fn identifier_at_cursor(code: &str, cursor: usize) -> &str {
    let mut start = cursor.min(code.len());
    while start > 0 && !code.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = start;
    for (index, ch) in code[start..].char_indices() {
        if !is_identifier_char(ch) {
            break;
        }
        end = start + index + ch.len_utf8();
    }
    let tail = start;
    for (index, ch) in code[..tail].char_indices().rev() {
        if !is_identifier_char(ch) {
            break;
        }
        start = index;
    }
    &code[start..end]
}

/// Whether `needle` is a subsequence of `haystack` that starts at its first character.
/// A loose subsequence would make a two-letter prefix match hundreds of names (`lo`
/// would find `Plot`), which is noise on a bar that shows three of them.
fn is_prefix_subsequence(needle: &str, haystack: &str) -> bool {
    let mut wanted = needle.chars();
    let mut chars = haystack.chars();
    let Some(first) = wanted.next() else {
        return true;
    };
    if chars.next() != Some(first) {
        return false;
    }
    wanted.all(|wanted| chars.any(|candidate| candidate == wanted))
}

/// How well `name` answers `prefix`: lower is better, `None` means no match. The
/// levels are exact name, prefix, camel-case initials (`PP` -> `PlotPoints`) and a
/// subsequence, which is what a half-remembered name looks like.
fn match_score(prefix: &str, name: &str) -> Option<u8> {
    if prefix.is_empty() {
        return Some(3);
    }
    let wanted = prefix.to_ascii_lowercase();
    let candidate = name.to_ascii_lowercase();
    if candidate == wanted {
        return Some(0);
    }
    if candidate.starts_with(&wanted) {
        return Some(1);
    }
    if prefix.chars().all(|ch| ch.is_ascii_uppercase()) {
        let initials: String = name.chars().filter(|ch| ch.is_ascii_uppercase()).collect();
        if initials.starts_with(prefix) {
            return Some(2);
        }
    }
    if is_prefix_subsequence(&wanted, &candidate) {
        return Some(4);
    }
    None
}

/// The documentation category of a symbol (`math`, `plotting`, ...), which is the
/// first path segment of its documentation URL.
fn category_of(name: &str) -> (&'static str, Option<&'static str>) {
    let Some(url) = woxi::evaluator::functions::get_doc_url(name) else {
        return ("", None);
    };
    let category = url
        .split_once("/docs/")
        .and_then(|(_, rest)| rest.split('/').next())
        .unwrap_or("");
    (category, Some(url))
}

/// One suggestion, with everything the bar and the sheet show about it.
struct Candidate {
    name: String,
    description: String,
    implemented: bool,
    session: bool,
    doc: Option<&'static str>,
    category: &'static str,
    score: u8,
}

/// Ranked suggestions for the prefix before `cursor`, plus the span the frontend
/// should replace when one is accepted.
fn candidates(
    code: &str,
    cursor: usize,
    limit: usize,
    category: &str,
) -> (usize, usize, usize, Vec<Candidate>) {
    let (start, prefix) = identifier_before(code, cursor);
    let mut rows: Vec<Candidate> = Vec::new();

    if category.is_empty() {
        for name in woxi::get_defined_names() {
            let Some(score) = match_score(prefix, &name) else {
                continue;
            };
            rows.push(Candidate {
                name,
                description: String::new(),
                implemented: true,
                session: true,
                doc: None,
                category: "",
                score,
            });
        }
    }

    for (name, implemented) in symbol_table() {
        let Some(score) = match_score(prefix, name) else {
            continue;
        };
        let (symbol_category, doc) = category_of(name);
        if !category.is_empty() && symbol_category != category {
            continue;
        }
        let description = woxi::evaluator::functions::get_builtin_function_info(name)
            .map(|info| info.description.to_string())
            .unwrap_or_default();
        rows.push(Candidate {
            name: name.to_string(),
            description,
            implemented: *implemented,
            session: false,
            doc,
            category: symbol_category,
            score,
        });
    }

    rows.sort_by(|a, b| {
        a.score
            .cmp(&b.score)
            .then_with(|| b.session.cmp(&a.session))
            .then_with(|| b.implemented.cmp(&a.implemented))
            .then_with(|| a.name.len().cmp(&b.name.len()))
            .then_with(|| a.name.cmp(&b.name))
    });
    let total = rows.len();
    rows.truncate(limit);
    (start, cursor, total, rows)
}

/// The caret position of a request, clamped to the code it points into.
fn cursor_of(json: &str, code: &str) -> usize {
    let raw = json_field_number(json, "cursor_pos").unwrap_or(code.len() as f64);
    let mut cursor = (raw.max(0.0) as usize).min(code.len());
    while cursor > 0 && !code.is_char_boundary(cursor) {
        cursor -= 1;
    }
    cursor
}

fn completion_content(json: &str) -> String {
    let code = json_field_text(json, "code").unwrap_or_default();
    let cursor = cursor_of(json, &code);
    let limit = json_field_number(json, "limit")
        .map(|value| (value.max(1.0) as usize).min(MAX_MATCHES))
        .unwrap_or(24);
    let category = json_field_text(json, "category").unwrap_or_default();
    let (start, end, total, rows) = candidates(&code, cursor, limit, &category);

    let mut matches = Vec::with_capacity(rows.len());
    let mut types = Vec::with_capacity(rows.len());
    let mut extra = Vec::with_capacity(rows.len());
    for row in &rows {
        matches.push(format!("\"{}\"", json_escape(&row.name)));
        types.push(format!(
            "{{\"text\":\"{}\",\"type\":\"{}\",\"docstring\":\"{}\"}}",
            json_escape(&row.name),
            if row.session { "variable" } else { "function" },
            json_escape(&row.description)
        ));
        extra.push(format!(
            "{{\"implemented\":{},\"category\":\"{}\",\"doc\":\"{}\"}}",
            if row.implemented { 1 } else { 0 },
            json_escape(row.category),
            json_escape(row.doc.unwrap_or(""))
        ));
    }

    format!(
        "{{\"matches\":[{}],\"cursor_start\":{},\"cursor_end\":{},\"metadata\":{{\"_jupyter_types_experimental\":[{}],\"_woxi\":[{}],\"total\":{}}}}}",
        matches.join(","),
        start,
        end,
        types.join(","),
        extra.join(","),
        total
    )
}

/// The options a symbol takes, in declaration order. `Options[f]` is evaluated
/// through `interpret_to_expr`, which does not record `Out[]` history.
fn options_of(name: &str) -> Vec<String> {
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
        if let Expr::Rule { pattern, .. } = rule {
            if let Expr::Identifier(option) = pattern.as_ref() {
                options.push(option.clone());
            }
        }
    }
    options
}

fn inspect_content(json: &str) -> String {
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
        lines.push(format!("Options: {}", options.join(", ")));
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
        .map(|option| format!("\"{}\"", json_escape(option)))
        .collect();
    format!(
        "{{\"found\":true,\"data\":{{\"text/plain\":\"{}\"}},\"metadata\":{{\"_woxi\":{{\"name\":\"{}\",\"description\":\"{}\",\"implemented\":{},\"category\":\"{}\",\"doc\":\"{}\",\"arity\":{},\"options\":[{}]}}}}}}",
        json_escape(&lines.join("\n")),
        json_escape(name),
        json_escape(&description),
        if implemented { 1 } else { 0 },
        json_escape(category),
        json_escape(doc.unwrap_or("")),
        arity_json,
        option_json.join(",")
    )
}

/// Bracket depth, ignoring string literals and `(* comments *)`. A positive result
/// means the input stops inside an opening bracket or an unterminated string, which
/// is what "not finished yet" looks like while typing.
fn bracket_depth(code: &str) -> i32 {
    let mut depth: i32 = 0;
    let mut chars = code.chars().peekable();
    let mut in_string = false;
    let mut comment_depth = 0usize;
    while let Some(ch) = chars.next() {
        if comment_depth > 0 {
            if ch == '(' && chars.peek() == Some(&'*') {
                chars.next();
                comment_depth += 1;
            } else if ch == '*' && chars.peek() == Some(&')') {
                chars.next();
                comment_depth -= 1;
            }
            continue;
        }
        if in_string {
            match ch {
                '\\' => {
                    chars.next();
                }
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '(' if chars.peek() == Some(&'*') => {
                chars.next();
                comment_depth = 1;
            }
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            _ => {}
        }
        if depth < 0 {
            return depth;
        }
    }
    if in_string || comment_depth > 0 {
        depth.max(1)
    } else {
        depth
    }
}

/// Whether the input stops on an operator (`1 + `), which the parser reports as an
/// error but the user is still writing.
fn ends_with_operator(code: &str) -> bool {
    let trimmed = code.trim_end();
    if trimmed.is_empty() {
        return false;
    }
    const TAILS: [&str; 15] = [
        "->", ":=", "/;", "/@", "//", "/.", ";;", "==", "<=", ">=", "!=", "&&", "||", "=.", "<>",
    ];
    if TAILS.iter().any(|tail| trimmed.ends_with(tail)) {
        return true;
    }
    matches!(
        trimmed.chars().last(),
        Some('+' | '-' | '*' | '/' | '^' | ',' | '=' | '&' | '|' | '@' | '~' | '<' | '>' | ':')
    )
}

fn is_complete_content(json: &str) -> String {
    let code = json_field_text(json, "code").unwrap_or_default();
    let status = if code.trim().is_empty() {
        "complete"
    } else {
        let depth = bracket_depth(&code);
        if depth > 0 || ends_with_operator(&code) {
            "incomplete"
        } else if depth < 0 || woxi::parse(&code).is_err() {
            "invalid"
        } else {
            "complete"
        }
    };
    format!("{{\"status\":\"{status}\",\"indent\":\"\"}}")
}

fn catalog_content() -> String {
    format!(
        "{{\"version\":\"{}\",\"total\":{}}}",
        env!("CARGO_PKG_VERSION"),
        symbol_table().len()
    )
}

fn query_request(json: &str) -> String {
    let msg_type = json_field_text(json, "msg_type").unwrap_or_default();
    match msg_type.as_str() {
        "complete_request" => reply_ok(&msg_type, &completion_content(json)),
        "inspect_request" => reply_ok(&msg_type, &inspect_content(json)),
        "is_complete_request" => reply_ok(&msg_type, &is_complete_content(json)),
        "catalog_request" => reply_ok(&msg_type, &catalog_content()),
        _ => reply_error(&msg_type, "UnknownMessage", "unknown msg_type"),
    }
}

// evaluation

fn evaluate_statement_items(stmt: &str, held: Option<Held>) -> Vec<String> {
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

fn evaluate_all(input: &str) -> String {
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
fn evaluate_manipulate(body: &str, bindings_json: &str) -> String {
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

/// Tiny parser for the flat `{"name":"InputForm"}` binding objects we produce.
fn parse_bindings(json: &str) -> Vec<(String, String)> {
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

// JNI entry points
//
// `jni` 0.22 hands a native method an `EnvUnowned`, which is FFI safe. The usable
// `Env` only exists inside `with_env`. Failures (a JNI error or a Rust panic) are
// resolved through `LogErrorAndDefault`, which logs and returns the default value -
// a null `jstring` here - so nothing unwinds into the JVM.

fn read_string(env: &Env, value: &JString) -> jni::errors::Result<String> {
    value.mutf8_chars(env).map(|chars| chars.to_string())
}

fn write_string(env: &mut Env, text: &str) -> jni::errors::Result<jstring> {
    env.new_string(text).map(|output| output.into_raw())
}

/// Runs `f` with the usable environment, turning a JNI error or a panic into the
/// default return value.
fn with_env<'frame, T: Default>(
    mut unowned: EnvUnowned<'frame>,
    f: impl FnOnce(&mut Env<'frame>) -> jni::errors::Result<T>,
) -> T {
    unowned.with_env(f).resolve::<LogErrorAndDefault>()
}

fn with_string<'frame, F>(unowned: EnvUnowned<'frame>, input: JString<'frame>, f: F) -> jstring
where
    F: FnOnce(&str) -> String + std::panic::UnwindSafe,
{
    with_env(unowned, |env| {
        let text = read_string(env, &input)?;
        // A Rust panic must not take the app down. Report it as a normal error item.
        let result = match std::panic::catch_unwind(|| f(&text)) {
            Ok(value) => value,
            Err(_) => "{\"error\":\"interpreter panicked\"}".to_string(),
        };
        write_string(env, &result)
    })
}

#[no_mangle]
pub extern "system" fn Java_com_woctordho_woximobile_NativeEngine_evaluateAll<'frame>(
    unowned: EnvUnowned<'frame>,
    _class: JClass<'frame>,
    input: JString<'frame>,
) -> jstring {
    with_string(unowned, input, evaluate_all)
}

#[no_mangle]
pub extern "system" fn Java_com_woctordho_woximobile_NativeEngine_evaluateManipulate<'frame>(
    unowned: EnvUnowned<'frame>,
    _class: JClass<'frame>,
    body: JString<'frame>,
    bindings: JString<'frame>,
) -> jstring {
    with_env(unowned, |env| {
        let body_text = read_string(env, &body)?;
        let bindings_text = read_string(env, &bindings)?;
        let result =
            match std::panic::catch_unwind(|| evaluate_manipulate(&body_text, &bindings_text)) {
                Ok(value) => value,
                Err(_) => "{\"text\":\"interpreter panicked\"}".to_string(),
            };
        write_string(env, &result)
    })
}

#[no_mangle]
pub extern "system" fn Java_com_woctordho_woximobile_NativeEngine_plotRequest<'frame>(
    unowned: EnvUnowned<'frame>,
    _class: JClass<'frame>,
    request: JString<'frame>,
) -> jstring {
    with_string(unowned, request, plot_request)
}

#[no_mangle]
pub extern "system" fn Java_com_woctordho_woximobile_NativeEngine_queryRequest<'frame>(
    unowned: EnvUnowned<'frame>,
    _class: JClass<'frame>,
    request: JString<'frame>,
) -> jstring {
    with_string(unowned, request, query_request)
}

#[no_mangle]
pub extern "system" fn Java_com_woctordho_woximobile_NativeEngine_clear<'frame>(
    _unowned: EnvUnowned<'frame>,
    _class: JClass<'frame>,
) {
    let _ = std::panic::catch_unwind(clear_plot_views);
    let _ = std::panic::catch_unwind(woxi::clear_state);
}

#[no_mangle]
pub extern "system" fn Java_com_woctordho_woximobile_NativeEngine_setDarkMode<'frame>(
    _unowned: EnvUnowned<'frame>,
    _class: JClass<'frame>,
    enabled: jboolean,
) {
    // `jboolean` is a plain `bool` since jni 0.22 (it was a `u8` before).
    let _ = std::panic::catch_unwind(move || woxi::set_dark_mode(enabled));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reset() {
        woxi::clear_state();
        clear_plot_views();
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

    #[test]
    fn bare_literals_are_parenthesised() {
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
    fn only_side_effect_free_wrappers_are_resampled() {
        assert!(resample_safe(&parse("Plot[Sin[x], {x, 0, 1}]")));
        assert!(resample_safe(&parse(
            "ParametricPlot[{Cos[t], Sin[t]}, {t, 0, 1}]"
        )));
        assert!(resample_safe(&parse(
            "Show[Plot[Sin[x], {x, 0, 1}], Axes -> False]"
        )));
        assert!(resample_safe(&parse("p = Plot[Sin[x], {x, 0, 1}]")));
        assert!(!resample_safe(&parse(
            "Module[{y = 2}, Plot[y x, {x, 0, 1}]]"
        )));
        assert!(!resample_safe(&parse(
            "Table[Plot[Sin[x], {x, 0, 1}], {k, 1, 2}]"
        )));
        assert!(!resample_safe(&parse("n++; Plot[Sin[x], {x, 0, 1}]")));
    }

    #[test]
    fn capture_is_a_pure_parse() {
        reset();
        let held = held_statement("Plot[Sin[x], {x, 0, 1}]").expect("plot statement");
        assert_eq!(held.sites.len(), 1);
        // A wrapper that may run code is not captured, so it is never re-run.
        assert!(held_statement("Module[{y = 2}, Plot[y x, {x, 0, 1}]]").is_none());
        // Nothing was evaluated, so the interpreter history is untouched.
        assert!(woxi::get_last_output().is_none());
    }

    #[test]
    fn percent_sees_bare_literals() {
        reset();
        evaluate_all("42");
        let items = evaluate_all("%");
        assert!(items.contains("\"text\":\"42\""), "{items}");
    }

    #[test]
    fn view_refine_and_release() {
        reset();
        let items = evaluate_all("Plot[Sin[x], {x, 0, 1}]");
        let handle = handle_of(&items);

        let reply = plot_request(&view_request("plot_view", handle, (0.2, 0.4), (-0.5, 0.5)));
        assert!(reply.contains("\"status\":\"ok\""), "{reply}");
        assert!(reply.contains("\"svg\":\"<svg"), "{reply}");

        let reply = plot_request(&view_request(
            "plot_refine",
            handle,
            (0.2, 0.4),
            (-0.5, 0.5),
        ));
        assert!(reply.contains("\"status\":\"ok\""), "{reply}");
        // Coverage is the padded view.
        assert!(reply.contains("\"d\":[0.15"), "{reply}");

        let retain =
            format!("{{\"msg_type\":\"plot_retain\",\"content\":{{\"handle\":{handle}}}}}");
        assert!(plot_request(&retain).contains("\"status\":\"ok\""));
        let release =
            format!("{{\"msg_type\":\"plot_release\",\"content\":{{\"handle\":{handle}}}}}");
        assert!(plot_request(&release).contains("\"status\":\"ok\""));
        let reply = plot_request(&view_request("plot_view", handle, (0.2, 0.4), (-0.5, 0.5)));
        assert!(reply.contains("ExpiredHandle"), "{reply}");
    }

    #[test]
    fn a_plot_inside_a_module_is_cached_only() {
        reset();
        let items = evaluate_all("Module[{y = 2}, Plot[y x, {x, 0, 1}]]");
        assert!(items.contains("\"plot\""), "{items}");
        assert!(items.contains("\"s\":false"), "{items}");
    }

    #[test]
    fn parametric_plots_densify_instead_of_resampling() {
        reset();
        let items = evaluate_all("ParametricPlot[{Cos[t], Sin[t]}, {t, 0, Pi/2}]");
        let handle = handle_of(&items);
        assert!(items.contains("\"dn\":true"), "{items}");
        assert!(items.contains("\"s\":false"), "{items}");

        let densify = format!(
            "{{\"msg_type\":\"plot_densify\",\"content\":{{\"handle\":{handle},\"x\":[-0.2,1.2],\"y\":[-0.2,1.2],\"level\":2}}}}"
        );
        let reply = plot_request(&densify);
        assert!(reply.contains("\"status\":\"ok\""), "{reply}");

        let reply = plot_request(&view_request("plot_refine", handle, (0.0, 1.0), (0.0, 1.0)));
        assert!(reply.contains("UnsupportedPlotRequest"), "{reply}");
    }

    #[test]
    fn unknown_messages_are_reported() {
        let reply = plot_request("{\"msg_type\":\"plot_dance\"}");
        assert!(reply.contains("\"status\":\"error\""), "{reply}");
        assert!(reply.contains("UnknownMessage"), "{reply}");
    }

    // typing help

    fn query(msg_type: &str, content: &str) -> String {
        query_request(&format!(
            "{{\"msg_type\":\"{msg_type}\",\"content\":{content}}}"
        ))
    }

    fn completion(code: &str, cursor: usize) -> String {
        query(
            "complete_request",
            &format!("{{\"code\":{code:?},\"cursor_pos\":{cursor}}}"),
        )
    }

    #[test]
    fn completion_ranks_prefix_before_subsequence() {
        let reply = completion("Plo", 3);
        assert!(reply.contains("\"status\":\"ok\""), "{reply}");
        // The prefix matches come first and in alphabetical order.
        let plot = reply.find("\"Plot\"").expect("Plot");
        let plot_points = reply.find("\"PlotPoints\"").expect("PlotPoints");
        assert!(plot < plot_points, "{reply}");
        // Camel-case initials reach a name the prefix cannot.
        let reply = completion("PP", 2);
        assert!(reply.contains("\"PlotPoints\""), "{reply}");
        // A subsequence still matches, after the prefix matches, as long as it starts
        // the name.
        let reply = completion("PltRange", 8);
        assert!(reply.contains("\"PlotRange\""), "{reply}");
        let reply = completion("lt", 2);
        assert!(!reply.contains("\"Plot\""), "{reply}");
    }

    #[test]
    fn completion_reports_the_span_to_replace() {
        let reply = completion("Sin[Plo", 7);
        assert!(reply.contains("\"cursor_start\":4"), "{reply}");
        assert!(reply.contains("\"cursor_end\":7"), "{reply}");
        // Outside a name the span is empty, so accepting inserts at the caret.
        let reply = completion("Sin[", 4);
        assert!(reply.contains("\"cursor_start\":4"), "{reply}");
        assert!(reply.contains("\"cursor_end\":4"), "{reply}");
    }

    #[test]
    fn completion_offers_session_symbols_first() {
        reset();
        let _ = woxi::interpret("myGadget[t_] := t^2");
        let reply = completion("myGad", 6);
        assert!(reply.contains("\"matches\":[\"myGadget\""), "{reply}");
        assert!(reply.contains("\"type\":\"variable\""), "{reply}");
    }

    #[test]
    fn inspect_reports_options_without_touching_history() {
        reset();
        let _ = woxi::interpret("41 + 1");
        let before = woxi::get_last_output().map(|expr| format!("{expr:?}"));
        let reply = query(
            "inspect_request",
            "{\"code\":\"Plot[Sin[x], {x, 0, 1}]\",\"cursor_pos\":2}",
        );
        assert!(reply.contains("\"found\":true"), "{reply}");
        assert!(reply.contains("\"name\":\"Plot\""), "{reply}");
        assert!(reply.contains("\"PlotRange\""), "{reply}");
        assert!(reply.contains("plotting"), "{reply}");
        let after = woxi::get_last_output().map(|expr| format!("{expr:?}"));
        assert_eq!(before, after, "inspect must not record Out[] history");
        // A name that is only known to Wolfram is reported as not implemented.
        let reply = query(
            "inspect_request",
            "{\"code\":\"PacletInstall\",\"cursor_pos\":5}",
        );
        assert!(reply.contains("\"implemented\":0"), "{reply}");
    }

    #[test]
    fn is_complete_separates_incomplete_from_invalid() {
        for code in [
            "Plot[x, {x, 0, 1",
            "Table[i, {i, 1, ",
            "Sin[1] +",
            "(1 +",
            "\"abc",
            "(* note",
        ] {
            let reply = query("is_complete_request", &format!("{{\"code\":{code:?}}}"));
            assert!(reply.contains("\"incomplete\""), "{code}: {reply}");
        }
        for code in ["1 + * 2", "Sin[1]]", "a = )"] {
            let reply = query("is_complete_request", &format!("{{\"code\":{code:?}}}"));
            assert!(reply.contains("\"invalid\""), "{code}: {reply}");
        }
        for code in [
            "Sin[1]",
            "Plot[Sin[x], {x, -2 Pi, 2 Pi}]",
            "Plot[x, {x, 0, 1}]",
            "a = 1;",
        ] {
            let reply = query("is_complete_request", &format!("{{\"code\":{code:?}}}"));
            assert!(reply.contains("\"complete\""), "{code}: {reply}");
        }
        // Brackets inside a string or a comment do not count.
        let reply = query("is_complete_request", "{\"code\":\"\\\"([\\\"\"}");
        assert!(reply.contains("\"complete\""), "{reply}");
    }

    #[test]
    fn catalog_and_unknown_queries() {
        let reply = query("catalog_request", "{}");
        assert!(reply.contains("\"total\":"), "{reply}");
        assert!(reply.contains("\"version\":"), "{reply}");
        let reply = query("complete_dance", "{}");
        assert!(reply.contains("UnknownMessage"), "{reply}");
    }
}
