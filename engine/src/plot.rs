//! Interactive 2D plot views.
//!
//! A rendered 2D plot is kept under a handle, the way a Jupyter kernel keeps the
//! outputs it may be asked to re-render. The stored graphic has its SVG dropped: the
//! renderer rebuilds the picture from the plot data the expression carries, so showing
//! the same plot at another `PlotRange` costs a re-render (a few milliseconds) instead
//! of re-evaluating the user's expression.
//!
//! This module owns the handle registry, the sampler rewriting behind pan and zoom, and
//! the request/reply protocol the frontend drives them with.

use crate::json::{
    json_field_number, json_field_text, json_handle, json_number, json_view, reply_error, reply_ok,
};
use crate::output::graphics_item_with_plot;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use woxi::syntax::Expr;

pub(crate) struct PlotView {
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
pub(crate) struct PlotCall {
    expr: Expr,
    sites: Vec<Site>,
    /// The call samples a fixed parameter domain (`ParametricPlot`, `PolarPlot`),
    /// so its bounds must never be rewritten. It can still be redrawn with more
    /// points when the view is zoomed in.
    densify: bool,
}

/// One iterator argument of a sampling call, and which axis it drives.
#[derive(Clone, PartialEq)]
pub(crate) struct Site {
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
pub(crate) struct PlotKind {
    head: &'static str,
    x: usize,
    y: Option<usize>,
}

pub(crate) const PLOT_KINDS: &[PlotKind] = &[
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
pub(crate) const REFINE_PAD: f64 = 0.25;

pub(crate) fn padded(range: (f64, f64)) -> (f64, f64) {
    let pad = (range.1 - range.0).abs() * REFINE_PAD;
    (range.0 - pad, range.1 + pad)
}

thread_local! {
    pub(crate) static PLOT_VIEWS: RefCell<HashMap<u64, PlotView>> = RefCell::new(HashMap::new());
    pub(crate) static NEXT_PLOT_VIEW: Cell<u64> = const { Cell::new(1) };
    pub(crate) static NEXT_TOUCH: Cell<u64> = const { Cell::new(1) };
}

/// How many rendered plots stay addressable. Older handles are dropped, and the
/// frontend stops treating a plot as interactive when its handle turns out to be
/// gone, so an evicted plot degrades to a still picture instead of retrying.
pub(crate) const MAX_PLOT_VIEWS: usize = 64;

/// The plot data behind a rendered graphic, when there is any.
pub(crate) fn plot_source(expr: &Expr) -> Option<&woxi::syntax::PlotSource> {
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
pub(crate) fn plot_ranges(expr: &Expr) -> Option<((f64, f64), (f64, f64))> {
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

pub(crate) fn number_of(expr: &Expr) -> Option<f64> {
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

pub(crate) fn point_of(expr: &Expr) -> Option<(f64, f64)> {
    match expr {
        Expr::List(items) if items.len() == 2 => {
            Some((number_of(&items[0])?, number_of(&items[1])?))
        }
        _ => None,
    }
}

pub(crate) fn add_point(x: f64, y: f64, min: &mut [f64; 2], max: &mut [f64; 2], count: &mut usize) {
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
pub(crate) fn collect_bounds(
    expr: &Expr,
    min: &mut [f64; 2],
    max: &mut [f64; 2],
    count: &mut usize,
) {
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

pub(crate) fn primitive_bounds(structure: &Expr) -> Option<((f64, f64), (f64, f64))> {
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    let mut count = 0usize;
    collect_bounds(structure, &mut min, &mut max, &mut count);
    if count == 0 || max[0] <= min[0] || max[1] <= min[1] {
        return None;
    }
    Some(((min[0], max[0]), (min[1], max[1])))
}

pub(crate) fn plot_payload(
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
pub(crate) fn looks_like_iterator(expr: &Expr) -> bool {
    match expr {
        Expr::List(items) => {
            items.len() >= 3 && items.len() <= 4 && matches!(items[0], Expr::Identifier(_))
        }
        _ => false,
    }
}

/// Heads that sample a fixed parameter domain. Their bounds are never rewritten -
/// that would change the curve - but they can be redrawn with more points.
pub(crate) const DENSIFY_HEADS: &[&str] = &["ParametricPlot", "PolarPlot"];

/// Sampling density for a densified re-render. Parametric and polar plots clamp
/// `PlotPoints` at 2000, and the default is 500.
pub(crate) fn densify_points(level: u32) -> usize {
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

/// Can this expression be evaluated again without running anything except the
/// plot? A `Show` only re-renders its arguments, a `Set` only stores the value it is
/// given, and a list of those is the same. Everything else - `Module`, `Table`, a
/// `CompoundExpression`, an arbitrary wrapper - may have side effects, so a plot
/// inside it keeps its cached data and is never re-sampled: doing nothing is better
/// than silently re-running user code on every gesture.
pub(crate) fn resample_safe(expr: &Expr) -> bool {
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
pub(crate) fn densify_head(expr: &Expr) -> Option<&'static str> {
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

/// The iterator arguments of every listed plot call in the statement, by position.
/// No bound is evaluated and no head outside [`PLOT_KINDS`] is considered.
pub(crate) fn collect_plot_sites(expr: &Expr, path: &mut Vec<usize>, out: &mut Vec<Site>) {
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

pub(crate) fn iterator_with_bounds(expr: &Expr, bounds: (f64, f64)) -> Expr {
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

pub(crate) fn with_plot_range(call: &Expr, view: ((f64, f64), (f64, f64))) -> Expr {
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
pub(crate) fn rewrite_sampling(
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
pub(crate) struct Held {
    pub(crate) expr: Expr,
    pub(crate) sites: Vec<Site>,
}

pub(crate) fn held_statement(statement: &str) -> Option<Held> {
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
pub(crate) fn register_plot(graphic: &Expr, held: &Option<Held>) -> Option<String> {
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

pub(crate) fn next_touch() -> u64 {
    NEXT_TOUCH.with(|next| {
        let value = next.get();
        next.set(value + 1);
        value
    })
}

pub(crate) fn touch_view(id: u64) {
    PLOT_VIEWS.with(|views| {
        if let Some(view) = views.borrow_mut().get_mut(&id) {
            view.touched = next_touch();
        }
    });
}

/// Ties a handle to one more frontend controller (a duplicated cell copies the
/// markup, so two controllers can address the same plot).
pub(crate) fn retain_view(id: u64) {
    PLOT_VIEWS.with(|views| {
        if let Some(view) = views.borrow_mut().get_mut(&id) {
            view.refs = view.refs.saturating_add(1);
            view.touched = next_touch();
        }
    });
}

/// Drops the handle once the last controller that showed it is gone.
pub(crate) fn release_view(id: u64) {
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

pub(crate) fn clear_plot_views() {
    PLOT_VIEWS.with(|views| views.borrow_mut().clear());
}

pub(crate) fn range_expr(x: (f64, f64), y: (f64, f64)) -> Expr {
    let axis =
        |range: (f64, f64)| Expr::List(vec![Expr::Real(range.0), Expr::Real(range.1)].into());
    Expr::List(vec![axis(x), axis(y)].into())
}

/// Why a plot request failed. The name and message go into the reply, so the
/// frontend can tell an expired handle (stop) from a render failure (retry later).
pub(crate) enum PlotFailure {
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

pub(crate) fn plot_range_rule(view: ((f64, f64), (f64, f64))) -> Expr {
    Expr::Rule {
        pattern: Box::new(Expr::Identifier("PlotRange".to_string())),
        replacement: Box::new(range_expr(view.0, view.1)),
    }
}

/// Re-renders a registered plot at another data range, from Woxi's cached plot
/// data.
pub(crate) fn render_view(
    id: u64,
    (x, y): ((f64, f64), (f64, f64)),
) -> Result<String, PlotFailure> {
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
pub(crate) fn render_refine(
    id: u64,
    view: ((f64, f64), (f64, f64)),
) -> Result<String, PlotFailure> {
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

pub(crate) fn plot_points_rule(points: usize) -> Expr {
    Expr::Rule {
        pattern: Box::new(Expr::Identifier("PlotPoints".to_string())),
        replacement: Box::new(Expr::Integer(points as i128)),
    }
}

/// Replaces (or adds) the sampling density of a call. Woxi takes the first of two
/// options with the same name, so an existing `PlotPoints` has to be replaced, not
/// appended to.
pub(crate) fn with_plot_points(call: &Expr, points: usize) -> Expr {
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
pub(crate) fn render_densify(
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
pub(crate) fn plot_request(json: &str) -> String {
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
