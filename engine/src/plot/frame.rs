//! One picture and one reply: where its range sits in the picture's own user units, and
//! the samples the canvas draws, as the single payload the frontend receives.

use crate::json::{json_array, json_number, json_object, json_range};
use woxi::syntax::{Expr, SeriesFilling};

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

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// The client quantizes and inverts the same grid, so the divisor is part of the protocol.
const U16_MAX: f64 = 65535.0;

fn push_base64(out: &mut String, bytes: &[u8]) {
    out.reserve(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(*chunk.get(1).unwrap_or(&0));
        let b2 = u32::from(*chunk.get(2).unwrap_or(&0));
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(BASE64[(triple >> 18) as usize & 63] as char);
        out.push(BASE64[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            BASE64[(triple >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64[triple as usize & 63] as char
        } else {
            '='
        });
    }
}

fn hex(color: (u8, u8, u8)) -> String {
    format!("#{:02X}{:02X}{:02X}", color.0, color.1, color.2)
}

/// A 16-bit position on a shared grid over the drawing range. The frontend inverts
/// it to a data value, so a point costs four bytes instead of a JSON number.
fn quantize(value: f64, range: (f64, f64)) -> u16 {
    let span = range.1 - range.0;
    if !span.is_finite() || span <= 0.0 {
        return 0;
    }
    (((value - range.0) / span) * U16_MAX).round() as u16
}

/// The shape the canvas draws for a marker, and whether it is filled. The glyph set is Woxi's
/// `automatic_marker_shape` (`functions/plot.rs`): filled `●■◆▲▼`, outlined `○□◇△▽`.
/// `PlotMarker::open` alone is not enough: `PlotMarkers -> Automatic` reports `open: false` for
/// every glyph, including the outlined ones. The third value is the glyph's half-extent at Woxi's
/// default size, in the units of its 360-unit reference canvas.
fn marker_shape(marker: &woxi::syntax::PlotMarker) -> Option<(&'static str, bool, f64)> {
    Some(match marker.glyph.as_str() {
        "●" => ("circle", true, 3.49),
        "○" => ("circle", false, 3.41),
        "■" => ("square", true, 3.32),
        "□" => ("square", false, 3.41),
        "◆" => ("diamond", true, 4.41),
        "◇" => ("diamond", false, 4.22),
        "▲" => ("up", true, 4.99),
        "△" => ("up", false, 4.99),
        "▼" => ("down", true, 5.05),
        "▽" => ("down", false, 5.05),
        _ => return None,
    })
}

/// Marker radius as a fraction of the image width. Woxi's `automatic_marker_shape` scales a
/// glyph's outline by `k = 0.35 * (size - 1) / 3.49` for an explicit size, and by 1 for the
/// default. The renderer's reference canvas is 360 units wide (`RESOLUTION_SCALE = 10` on a
/// 36-unit plot area), which is the divisor here. A scatter without a marker keeps Woxi's
/// 2.3 px default dot.
const DEFAULT_DOT_RADIUS: f64 = 2.3 / 360.0;
const MARKER_REFERENCE_WIDTH: f64 = 360.0;

fn marker_radius(marker: Option<&woxi::syntax::PlotMarker>, scatter: bool) -> f64 {
    match marker {
        Some(marker) => {
            let Some((_, _, extent)) = marker_shape(marker) else {
                return 0.0;
            };
            let k = if marker.size > 0.0 {
                0.35 * (marker.size - 1.0) / 3.49
            } else {
                1.0
            };
            (extent * k / MARKER_REFERENCE_WIDTH).max(0.0)
        }
        None if scatter => DEFAULT_DOT_RADIUS,
        None => 0.0,
    }
}

/// Can the canvas layer reproduce these series at all? What a series is, not the values it
/// holds: point labels, mesh marks, inset-graphic markers, a fill toward another series. A
/// point's value is not part of it - on a logarithmic axis a non-positive point is a refusal
/// at this range, and a re-sample over another range lifts it, so it must not stop the
/// re-samples that would (whether one can help is the captured iterator sites', reported as
/// `s` by `picture_payload`).
fn layer_shaped(source: &woxi::syntax::PlotSource) -> bool {
    source.series.iter().all(|series| {
        series.labels.iter().all(|label| label.is_none())
            && series.mesh_full_points.is_empty()
            && series.marker.as_ref().is_none_or(|marker| {
                marker.automatic && marker.graphics.is_none() && marker_shape(marker).is_some()
            })
            && match series.filling {
                SeriesFilling::Series(_) => false,
                SeriesFilling::Axis => !source.log_y,
                // A positive value has a drawing-space position on a log axis. A non-positive
                // one has none, and `filling_json` refuses it too.
                SeriesFilling::Value(value) => !source.log_y || value > 0.0,
                _ => true,
            }
    })
}

/// Can the canvas reproduce these series as they are drawn at this range? Everything it
/// cannot draw asks for the SVG frames instead, because a missing detail is worse than a
/// slower frame: the shape above, and on a logarithmic axis a point that has no position on
/// the grid at all.
pub(crate) fn layer_drawable(source: &woxi::syntax::PlotSource) -> bool {
    layer_shaped(source)
        && (!source.log_x
            || source
                .series
                .iter()
                .all(|series| series.points.iter().all(|(x, _)| *x > 0.0)))
        && (!source.log_y
            || source
                .series
                .iter()
                .all(|series| series.points.iter().all(|(_, y)| *y > 0.0)))
}

fn filling_json(
    series: &woxi::syntax::PlotSeriesData,
    source: &woxi::syntax::PlotSource,
) -> Option<String> {
    // The fill's reference level. `Axis` is zero. `Value` is the user's value in the drawing
    // space. `Bottom`/`Top` are the *render's* y low/high. Woxi recomputes the last two from the
    // range it draws (`reference_y(y_min, y_max)`), so the payload carries the kind and the
    // client resolves it against the view it is drawing: a frozen value would leave the fill
    // short of the frame edge after a pan. A log axis has no drawing-space value at or below
    // zero, but a positive `Value` is drawable, and so are the range's own low/high.
    let (kind, value) = match series.filling {
        SeriesFilling::None | SeriesFilling::Series(_) => return None,
        SeriesFilling::Axis => ("axis", None),
        SeriesFilling::Bottom => ("bottom", None),
        SeriesFilling::Top => ("top", None),
        SeriesFilling::Value(value) => ("value", Some(value)),
    };
    let value = match value {
        Some(value) if !value.is_finite() => return None,
        Some(value) if source.log_y => {
            if value <= 0.0 {
                return None;
            }
            Some(value.log10())
        }
        other => other,
    };
    let mut fields: Vec<(&str, Option<String>)> = vec![("k", Some(format!("\"{kind}\"")))];
    if let Some(value) = value {
        fields.push(("v", Some(json_number(value))));
    }
    fields.push((
        "c",
        Some(format!(
            "\"{}\"",
            hex(series.fill_color.unwrap_or(series.color))
        )),
    ));
    // Woxi's filled scatter stems default to 0.3 opacity, a filled curve's area to 0.2.
    let default_opacity = if series.is_scatter { 0.3 } else { 0.2 };
    fields.push((
        "o",
        Some(json_number(series.fill_opacity.unwrap_or(default_opacity))),
    ));
    Some(json_object(&fields))
}

/// The payload's data space, mapped to the renderer's drawing space: the logarithm of a
/// coordinate on a log axis, and the y correction a two-axis plot needs, because it
/// reports its points mirrored about the range it sampled. One place, so the extent the
/// grid is measured from and the points that are quantized against it always agree.
struct Draw {
    log_x: bool,
    log_y: bool,
    /// `y_min + y_max` for a two-axis plot, `None` to leave y alone.
    mirror: Option<f64>,
}

impl Draw {
    fn new(source: &woxi::syntax::PlotSource, two_axis: bool) -> Self {
        Draw {
            log_x: source.log_x,
            log_y: source.log_y,
            mirror: two_axis.then_some(source.y_range.0 + source.y_range.1),
        }
    }

    fn point(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        let y = self.mirror.map_or(y, |sum| sum - y);
        let dx = if self.log_x { x.log10() } else { x };
        let dy = if self.log_y { y.log10() } else { y };
        (dx.is_finite() && dy.is_finite()).then_some((dx, dy))
    }
}

fn series_layer_json(
    series: &woxi::syntax::PlotSeriesData,
    grid: ((f64, f64), (f64, f64)),
    draw: &Draw,
    image: f64,
    source: &woxi::syntax::PlotSource,
) -> String {
    let mut raw = Vec::with_capacity(series.points.len() * 4);
    for &(x, y) in &series.points {
        let Some((dx, dy)) = draw.point(x, y) else {
            continue;
        };
        raw.extend_from_slice(&quantize(dx, grid.0).to_le_bytes());
        raw.extend_from_slice(&quantize(dy, grid.1).to_le_bytes());
    }

    let mut base64 = String::with_capacity(raw.len().div_ceil(3) * 4);
    push_base64(&mut base64, &raw);
    let opacity = series.opacity.unwrap_or(1.0).clamp(0.0, 1.0);
    let dashing = series.dashing.as_ref().map(|dashing| {
        json_array(dashing.iter().map(|length| {
            // Woxi's encoding: negative is absolute pixels, positive is a fraction of
            // the image width.
            let fraction = if *length < 0.0 {
                -*length / image
            } else {
                *length
            };
            json_number(fraction)
        }))
    });
    let marker = series.marker.as_ref();
    let shape = marker.and_then(marker_shape);
    let radius = marker_radius(marker, series.is_scatter);
    json_object(&[
        ("c", Some(format!("\"{}\"", hex(series.color)))),
        (
            "w",
            Some(json_number(series.thickness.unwrap_or(2.0) / image)),
        ),
        ("o", (opacity < 1.0).then(|| json_number(opacity))),
        ("da", dashing),
        ("f", filling_json(series, source)),
        ("sc", series.is_scatter.then(|| "true".to_string())),
        ("m", shape.map(|(kind, _, _)| format!("\"{kind}\""))),
        (
            "mo",
            shape
                .is_some_and(|(_, filled, _)| !filled)
                .then(|| "true".to_string()),
        ),
        ("mr", (radius > 0.0).then(|| json_number(radius))),
        ("p", Some(format!("\"{base64}\""))),
    ])
}

/// The refusal for a plot whose samples the canvas cannot draw, with the axes this plot draws its
/// logarithms on. They travel even in a refusal: the gesture maths works in decades on those axes
/// whether or not a canvas is drawing, so the client has to know them from the picture.
fn refusal_flags(log_x: bool, log_y: bool) -> String {
    format!("{{\"ok\":false,\"lx\":{log_x},\"ly\":{log_y}}}")
}
/// The extent of every series point in the space the payload sends them in, after the two-axis
/// mirror and the logarithms: `[x_min, y_min, x_max, y_max]`. One measurement, because the grid
/// the points are quantized against (`plot_layer`) and the data rectangle the client maps
/// through (`picture_mapping`) have to be the same rectangle or the curve lands where the
/// picture did not draw it.
fn point_extent(source: &woxi::syntax::PlotSource, draw: &Draw) -> Option<[f64; 4]> {
    let mut extent = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    for series in &source.series {
        for &(x, y) in &series.points {
            let Some((dx, dy)) = draw.point(x, y) else {
                continue;
            };
            extent[0] = extent[0].min(dx);
            extent[1] = extent[1].min(dy);
            extent[2] = extent[2].max(dx);
            extent[3] = extent[3].max(dy);
        }
    }
    (!extent.iter().any(|value| !value.is_finite())).then_some(extent)
}

/// The series of a rendered plot as the canvas needs them: points on a shared 16-bit
/// grid over the drawing range, plus color, width, dashing, opacity, filling and
/// markers. `two_axis` says the points are in the producer's mirrored y space, which this
/// undoes before they are sent.
///
/// `{"ok":false,"lx":..,"ly":..}` when there is nothing to draw: no plot source at all, a
/// graphic with no series (`RegionPlot`, user `Graphics[...]`), or series the canvas cannot
/// reproduce. The client reads one payload shape either way.
///
/// The grid is measured after the two-axis y correction, or the corrected points would
/// fall outside it, and it is in the renderer's drawing space - plain data coordinates,
/// or their logarithm on a log axis - so the frontend can invert a point without knowing
/// the axis type.
pub(crate) fn plot_layer(graphic: &Expr, two_axis: bool) -> String {
    let Some(source) = plot_source(graphic) else {
        return refusal_flags(false, false);
    };
    if source.series.is_empty() || !layer_drawable(source) {
        return refusal_flags(source.log_x, source.log_y);
    }
    let draw = Draw::new(source, two_axis);
    let Some(extent) = point_extent(source, &draw) else {
        return refusal_flags(source.log_x, source.log_y);
    };
    // A flat range still draws (a horizontal line). The grid needs a span to divide
    // by, and every point then lands on the same position.
    let grid = |lo: f64, hi: f64| if hi > lo { (lo, hi) } else { (lo, lo + 1.0) };
    let grid = (grid(extent[0], extent[2]), grid(extent[1], extent[3]));
    let image = f64::from(source.image_size.0.max(1));
    let series: Vec<String> = source
        .series
        .iter()
        .map(|entry| series_layer_json(entry, grid, &draw, image, source))
        .collect();
    json_object(&[
        ("x", Some(json_range(grid.0))),
        ("y", Some(json_range(grid.1))),
        ("lx", Some(source.log_x.to_string())),
        ("ly", Some(source.log_y.to_string())),
        ("ok", Some("true".to_string())),
        ("s", Some(json_array(series))),
    ])
}

/// The picture's own data-to-user mapping, `user = a * data + b` per axis, measured from
/// the curves' extents. Woxi's field layout puts the frame outside the data (each side
/// lies `PlotRangePadding` of the span beyond it), so the frame rectangle is not the data
/// area and a client mapping the data range onto it draws everything a few percent too
/// large. The curves are the data area: the payload carries their points in data
/// coordinates, the SVG carries the same curves in user units, and the two extents give
/// the mapping. Extents rather than point pairs because the renderer thins a polyline
/// (187 points for 189 samples on one contour), which would break a one-to-one fit.
///
/// Only a two-axis picture is drawn at its own range. A one-axis picture is a `Show` crop
/// of an older graphic: the renderer draws the axes at the requested range and clips the
/// curve to them, so the frame is the data area there and the client needs no `u`.
///
/// The mapping is in plain data coordinates, which is what the client divides the range's
/// span by. A log axis would need the payload's grid to convert back, and no two-axis plot
/// Woxi draws has one (checked, not assumed).
///
/// The points are the ones `plot_layer` sends, mirror undone, so the rect and the samples
/// cannot disagree about the mirror.
fn picture_mapping(source: &woxi::syntax::PlotSource, svg: &str) -> Option<[f64; 4]> {
    if source.log_x || source.log_y {
        return None;
    }
    // Data units: the extent of the points the payload carries, in the space `plot_layer`
    // sends them in.
    let data = point_extent(source, &Draw::new(source, true))?;
    let user = polyline_extent(svg)?;
    let span = |lo: f64, hi: f64| hi - lo;
    if span(data[0], data[2]) <= 0.0 || span(data[1], data[3]) <= 0.0 {
        return None;
    }
    if span(user[0], user[2]) <= 0.0 || span(user[1], user[3]) <= 0.0 {
        return None;
    }
    let ax = span(user[0], user[2]) / span(data[0], data[2]);
    let bx = user[0] - ax * data[0];
    // The picture's y axis grows downward (it is an SVG), so the smallest data y is the
    // largest user y. That is what gives the sign of the y mapping. The extents alone
    // cannot.
    let ay = span(user[1], user[3]) / -span(data[1], data[3]);
    let by = user[3] - ay * data[1];
    if !ax.is_finite() || !ay.is_finite() || ax.abs() < f64::EPSILON {
        return None;
    }
    Some([ax, bx, ay, by])
}

/// The extent of the polylines a picture draws, in its own user units. A curve is a
/// polyline: the frame, the axes and the ticks are lines and rectangles, so they cannot be
/// mistaken for one. A polyline with a malformed pair refuses the whole picture: skipping it
/// could leave a decorative polyline as the extent, which would draw every point a few percent
/// off without saying so. A polyline with no `points` attribute draws nothing and is skipped.
fn polyline_extent(svg: &str) -> Option<[f64; 4]> {
    let mut user = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    let mut seen = false;
    for part in svg.split("<polyline").skip(1) {
        let tag = part.split('>').next()?;
        let Some(points) = tag
            .split("points=\"")
            .nth(1)
            .and_then(|points| points.split('"').next())
        else {
            continue;
        };
        for pair in points.split_whitespace() {
            let mut parts = pair.split(',');
            let (Some(x), Some(y)) = (parts.next(), parts.next()) else {
                return None;
            };
            let x = x.trim().parse::<f64>().ok()?;
            let y = y.trim().parse::<f64>().ok()?;
            user[0] = user[0].min(x);
            user[1] = user[1].min(y);
            user[2] = user[2].max(x);
            user[3] = user[3].max(y);
            seen = true;
        }
    }
    seen.then_some(user)
}

/// Where `view` sits in the picture's own user units, when the picture is the evaluation
/// at that range. In the order of the range (`u[1]` belongs to `y.min`), not sorted: the y
/// axis of an SVG grows downward, so a picture's smallest user y is its largest data y.
pub(super) fn picture_rect(
    source: &woxi::syntax::PlotSource,
    svg: &str,
    view: ((f64, f64), (f64, f64)),
) -> Option<[f64; 4]> {
    let [ax, bx, ay, by] = picture_mapping(source, svg)?;
    Some([
        ax * view.0 .0 + bx,
        ay * view.1 .0 + by,
        ax * view.0 .1 + bx,
        ay * view.1 .1 + by,
    ])
}

#[cfg(test)]
mod tests {
    use super::{polyline_extent, U16_MAX};

    /// The values the client mirrors. `tests/fixtures/protocol.json` is read here and by
    /// `tests/plot-props.test.js`, so the two languages cannot drift apart silently: a constant
    /// changed on one side fails a test on the other. The wire is the contract.
    #[test]
    fn the_protocol_constants_match_the_fixture_the_client_reads() {
        const FIXTURE: &str = include_str!("../../../tests/fixtures/protocol.json");
        let number = |key: &str| {
            crate::json::json_field_number(FIXTURE, key).expect("a number in the fixture")
        };
        assert_eq!(
            number("log_fallback_decades"),
            crate::plot::handle::LOG_FALLBACK_DECADES
        );
        assert_eq!(number("u16_max"), U16_MAX);
        assert_eq!(number("sample_pad"), crate::plot::sample::SAMPLE_PAD);
        assert_eq!(
            number("max_refine_pad"),
            crate::plot::handle::MAX_REFINE_PAD
        );
        assert_eq!(
            number("two_axis_max_refine_pad"),
            crate::plot::handle::TWO_AXIS_MAX_REFINE_PAD
        );
        assert_eq!(
            number("densify_max_level"),
            f64::from(crate::plot::sample::DENSIFY_MAX_LEVEL)
        );
    }

    #[test]
    fn an_automatic_marker_keeps_its_filled_and_outlined_shapes() {
        use super::{marker_radius, marker_shape};
        use woxi::syntax::PlotMarker;
        let marker = |glyph: &str, size: f64| PlotMarker {
            glyph: glyph.to_string(),
            size,
            color: None,
            open: false,
            automatic: true,
            graphics: None,
        };
        // `PlotMarkers -> Automatic` reports `open: false` for every glyph. The glyph itself says
        // whether the shape is filled (`plot.rs`, `automatic_marker_shape`).
        let (kind, filled, extent) = marker_shape(&marker("○", 0.0)).expect("outline circle");
        assert_eq!(kind, "circle");
        assert!(!filled);
        assert_eq!(extent, 3.41);
        assert!(marker_shape(&marker("●", 0.0)).expect("filled circle").1);
        assert!(!marker_shape(&marker("□", 0.0)).expect("outline square").1);
        // Woxi's explicit size: k = 0.35 * (size - 1) / 3.49, so a size-12 circle's radius is
        // 3.49 * k = 3.85 units on the 360-unit reference canvas.
        let at12 = marker_radius(Some(&marker("●", 12.0)), false);
        assert!((at12 - 3.85 / 360.0).abs() < 1e-12, "{at12}");
        let outline = marker_radius(Some(&marker("○", 0.0)), false);
        assert!((outline - 3.41 / 360.0).abs() < 1e-12, "{outline}");
        assert_eq!(marker_radius(None, false), 0.0);
        assert!((marker_radius(None, true) - 2.3 / 360.0).abs() < 1e-12);
    }

    #[test]
    fn a_malformed_polyline_refuses_the_mapping() {
        // A missing pair would leave a decorative polyline as the extent: every point then lands
        // a few percent off, silently. A polyline with no points draws nothing and is skipped.
        let svg = "<svg><polyline fill=\"none\"/><polyline points=\"10,20 30,40\"/></svg>";
        let extent = polyline_extent(svg).expect("extent");
        assert_eq!(extent, [10.0, 20.0, 30.0, 40.0]);
        assert!(polyline_extent("<svg><polyline/></svg>").is_none());
        assert!(polyline_extent("<svg><polyline points=\"bad,pair 50,60\"/></svg>").is_none());
    }
}
