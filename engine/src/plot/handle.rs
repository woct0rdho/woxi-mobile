//! The registry of stored plots, the requests that re-render or re-sample one, and the
//! `plot_*` protocol the frontend drives them with. One `PlotView` per rendered plot, kept
//! until its handle is released or the cap evicts the least recently used.

use super::contour::{repair_graphic, repair_graphic_source};
use super::frame::{layer_drawable, plot_layer, plot_source};
use super::sample::{
    aspect_rule, densify_head, densify_points, padded_range, plot_range_rule, rewrite_sampling,
    with_plot_points, Capture, PlotCall, Sampling, SAMPLE_PAD,
};
use super::scene::{scene, unmodeled_options};
use crate::json::{
    json_field_bool_opt, json_field_number, json_field_text, json_handle, json_object, json_range,
    json_view, reply_error, reply_ok,
};
use crate::output::graphics_item_with_plot;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use woxi::syntax::Expr;

pub(crate) struct PlotView {
    /// The graphic the gestures re-render at other ranges, SVG removed.
    graphic: Expr,
    /// How the samples relate to the picture, and the range they cover (see [`Samples`]).
    pub(super) samples: Samples,
    /// The statement that produced the graphic, unevaluated, so it can be re-run to
    /// sample a different range. `None` when the plot has no iterator to rewrite.
    pub(super) call: Option<PlotCall>,
    /// The statement mentions a contour picture, so its SVG and plot source go
    /// through the contour junction cleanup before a view, sample or picture is read.
    contour: bool,
    /// Monotonic use counter, so eviction at the cap drops the least recently
    /// touched plot rather than the oldest registered one.
    touched: u64,
    /// The frame's height over width in the picture's own user units, as the client measures
    /// it from the scene on screen (the first scene's `frame`). A crop goes through `Show`,
    /// which lays the graphic out again: without this it comes back at its own default shape
    /// (a parametric plot's square picture turned into a 1.6:1 one), and with it the frame
    /// keeps the shape it had - including whatever `AspectRatio` the user wrote, because that
    /// is already part of the picture being measured. `None` until the first view request: a
    /// fresh picture is not cropped, so nothing needs it yet.
    aspect: Option<f64>,
}

/// How a plot's samples relate to the picture that shows them, as far as the statement that
/// produced it says. This is the one place that answers "one axis or two": whether the points
/// are y-mirrored, whether there is a `dy` to check, and whether a view re-evaluates the call
/// or crops the picture. Every decision that depends on it reads it here instead of comparing
/// a range against `None`.
///
/// The statement is the only witness. Woxi's `PlotSource` says nothing about it, and a
/// contour's points are generated in the renderer's mirrored space, which is
/// indistinguishable from data once it is in a `PlotSeriesData`.
#[derive(Clone, Copy, PartialEq)]
pub(super) enum Samples {
    /// One axis (`Plot`, `ListPlot`, the parametric family): the points are in data space, and
    /// a view is a `Show` crop of the picture, which draws the same curve at any range.
    X((f64, f64)),
    /// Two axes (`ContourPlot`): the producer reports y mirrored about the picture's y range
    /// and lays the picture out at its own range, so the points are un-mirrored on the way out
    /// and a view re-evaluates the call.
    XY { x: (f64, f64), y: (f64, f64) },
}

impl Samples {
    /// The layout of a plot from what its statement says, or `None` when a gesture cannot
    /// serve it. A field plot is re-rendered by evaluating its call: `Show` re-renders the
    /// primitives Woxi stored, and those are in the same mirrored y space, so a crop of a
    /// field picture comes back upside down as well as re-laid out. And a picture no plot head
    /// mentions cannot be told from one, so it is not panned either. Both stay still pictures,
    /// as rasters and user `Graphics[...]` do.
    fn of(
        sampling: Sampling,
        coverage: ((f64, f64), (f64, f64)),
        rerunnable: bool,
    ) -> Option<Samples> {
        match sampling {
            Sampling::Data => Some(Samples::X(coverage.0)),
            Sampling::TwoAxis if rerunnable => Some(Samples::XY {
                x: coverage.0,
                y: coverage.1,
            }),
            _ => None,
        }
    }

    /// The x range the samples cover.
    fn x(self) -> (f64, f64) {
        match self {
            Samples::X(x) | Samples::XY { x, .. } => x,
        }
    }

    /// The y range the samples cover: `None` for a plot that samples only x, where a coverage
    /// check would be meaningless.
    fn y(self) -> Option<(f64, f64)> {
        match self {
            Samples::XY { y, .. } => Some(y),
            Samples::X(_) => None,
        }
    }

    /// Whether the samples are in the producer's mirrored y space.
    fn mirrored(self) -> bool {
        matches!(self, Samples::XY { .. })
    }

    /// The range a re-sample stored, keeping the axes this plot samples.
    fn with_coverage(self, x: (f64, f64), y: (f64, f64)) -> Samples {
        match self {
            Samples::X(_) => Samples::X(x),
            Samples::XY { .. } => Samples::XY { x, y },
        }
    }
}

thread_local! {
    pub(crate) static PLOT_VIEWS: RefCell<HashMap<u64, PlotView>> = RefCell::new(HashMap::new());
    /// Handles and use order share one counter: a handle is never reused, and comparing
    /// two entries by the counter they were last touched at is all the cap needs.
    static SEQUENCE: Cell<u64> = const { Cell::new(1) };
}

fn next_sequence() -> u64 {
    SEQUENCE.with(|sequence| {
        let value = sequence.get();
        sequence.set(value + 1);
        value
    })
}

/// How many rendered plots stay addressable. Older handles are dropped, and the frontend
/// stops asking the engine about an evicted plot: it keeps panning the cached scene and
/// samples locally until the entry is evaluated again, which registers a fresh handle.
pub(crate) const MAX_PLOT_VIEWS: usize = 64;

/// Registers the graphic of the statement that just ran, if it is a 2D plot that
/// can be re-rendered at another range. Returns the `plot` payload for its item and the
/// samples a canvas would draw.
pub(crate) fn register_plot(graphic: &Expr, capture: &Capture) -> Option<(String, String)> {
    // The plot source is the only witness a gesture can re-render: a `Graphics[...]` built from
    // primitives, a region or a raster has none, so it is refused before any work. One
    // mechanism, no fallback path.
    let (svg, source) = match graphic {
        Expr::Graphics {
            svg,
            source: Some(source),
            ..
        } => (svg, source),
        _ => return None,
    };
    if source.series.is_empty() || !layer_drawable(source) || unmodeled_options(source) {
        return None;
    }
    // The picture's range (`x_range`/`y_range`) is the padded, displayed range. The samples cover
    // the iterator's domain, which Woxi reports as `data_x_range`: claiming the displayed range as
    // coverage would say the canvas has points it does not have when `PlotRange` is wider than the
    // iterator (`Plot[Sin[x], {x, -5, 5}, PlotRange -> {{-10, 10}, Automatic}]` draws nothing past
    // x = 5, but `x_range` is [-10, 10]), so a pan to [5, 10] would never ask for a re-sample.
    // A two-axis plot has no `data_y_range`. Its y coverage stays the displayed range.
    let view = (source.x_range, source.y_range);
    let coverage = (
        source.data_x_range.unwrap_or(source.x_range),
        source.y_range,
    );
    let id = next_sequence();
    let call = capture.held.as_ref().map(|held| PlotCall {
        expr: held.expr.clone(),
        sites: held.sites.clone(),
        // A fixed parameter domain (`ParametricPlot`, `PolarPlot`) is the only kind that
        // gains from a denser sampling. A call wrapped in something else (`Show[...]`)
        // cannot be asked for more points: the option would land on the wrapper.
        densify: densify_head(&held.expr).is_some(),
    });
    let samples = Samples::of(capture.sampling, coverage, call.is_some())?;
    // Interactive plots are drawn by the client from a scene (see `scene`): the series from the
    // samples, the axes and labels from the scene. A picture the scene cannot express is not
    // interactive - it stays a still picture, and no handle is registered for it.
    let scene = scene(svg, source, view, samples.mirrored())?.json();
    PLOT_VIEWS.with(|views| {
        let mut views = views.borrow_mut();
        if views.len() >= MAX_PLOT_VIEWS {
            let victim = views
                .iter()
                .min_by_key(|(_, view)| view.touched)
                .map(|(id, _)| *id);
            if let Some(victim) = victim {
                views.remove(&victim);
            }
        }
        views.insert(
            id,
            PlotView {
                graphic: without_svg(graphic.clone()),
                samples,
                call,
                contour: capture.contour(),
                // Ids and use order share a counter, so a fresh handle is the newest.
                touched: id,
                // The first view request brings it, measured from the picture on screen.
                aspect: None,
            },
        );
    });
    let (payload, layer) = with_view(id, |entry| {
        let payload = picture_payload(id, entry, view.0, view.1, Some(&scene));
        (payload, layer_of(entry))
    })
    .ok()?;
    Some((payload, layer))
}

/// Runs `f` on one entry. One borrow answers one request: a reply's payload and its samples
/// come from the same reading of the same entry. Reads do not count as uses - `touch` does,
/// once per request - so a request that reads the entry six times is still one use.
fn with_view<T>(id: u64, f: impl FnOnce(&mut PlotView) -> T) -> Result<T, PlotFailure> {
    PLOT_VIEWS.with(|views| {
        let mut views = views.borrow_mut();
        let entry = views.get_mut(&id).ok_or(PlotFailure::Expired)?;
        Ok(f(entry))
    })
}

/// Marks one handle as the most recently used, so the cap evicts the least recently asked
/// for rather than the oldest registered one.
fn touch(id: u64) {
    PLOT_VIEWS.with(|views| {
        if let Some(entry) = views.borrow_mut().get_mut(&id) {
            entry.touched = next_sequence();
        }
    });
}

/// The graphic without its SVG: the renderer rebuilds the picture from the plot data, and
/// the samples are all a re-render needs.
fn without_svg(mut graphic: Expr) -> Expr {
    if let Expr::Graphics { svg, .. } = &mut graphic {
        svg.clear();
    }
    graphic
}

/// The samples a reply carries for this plot. A reply that could bring samples always
/// brings an answer: a graphic with no source to sample (`RegionPlot`, `Graphics[...]`),
/// or one whose statement says nothing about its points, still has nothing a canvas can be
/// trusted to draw, and saying so at registration is what keeps the client from spending a
/// round trip, and a re-evaluation, to find out.
fn layer_of(entry: &PlotView) -> String {
    plot_layer(&entry.graphic, entry.samples.mirrored())
}

/// Drops the handle: the controller that showed it is gone (its node was replaced, or the
/// cell was deleted).
pub(crate) fn release_view(id: u64) {
    PLOT_VIEWS.with(|views| {
        views.borrow_mut().remove(&id);
    });
}

pub(crate) fn clear_plot_views() {
    PLOT_VIEWS.with(|views| views.borrow_mut().clear());
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

/// Decades below its high bound a logarithmic axis is allowed to reach. Woxi draws an
/// axis-less picture for a range that includes zero (measured: `Show[LogPlot[Exp[x], {x, -5,
/// 5}], PlotRange -> {{-5, 5}, {0, 258}}]` is 762 B with one polyline and no ticks, labels or
/// frame), and it draws any positive bound. A gesture keeps a log range positive by scaling
/// both bounds, so this only repairs a request from an older client or a notebook that stored
/// such a view. The reply reports the repaired range, so the client starts from it next time.
pub(crate) const LOG_FALLBACK_DECADES: f64 = 12.0;

/// Whether each axis of the picture is logarithmic, from its plot source.
fn log_axes(entry: &PlotView) -> (bool, bool) {
    super::frame::plot_source(&entry.graphic)
        .map(|source| (source.log_x, source.log_y))
        .unwrap_or((false, false))
}

/// The largest sample margin a one-axis re-sample may ask for, in views. The client's first
/// interaction uses 2.5 and its cap is 4. The engine clamps whatever arrives.
pub(crate) const MAX_REFINE_PAD: f64 = 4.0;
/// A two-axis re-sample evaluates the call over an area, so its margin is capped lower.
pub(crate) const TWO_AXIS_MAX_REFINE_PAD: f64 = 1.0;

/// A view with each logarithmic axis made drawable. Only a non-positive low bound is
/// touched. A valid one is returned as it came.
fn drawable_view(
    view: ((f64, f64), (f64, f64)),
    (log_x, log_y): (bool, bool),
) -> ((f64, f64), (f64, f64)) {
    let axis = |range: (f64, f64), logarithmic: bool| {
        let (low, high) = range;
        if !logarithmic || low > 0.0 || high <= 0.0 {
            return range;
        }
        let fallback = high / 10f64.powf(LOG_FALLBACK_DECADES);
        (if fallback > 0.0 { fallback } else { high }, high)
    };
    (axis(view.0, log_x), axis(view.1, log_y))
}

/// A frame's height over width accepted from the client. Anything outside this is not a ratio of
/// a frame (a bad measurement or a corrupted request), and the crop uses the picture's own shape.
const MAX_FRAME_ASPECT: f64 = 1e3;

/// Re-renders a registered plot at another data range, from Woxi's cached plot data.
/// `measured_aspect` is the frame's shape the client measured on the picture it is showing. It
/// is what keeps a crop from being laid out at a different shape than the picture it replaces.
/// `want_picture` asks for the markup: a gesture frame leaves it out, because the client is
/// drawing from the scene and the samples, and the markup only exists to be saved.
pub(crate) fn render_view(
    id: u64,
    view: ((f64, f64), (f64, f64)),
    measured_aspect: Option<f64>,
    want_picture: bool,
) -> Result<String, PlotFailure> {
    let (two_axis, stored, stored_aspect, logs, contour) = with_view(id, |entry| {
        let two_axis = entry.samples.mirrored();
        // A two-axis view re-evaluates the captured call. The stored graphic is not read, and for
        // a big contour its source points are large. Clone it only for a one-axis crop.
        let stored = (!two_axis).then(|| entry.graphic.clone());
        (
            two_axis,
            stored,
            entry.aspect,
            log_axes(entry),
            entry.contour,
        )
    })?;
    let view = drawable_view(view, logs);
    // A ratio of a plot's frame: anything else is a request to draw nothing.
    let aspect = measured_aspect
        .filter(|aspect| aspect.is_finite() && *aspect > 0.0 && *aspect < MAX_FRAME_ASPECT)
        .or(stored_aspect);
    // A two-axis plot is evaluated at the range instead of being cropped. `Show` lays such a
    // picture out again with a different shape: the same six units of y came back in a 3600x3680
    // canvas for one range and 3600x3570 for the next, with the data area 3465 units tall for the
    // first and 2842 for the second - a shape that changes per frame puts the axes somewhere other
    // than the curve. Evaluating at the range keeps the shape its convention asks for (a contour
    // comes back 3444x3444 at any range).
    let mut rendered = if two_axis {
        evaluate_at(id, view, 0.0, logs)?
    } else {
        render_at(stored.as_ref().ok_or(PlotFailure::Failed)?, view, aspect)?
    };
    if contour {
        repair_graphic(&mut rendered);
    }
    let svg = graphics_svg(&rendered).ok_or(PlotFailure::Failed)?;
    // What the client draws is the scene, so a failure to express it means this view cannot be
    // served - the plot keeps the last scene it has instead of half-updating the aspect too.
    let mut drawn = match plot_source(&rendered) {
        Some(source) => scene(&svg, source, view, two_axis).ok_or(PlotFailure::Failed)?,
        None => return Err(PlotFailure::Failed),
    };
    // The shape this picture has is the shape the next crop has to keep. Only a view that was
    // actually drawn may change it.
    if aspect != stored_aspect {
        with_view(id, |entry| entry.aspect = aspect)?;
    }
    // A one-axis gesture frame carries the ticks the finger is about to reach: the picture is
    // rendered a second time at the samples' margin, and the ticks that render has and this one
    // does not are merged in. The layout (frame, labels' offsets, texts) stays the view's, so
    // they are drawn exactly like the ones in the view - they are simply outside it until the
    // finger gets there. A two-axis plot is re-evaluated at the padded range instead, which is
    // a whole extra evaluation per frame. Its ticks arrive with the next answer. A framed plot
    // has no axis ticks and its frame ticks are on fixed edges, so there is nothing to absorb:
    // skip the second render, which is the larger half of a gesture frame's engine cost.
    let has_axis_lines = drawn.has_axis_lines();
    if !want_picture && !two_axis && has_axis_lines {
        let padded = (
            padded_range(view.0, SAMPLE_PAD, logs.0),
            padded_range(view.1, SAMPLE_PAD, logs.1),
        );
        if let Some(stored) = stored.as_ref() {
            if let Ok(ahead) = render_at(stored, padded, aspect) {
                if let (Some(ahead_svg), Some(ahead_source)) =
                    (graphics_svg(&ahead), plot_source(&ahead))
                {
                    if let Some(ahead_scene) = scene(&ahead_svg, ahead_source, padded, two_axis) {
                        drawn.absorb_ticks(&ahead_scene, logs);
                    }
                }
            }
        }
    }
    let scene = drawn.json();
    // A gesture frame carries no picture: the client is drawing from the scene and the samples,
    // and the markup only exists to be saved (the next answer at rest brings it).
    let picture = want_picture.then_some(svg.as_str());
    reply_picture(id, view, picture, &scene)
}

/// The graphic a range would render, without storing anything: a `Show` crop of a one-axis
/// plot. `render_view` uses it for the view and, on a one-axis gesture frame, for the samples'
/// margin whose extra ticks the scene absorbs.
fn render_at(
    stored: &Expr,
    range: ((f64, f64), (f64, f64)),
    aspect: Option<f64>,
) -> Result<Expr, PlotFailure> {
    // `Show` re-lays the crop out at the range asked for, and Woxi's `PlotRangePadding` can put
    // the axes a percent outside it. The merged renderer ignores a `PlotRangePadding` option
    // (checked: the same curve in every variant). The crop clips the curve to its axes and draws
    // the ticks at the requested range, so the payload reports that range and the client maps it
    // onto the frame.
    let mut args = vec![stored.clone(), plot_range_rule(range)];
    if let Some(aspect) = aspect {
        args.push(aspect_rule(aspect));
    }
    let show = Expr::FunctionCall {
        name: "Show".to_string(),
        args: args.into(),
    };
    woxi::evaluator::evaluate_expr_to_expr(&show).map_err(|_| PlotFailure::Failed)
}

/// The SVG of a rendered graphic, or `None` when the evaluation produced something
/// else (an error message, an unevaluated call).
fn graphics_svg(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Graphics { svg, .. } if !svg.trim().is_empty() => Some(svg.clone()),
        _ => None,
    }
}

/// Whether a rendered graphic has a picture, without cloning the SVG: a re-sample and a
/// densify only need to know that the render succeeded, and a contour's SVG is not small.
fn has_svg(expr: &Expr) -> bool {
    matches!(expr, Expr::Graphics { svg, .. } if !svg.trim().is_empty())
}

/// What a reply that carries a picture reports: the range that picture shows, where that
/// range sits in the picture's own user units (see `frame::picture_rect`), the range the
/// samples cover, and what the plot can still do - re-sample its iterators, or be redrawn
/// with more points.
fn picture_payload(
    id: u64,
    view: &PlotView,
    x: (f64, f64),
    y: (f64, f64),
    scene: Option<&str>,
) -> String {
    let call = view.call.as_ref();
    json_object(&[
        ("id", Some(id.to_string())),
        ("x", Some(json_range(x))),
        ("y", Some(json_range(y))),
        // `d`/`dy` are the range the samples cover, `dy` only for a two-axis plot.
        ("d", Some(json_range(view.samples.x()))),
        ("dy", Some(json_opt_range(view.samples.y()))),
        // Whether the plot has iterators to re-sample. A plot the canvas cannot draw is not
        // registered at all, so for a registered plot this is the only condition.
        (
            "s",
            Some(call.is_some_and(|call| !call.sites.is_empty()).to_string()),
        ),
        (
            "dn",
            Some(call.is_some_and(|call| call.densify).to_string()),
        ),
        ("scene", scene.map(|scene| scene.to_string())),
    ])
}

/// One optional range as JSON: the range, or `null` for a plot that has none of that axis.
/// The key stays present, so a client reads one shape for every plot.
fn json_opt_range(range: Option<(f64, f64)>) -> String {
    range.map(json_range).unwrap_or_else(|| "null".to_string())
}

/// What a reply that carries samples only reports: the range they cover. The picture on
/// screen, and the range it shows, are none of this reply's business - it does not replace
/// that picture, and claiming a range for it would put a range in the markup that the
/// picture does not show.
fn samples_payload(id: u64, view: &PlotView) -> String {
    json_object(&[
        ("id", Some(id.to_string())),
        ("d", Some(json_range(view.samples.x()))),
        ("dy", Some(json_opt_range(view.samples.y()))),
    ])
}

/// The reply to a request that brings a picture: the picture, the range it shows where that
/// range was drawn, and the scene. Samples travel with the evaluation that produced them (or
/// with a `plot_refine` reply). A view never re-sends them.
fn reply_picture(
    id: u64,
    view: ((f64, f64), (f64, f64)),
    svg: Option<&str>,
    scene: &str,
) -> Result<String, PlotFailure> {
    let payload = with_view(id, |entry| {
        picture_payload(id, entry, view.0, view.1, Some(scene))
    })?;
    Ok(graphics_item_with_plot(svg, Some(&payload), None))
}

/// The reply to a request that brings samples only (`plot_refine`, `plot_densify`): no
/// picture, so the labels on screen do not move while the samples are refreshed.
fn reply_samples(id: u64) -> Result<String, PlotFailure> {
    let (payload, layer) = with_view(id, |entry| (samples_payload(id, entry), layer_of(entry)))?;
    Ok(graphics_item_with_plot(None, Some(&payload), Some(&layer)))
}

/// Evaluates the registered plot's call with its iterators bound to `padded_range(view, pad)`.
/// Nothing is stored here: the caller decides whether the result is the new picture (a
/// view), the new samples (a re-sample), or both. `logs` is the entry's axes, which the
/// caller has read once: the same pad rule and the same measurement read the same entry.
fn evaluate_at(
    id: u64,
    view: ((f64, f64), (f64, f64)),
    pad: f64,
    logs: (bool, bool),
) -> Result<Expr, PlotFailure> {
    let call = with_view(id, |entry| entry.call.clone())?;
    let Some(call) = call else {
        return Err(PlotFailure::Unsupported);
    };
    if call.sites.is_empty() {
        // A fixed parameter domain: there is nothing to rewrite, only more points to
        // draw, which is a different request (`plot_densify`).
        return Err(PlotFailure::Unsupported);
    }
    let mut path = Vec::new();
    let rewritten = rewrite_sampling(&call.expr, view, &call.sites, &mut path, pad, logs);
    woxi::evaluator::evaluate_expr_to_expr(&rewritten).map_err(|_| PlotFailure::Failed)
}

/// Samples a registered plot again over the visible range. This is what adds points
/// outside the range the picture was created with (panning away, or zooming out) and
/// finer detail inside it. No picture comes back: the canvas draws the new samples on
/// the picture already on screen.
pub(crate) fn render_refine(
    id: u64,
    view: ((f64, f64), (f64, f64)),
    pad: f64,
) -> Result<String, PlotFailure> {
    let (logs, two_axis) = with_view(id, |entry| (log_axes(entry), entry.samples.mirrored()))?;
    let view = drawable_view(view, logs);
    // A two-axis re-sample evaluates the call over an area, so its margin is capped lower. A
    // wider one would multiply the work. The clamp also protects against a bad request.
    let pad = pad.clamp(
        0.0,
        if two_axis {
            TWO_AXIS_MAX_REFINE_PAD
        } else {
            MAX_REFINE_PAD
        },
    );
    resample(id, view, pad, logs)?;
    reply_samples(id)
}

/// Runs the plot call again with its iterators bound to `padded_range(view, pad)` and keeps
/// the samples it produced. With a pad of zero that picture is the view. With a pad it is
/// only good for its samples, so it is never the picture sent back.
fn resample(
    id: u64,
    view: ((f64, f64), (f64, f64)),
    pad: f64,
    logs: (bool, bool),
) -> Result<(), PlotFailure> {
    let mut rendered = evaluate_at(id, view, pad, logs)?;
    let contour = with_view(id, |entry| entry.contour)?;
    if contour {
        repair_graphic_source(&mut rendered);
    }
    if !has_svg(&rendered) {
        return Err(PlotFailure::Failed);
    }
    // The range the plot now samples is the padded iterator, not what the graphic reports:
    // Woxi's plot source keeps the `PlotRange` it was drawn with, while the extra room
    // sampled around it is what the next pan uses before another re-sample is needed.
    let sampled = (
        padded_range(view.0, pad, logs.0),
        padded_range(view.1, pad, logs.1),
    );
    let rendered = without_svg(rendered);
    with_view(id, |entry| {
        entry.graphic = rendered;
        entry.samples = entry.samples.with_coverage(sampled.0, sampled.1);
    })
}

/// Draws a plot that samples a fixed parameter domain with more points. Returns the
/// samples only: the shape of the picture does not change, so its labels are still right
/// and the canvas just draws the curve with more detail.
pub(crate) fn render_densify(id: u64, level: u32) -> Result<String, PlotFailure> {
    let call = with_view(id, |entry| entry.call.clone().filter(|call| call.densify))?
        .ok_or(PlotFailure::Unsupported)?;

    let denser = woxi::evaluator::evaluate_expr_to_expr(&with_plot_points(
        &call.expr,
        densify_points(level),
    ))
    .map_err(|_| PlotFailure::Failed)?;
    if !has_svg(&denser) {
        return Err(PlotFailure::Failed);
    }
    // The denser graphic serves later re-renders. The call stays as the user wrote it, so
    // a later level samples from the original again. The picture on screen does not move.
    let denser = without_svg(denser);
    with_view(id, |entry| entry.graphic = denser)?;
    reply_samples(id)
}

/// One request, one reply. This is the whole plot-interaction channel.
pub(crate) fn plot_request(json: &str) -> String {
    let msg_type = json_field_text(json, "msg_type").unwrap_or_default();
    match msg_type.as_str() {
        "plot_view" | "plot_refine" | "plot_densify" => {
            let Some(id) = json_handle(json) else {
                return reply_error(&msg_type, "BadRequest", "a handle is required");
            };
            // One request, one use: `with_view` reads the entry several times below, and
            // the cap is about what was asked for, not about how many reads it took.
            touch(id);
            let result = match msg_type.as_str() {
                // A denser drawing of the same domain needs no range: the picture it serves
                // is the one on screen, and that one does not move.
                "plot_densify" => {
                    let level = json_field_number(json, "level").unwrap_or(1.0).max(1.0) as u32;
                    render_densify(id, level)
                }
                _ => match json_view(json) {
                    Some(view) if msg_type == "plot_refine" => {
                        let pad = json_field_number(json, "pad").unwrap_or(SAMPLE_PAD);
                        render_refine(id, view, pad)
                    }
                    Some(view) => render_view(
                        id,
                        view,
                        json_field_number(json, "aspect"),
                        json_field_bool_opt(json, "picture").unwrap_or(true),
                    ),
                    None => {
                        return reply_error(&msg_type, "BadRequest", "x and y ranges are required");
                    }
                },
            };
            match result {
                Ok(item) => reply_ok(&msg_type, &item),
                Err(failure) => reply_error(&msg_type, failure.ename(), failure.evalue()),
            }
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

#[cfg(test)]
mod tests {
    use super::drawable_view;

    #[test]
    fn a_log_axis_is_never_asked_for_a_range_through_zero() {
        // Woxi answers such a range with an axis-less picture (measured: 762 B, one
        // polyline, no ticks, labels or frame), so the low bound is moved below the high
        // one instead of being passed on.
        let clamped = drawable_view(((-2.0, 5.0), (0.0, 258.0)), (true, true));
        assert!(clamped.0 .0 > 0.0 && clamped.0 .0 < 5.0, "{clamped:?}");
        assert!(clamped.1 .0 > 0.0 && clamped.1 .0 < 258.0, "{clamped:?}");
        assert_eq!(clamped.0 .1, 5.0);
        assert_eq!(clamped.1 .1, 258.0);
        // A valid range and a linear axis are left exactly as they came.
        let valid = ((0.001, 5.0), (0.001, 258.0));
        assert_eq!(drawable_view(valid, (true, true)), valid);
        let linear = ((-2.0, 5.0), (0.0, 258.0));
        assert_eq!(drawable_view(linear, (false, false)), linear);
    }
}
