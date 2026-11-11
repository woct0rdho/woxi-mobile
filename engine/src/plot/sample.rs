//! The statement a gesture re-runs: its plot calls, the iterator arguments that describe
//! the axes, and the option rules that bind them to a range. Nothing here evaluates user
//! code: a captured statement is a pure parse, and only the heads in `PLOT_KINDS` have
//! their iterators rewritten.

use woxi::syntax::Expr;

/// Where a plot samples its data, inside the parsed statement.
#[derive(Clone)]
pub(crate) struct PlotCall {
    pub(super) expr: Expr,
    pub(super) sites: Vec<Site>,
    /// The call samples a fixed parameter domain (`ParametricPlot`, `PolarPlot`),
    /// so its bounds must never be rewritten. It can still be redrawn with more
    /// points when the view is zoomed in.
    pub(super) densify: bool,
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
/// Only heads whose pictures can become a scene belong here. `DensityPlot`,
/// `RegionPlot`, `VectorPlot`, `StreamPlot` and `StreamDensityPlot` are refused by
/// `scene()` (a raster, a filled region, arrows), so listing them would only make
/// `resample_safe` accept a re-run of a plot that can never pan.
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
        head: "ContourPlot",
        x: 1,
        y: Some(2),
    },
];

/// Extra room sampled around the visible range, so a small pan stays inside the data
/// instead of asking for another re-sample. Half a view on each side is the engine's default
/// (a re-sample that names no pad) and the gesture frame's tick margin; the client's coverage
/// re-samples ask for a larger `pad` (see `render_refine`), so one re-sample spans several views
/// and the curve stays ahead of a quick pan. A two-axis plot pays for the margin by area, so its
/// pad is capped lower.
pub(crate) const SAMPLE_PAD: f64 = 0.5;

fn padded_by(range: (f64, f64), pad: f64) -> (f64, f64) {
    let pad = (range.1 - range.0).abs() * pad;
    (range.0 - pad, range.1 + pad)
}

/// The sampling range around a view: `pad` views beyond it on each side, in data units on a
/// linear axis and in decades on a logarithmic one. Half a view below `{1, 100}` is `{0, 101}`
/// linearly, which has no logarithm at all; in decades it is `{0.316, 316}`.
pub(crate) fn padded_range(range: (f64, f64), pad: f64, logarithmic: bool) -> (f64, f64) {
    let (low, high) = range;
    if !logarithmic || low <= 0.0 {
        return padded_by(range, pad);
    }
    let decades = (high / low).log10() * pad;
    (low / 10f64.powf(decades), high * 10f64.powf(decades))
}

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

/// The most points-densification steps the client may ask for. The client's
/// `DENSIFY_MAX_LEVEL` is the same value, pinned by `tests/fixtures/protocol.json`.
pub(crate) const DENSIFY_MAX_LEVEL: u32 = 3;

/// Sampling density for a densified re-render. Parametric and polar plots clamp
/// `PlotPoints` at 2000, and the default is 500.
pub(crate) fn densify_points(level: u32) -> usize {
    match level.min(DENSIFY_MAX_LEVEL) {
        0 | 1 => 750,
        2 => 1500,
        _ => 2000,
    }
}

/// Heads whose arguments are graphics data rather than work. A `Show[Plot[...], Graphics[...]]`
/// re-renders the `Graphics` from the primitives it holds, so re-running it cannot do
/// anything that was not already drawn; a `Show` with anything else (a `Module`, a `Table`,
/// a user function) is not re-run. Missing a head here only costs the gesture its re-samples,
/// which is the safe way to be wrong.
const PURE_HEADS: &[&str] = &[
    "Graphics",
    "Graphics3D",
    "GraphicsComplex",
    "Style",
    "Directive",
    "Tooltip",
    "Annotation",
    "Legended",
    "Point",
    "Line",
    "Polygon",
    "Circle",
    "Disk",
    "Rectangle",
    "Text",
    "Inset",
    "RGBColor",
    "GrayLevel",
    "Hue",
    "CMYKColor",
    "Opacity",
    "Thickness",
    "AbsoluteThickness",
    "Dashing",
    "PointSize",
    "AbsolutePointSize",
];

/// Whether re-running this expression only redraws what it already holds: graphics data, an
/// option rule, a literal, a symbol. An argument of a `Show` that is one of these can be
/// left to re-render.
fn pure_graphics(expr: &Expr) -> bool {
    match expr {
        Expr::List(items) => items.iter().all(pure_graphics),
        Expr::FunctionCall { name, args } => {
            PURE_HEADS.contains(&name.as_str())
                && args
                    .iter()
                    .all(|arg| resample_safe(arg) || pure_graphics(arg))
        }
        Expr::Rule {
            pattern,
            replacement,
        }
        | Expr::RuleDelayed {
            pattern,
            replacement,
        } => pure_graphics(pattern) && pure_graphics(replacement),
        Expr::UnaryOp { operand, .. } => pure_graphics(operand),
        Expr::BinaryOp { left, right, .. } => pure_graphics(left) && pure_graphics(right),
        Expr::Integer(_)
        | Expr::BigInteger(_)
        | Expr::Real(_)
        | Expr::BigFloat(_, _)
        | Expr::String(_)
        | Expr::Identifier(_) => true,
        _ => false,
    }
}

/// Can this expression be evaluated again without running anything except the
/// plot? A `Show` only re-renders what it is given, a `Set` only stores the value it is
/// given, and a list of those is the same. Everything else - `Module`, `Table`, a
/// `CompoundExpression`, an arbitrary wrapper - may have side effects, so a plot inside it
/// keeps its cached data and is never re-sampled: doing nothing is better than silently
/// re-running user code on every gesture.
pub(crate) fn resample_safe(expr: &Expr) -> bool {
    match expr {
        Expr::FunctionCall { name, args } => {
            if PLOT_KINDS.iter().any(|kind| kind.head == name.as_str())
                || DENSIFY_HEADS.contains(&name.as_str())
            {
                return true;
            }
            match name.as_str() {
                // Every argument has to be either a plot to re-sample or graphics data to
                // draw again: `Show[Plot[...], Module[...]]` would run the module on every
                // gesture, which is exactly what this refuses.
                "Show" => args
                    .iter()
                    .all(|arg| resample_safe(arg) || pure_graphics(arg)),
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

fn option_rule(name: &str, value: Expr) -> Expr {
    Expr::Rule {
        pattern: Box::new(Expr::Identifier(name.to_string())),
        replacement: Box::new(value),
    }
}

/// Rebuilds a plot call with one option set. Woxi takes the first of two options with the
/// same name, so a value the user already wrote is replaced rather than appended to -
/// otherwise it would win over the one the engine needs.
fn with_option(call: &Expr, name: &str, value: Expr) -> Expr {
    match call {
        Expr::FunctionCall {
            name: function,
            args,
        } => {
            let mut rebuilt: Vec<Expr> = Vec::with_capacity(args.len() + 1);
            let mut replaced = false;
            for arg in args.iter() {
                let is_option = matches!(
                    arg,
                    Expr::Rule { pattern, .. }
                        if matches!(&**pattern, Expr::Identifier(option) if option == name)
                );
                if is_option {
                    rebuilt.push(option_rule(name, value.clone()));
                    replaced = true;
                } else {
                    rebuilt.push(arg.clone());
                }
            }
            if !replaced {
                rebuilt.push(option_rule(name, value));
            }
            Expr::FunctionCall {
                name: function.clone(),
                args: rebuilt.into(),
            }
        }
        other => other.clone(),
    }
}

/// Rebuilds the statement with every sampling site bound to the visible range, padded
/// by `pad` so that a small pan does not need another re-sample. `log` says which axes are
/// logarithmic, because half a view below a positive range is not a smaller positive range:
/// `LogLinearPlot[x, {x, 1, 100}]` refined at `{x, 3.8, 466}` pads linearly to `-227`, which
/// has no logarithm, so the evaluation fails and the plot stops re-sampling for good
/// (measured on the emulator: `resampleOff` latched). A log axis is padded in decades -
/// which is also how Woxi pads its own `LogLinearPlot` range.
pub(crate) fn rewrite_sampling(
    expr: &Expr,
    view: ((f64, f64), (f64, f64)),
    sites: &[Site],
    path: &mut Vec<usize>,
    pad: f64,
    log: (bool, bool),
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
                        let (range, logarithmic) = if site.axis == 0 {
                            (view.0, log.0)
                        } else {
                            (view.1, log.1)
                        };
                        rebuilt.push(iterator_with_bounds(
                            arg,
                            padded_range(range, pad, logarithmic),
                        ));
                    }
                    None => rebuilt.push(rewrite_sampling(arg, view, sites, path, pad, log)),
                }
                path.pop();
            }
            let call = Expr::FunctionCall {
                name: name.clone(),
                args: rebuilt.into(),
            };
            if owns_site {
                with_option(&call, "PlotRange", range_expr(view.0, view.1))
            } else {
                call
            }
        }
        Expr::List(items) => {
            let mut rebuilt = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                path.push(index);
                rebuilt.push(rewrite_sampling(item, view, sites, path, pad, log));
                path.pop();
            }
            Expr::List(rebuilt.into())
        }
        Expr::CompoundExpr(items) => {
            let mut rebuilt = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                path.push(index);
                rebuilt.push(rewrite_sampling(item, view, sites, path, pad, log));
                path.pop();
            }
            Expr::CompoundExpr(rebuilt)
        }
        other => other.clone(),
    }
}

/// Heads whose points are in data space but whose axis iterators are never rewritten: a fixed
/// parameter domain (`ParametricPlot`, `PolarPlot`) or a literal list of points. The data-space
/// heads that are rerunnable come from `PLOT_KINDS` itself (a kind with no y iterator), so one
/// table decides what a plot's points mean and what can be re-sampled; a head in neither source
/// is not guessed at. Missing a head here costs a plot its gestures (it stays a picture), which
/// is the safe way to be wrong.
const DATA_ONLY_HEADS: &[&str] = &[
    "ParametricPlot",
    "PolarPlot",
    "ListPlot",
    "ListLinePlot",
    "ListLogPlot",
    "ListLogLinearPlot",
    "ListLogLogPlot",
    "ListStepPlot",
    "DateListPlot",
    "Histogram",
];

/// Whether a head samples one axis, from the one table of plot heads plus the fixed-domain and
/// literal-list heads.
fn data_head(name: &str) -> bool {
    PLOT_KINDS
        .iter()
        .any(|kind| kind.head == name && kind.y.is_none())
        || DATA_ONLY_HEADS.contains(&name)
}

/// What a statement says about a plot's samples, from the heads it mentions.
///
/// This is what decides whether the points are y-mirrored, whether a view is a crop or an
/// evaluation, and whether there is a y coverage to check (see `Samples` in `handle.rs`). It
/// is read from the statement because nothing else knows: Woxi's `PlotSource` carries no such
/// flag, and a contour's points look like any other series once they are in the source.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Sampling {
    /// A head that samples one axis (`Plot`, `ListPlot`, a parametric curve): data space.
    Data,
    /// A head that samples two (`ContourPlot`): the producer reports y
    /// mirrored about the picture's range.
    TwoAxis,
    /// No plot head at all: a variable holding a plot, or a statement the engine does not
    /// read as one. Nothing can be said about its points.
    Unknown,
}

impl Sampling {
    /// The heads an expression mentions, anywhere: a plot inside a `Module` or a `Show` is
    /// still the plot whose points are in question.
    pub(crate) fn of(expr: &Expr) -> Sampling {
        let mut sampling = Sampling::Unknown;
        mention(expr, &mut |name| {
            if PLOT_KINDS
                .iter()
                .any(|kind| kind.head == name && kind.y.is_some())
            {
                // A two-axis head anywhere wins: a `Show` mixing both kinds is one picture,
                // and its samples are as mirrored as its field plot's.
                sampling = Sampling::TwoAxis;
                return true;
            }
            if sampling == Sampling::Unknown && data_head(name) {
                sampling = Sampling::Data;
            }
            false
        });
        sampling
    }
}

/// Calls `hit` on every head in `expr`, stopping at the first one it accepts.
fn mention<F: FnMut(&str) -> bool>(expr: &Expr, hit: &mut F) -> bool {
    match expr {
        Expr::FunctionCall { name, args } => hit(name) || args.iter().any(|arg| mention(arg, hit)),
        Expr::List(items) => items.iter().any(|item| mention(item, hit)),
        Expr::CompoundExpr(items) => items.iter().any(|item| mention(item, hit)),
        _ => false,
    }
}

/// The plot call of a statement, kept unevaluated so a gesture can re-run it to
/// sample the visible range. The capture is a pure parse: nothing is evaluated, so
/// the interpreter's `%`/`Out[]` history is untouched. Only the last statement of a
/// cell is captured, and only when re-running it cannot run anything else.
pub(crate) struct Held {
    pub(crate) expr: Expr,
    pub(crate) sites: Vec<Site>,
}

/// What a cell's last statement offers a gesture: the call to re-run, when it can be re-run,
/// and the space its samples are in. The two are independent - a `ListPlot` has no iterators
/// to rewrite but its points are data, a `Module` may wrap a contour whose points are
/// mirrored - so they are kept apart instead of being read out of one another.
pub(crate) struct Capture {
    pub(crate) held: Option<Held>,
    pub(crate) sampling: Sampling,
}

/// Captures the last statement of a cell (see [`Capture`]). The parse is pure: nothing is
/// evaluated, so the interpreter's `%`/`Out[]` history is untouched.
pub(crate) fn capture_statement(statement: &str) -> Capture {
    let unknown = Capture {
        held: None,
        sampling: Sampling::Unknown,
    };
    let Some(last) = crate::eval::split_semicolons(statement)
        .into_iter()
        .rev()
        .find(|part| !part.trim().is_empty())
    else {
        return unknown;
    };
    let Ok(expr) = woxi::syntax::string_to_expr(last.trim()) else {
        return unknown;
    };
    let sampling = Sampling::of(&expr);
    if !resample_safe(&expr) {
        return Capture {
            held: None,
            sampling,
        };
    }
    let mut sites = Vec::new();
    let mut path = Vec::new();
    collect_plot_sites(&expr, &mut path, &mut sites);
    let held = if sites.is_empty() && densify_head(&expr).is_none() {
        None
    } else {
        Some(Held { expr, sites })
    };
    Capture { held, sampling }
}

fn range_expr(x: (f64, f64), y: (f64, f64)) -> Expr {
    let axis =
        |range: (f64, f64)| Expr::List(vec![Expr::Real(range.0), Expr::Real(range.1)].into());
    Expr::List(vec![axis(x), axis(y)].into())
}

pub(super) fn plot_range_rule(view: ((f64, f64), (f64, f64))) -> Expr {
    option_rule("PlotRange", range_expr(view.0, view.1))
}

/// The frame's height over width, which a `Show` re-render has to be told: without it, `Show`
/// lays the graphic out at its own default shape, and a square picture comes back 1.6:1.
/// The value is measured from the picture being cropped (see `PlotView::aspect`), so it
/// carries whatever `AspectRatio` the user wrote.
pub(crate) fn aspect_rule(aspect: f64) -> Expr {
    option_rule("AspectRatio", Expr::Real(aspect))
}

/// Replaces (or adds) the sampling density of a call.
pub(crate) fn with_plot_points(call: &Expr, points: usize) -> Expr {
    with_option(call, "PlotPoints", Expr::Integer(points as i128))
}
