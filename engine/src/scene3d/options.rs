//! Option parsing and policy for the 3D scene extractor.

use woxi::syntax::Expr;

use super::number;
use crate::json::json_number;

pub(super) type AxisRange = Option<(f64, f64)>;

#[derive(Clone, Copy)]
enum MeshValue {
    Off,
    Auto,
    Custom,
}

pub(super) struct ParsedOptions {
    pub plot_range: Option<[AxisRange; 3]>,
    pub card: Option<Card>,
    pub box_ratios_scene: Option<[f64; 3]>,
    pub box_ratios_source: Option<[f64; 3]>,
    pub box_ratios_automatic: bool,
    pub boxed: Option<bool>,
    pub axes: Option<bool>,
    pub camera_az: Option<f64>,
    pub camera_el: Option<f64>,
    pub view_point_finite: bool,
    pub orthographic: bool,
    pub mesh_disabled: bool,
    pub mesh_custom: bool,
    pub mesh_style_none: bool,
    pub boundary_off: bool,
}

#[derive(Default)]
struct SourceOptions {
    plot_range: Option<[AxisRange; 3]>,
    card: Option<Card>,
    box_ratios: Option<[f64; 3]>,
    box_ratios_automatic: bool,
    camera_az: Option<f64>,
    camera_el: Option<f64>,
    view_point_finite: bool,
    view_projection_seen: bool,
    orthographic: bool,
    view_point_infinity: bool,
    mesh_seen: bool,
    mesh: Option<MeshValue>,
    mesh_style_seen: bool,
    mesh_style_none: bool,
    boundary_seen: bool,
    boundary_off: bool,
}

#[derive(Default)]
struct SceneOptions {
    plot_range_seen: bool,
    plot_range: Option<[AxisRange; 3]>,
    box_ratios_seen: bool,
    box_ratios: Option<[f64; 3]>,
    box_ratios_automatic: bool,
    boxed: Option<bool>,
    axes: Option<bool>,
    camera_az: Option<f64>,
    camera_el: Option<f64>,
    view_point_finite: bool,
    view_projection_seen: bool,
    orthographic: bool,
    mesh: Option<MeshValue>,
    mesh_style_none: bool,
    boundary_off: bool,
}

/// Parse the source and structure option lists once. The policy and the
/// extractor consume the same values, so a numeric expression is evaluated
/// once and source/structure precedence is defined in one place.
pub(super) fn parse_options(
    head: &str,
    source: &[&Expr],
    scene: &[&Expr],
) -> Option<ParsedOptions> {
    let mut source_options = SourceOptions::default();
    for option in source {
        parse_source_option(head, option, &mut source_options)?;
    }
    let mut scene_options = SceneOptions::default();
    for option in scene {
        parse_scene_option(head, option, &mut scene_options);
    }

    let plot_range = if scene_options.plot_range_seen {
        scene_options.plot_range
    } else {
        source_options.plot_range
    };
    let mesh = if source_options.mesh_seen {
        source_options.mesh
    } else {
        scene_options.mesh
    };
    let mesh_style_none = if source_options.mesh_style_seen {
        source_options.mesh_style_none
    } else {
        scene_options.mesh_style_none
    };
    let boundary_off = if source_options.boundary_seen {
        source_options.boundary_off
    } else {
        scene_options.boundary_off
    };
    let box_ratios_automatic = if scene_options.box_ratios_seen {
        scene_options.box_ratios_automatic
    } else {
        source_options.box_ratios_automatic
    };
    let camera_az = source_options.camera_az.or(scene_options.camera_az);
    let camera_el = source_options.camera_el.or(scene_options.camera_el);
    let orthographic = if source_options.view_projection_seen {
        source_options.orthographic
    } else {
        scene_options.orthographic
    } || source_options.view_point_infinity;

    Some(ParsedOptions {
        plot_range,
        card: source_options.card,
        box_ratios_scene: scene_options.box_ratios,
        box_ratios_source: source_options.box_ratios,
        box_ratios_automatic,
        boxed: scene_options.boxed,
        axes: scene_options.axes,
        camera_az,
        camera_el,
        view_point_finite: source_options.view_point_finite || scene_options.view_point_finite,
        orthographic,
        mesh_disabled: matches!(mesh, Some(MeshValue::Off)),
        mesh_custom: matches!(mesh, Some(MeshValue::Custom)),
        mesh_style_none,
        boundary_off,
    })
}

fn range_noop(value: &Expr) -> bool {
    matches!(value, Expr::Identifier(name) if matches!(name.as_str(), "All" | "Automatic" | "Full"))
}

fn vector_value(value: &Expr) -> Option<[f64; 3]> {
    let Expr::List(items) = value else {
        return None;
    };
    if items.len() != 3 {
        return None;
    }
    Some([
        numeric(items.get(0)?)?,
        numeric(items.get(1)?)?,
        numeric(items.get(2)?)?,
    ])
}

fn mesh_value(value: &Expr, source: bool, head: &str) -> Option<MeshValue> {
    match value {
        Expr::Identifier(name) if name == "None" => Some(MeshValue::Off),
        // Woxi's mesh parser falls back to the default for `False` and for a
        // negative count. Neither turns the mesh off.
        Expr::Identifier(name) if name == "False" => Some(MeshValue::Auto),
        Expr::Identifier(name) if name == "Automatic" => Some(MeshValue::Auto),
        Expr::Integer(n) if *n < 0 => Some(MeshValue::Auto),
        Expr::Integer(_) if !source || head == "ParametricPlot3D" => Some(MeshValue::Custom),
        Expr::Identifier(name) if name == "All" && !source => Some(MeshValue::Custom),
        _ => None,
    }
}

fn parse_source_option(head: &str, option: &Expr, out: &mut SourceOptions) -> Option<()> {
    let Expr::Rule {
        pattern,
        replacement,
    } = option
    else {
        return None;
    };
    let name = identifier(pattern)?;
    if automatic(replacement) {
        if !automatic_allowed(name) {
            return None;
        }
        match name {
            "PlotRange" => out.plot_range = None,
            "BoxRatios" => {
                out.box_ratios = None;
                out.box_ratios_automatic = true;
            }
            "ImageSize" => out.card = Some(Card::default()),
            "Mesh" => {
                out.mesh_seen = true;
                out.mesh = Some(MeshValue::Auto);
            }
            "MeshStyle" => {
                out.mesh_style_seen = true;
                out.mesh_style_none = false;
            }
            "BoundaryStyle" => {
                out.boundary_seen = true;
                out.boundary_off = false;
            }
            "ViewProjection" => {
                out.view_projection_seen = true;
                out.orthographic = false;
            }
            _ => {}
        }
        return Some(());
    }

    match name {
        "PlotStyle" => {
            if head == "ContourPlot3D" || !style_supported(replacement) {
                return None;
            }
        }
        "PlotRange" => {
            if range_noop(replacement) {
                out.plot_range = None;
            } else {
                out.plot_range = Some(plot_range_value(head, replacement)?);
            }
        }
        "PlotPoints" | "MaxRecursion" => {}
        "MeshShading" => {
            // Woxi keeps MeshShading colours only in the standalone SVG, not
            // in the GraphicsComplex this scene walks. Until the extractor can
            // carry them, a custom shading must stay a static SVG instead of
            // silently becoming the default palette.
            if head != "ParametricPlot3D" || !no_op(replacement) {
                return None;
            }
        }
        "Boxed" => match replacement.as_ref() {
            Expr::Identifier(value) if value == "True" => {}
            Expr::Identifier(value) if value == "False" && head != "ListPlot3D" => {}
            _ => return None,
        },
        "Mesh" => {
            let value = mesh_value(replacement, true, head)?;
            out.mesh_seen = true;
            out.mesh = Some(value);
        }
        "MeshStyle" => {
            if !empty(replacement) {
                return None;
            }
            out.mesh_style_seen = true;
            out.mesh_style_none =
                matches!(replacement.as_ref(), Expr::Identifier(value) if value == "None");
        }
        "BoundaryStyle" => {
            if !empty(replacement) {
                return None;
            }
            out.boundary_seen = true;
            out.boundary_off =
                matches!(replacement.as_ref(), Expr::Identifier(value) if value == "None");
        }
        "Axes" => match replacement.as_ref() {
            Expr::Identifier(value) if value == "True" => {}
            Expr::Identifier(value) if value == "False" && head == "SphericalPlot3D" => {}
            _ => return None,
        },
        "ColorFunction" | "ColorFunctionScaling" => {
            if !no_op(replacement)
                && !matches!(
                    head,
                    "Plot3D" | "ParametricPlot3D" | "SphericalPlot3D" | "ListPlot3D"
                )
            {
                return None;
            }
        }
        "Contours" => {
            if head != "ContourPlot3D" {
                return None;
            }
        }
        "ContourStyle" => {
            if head != "ContourPlot3D" || !style_supported(replacement) {
                return None;
            }
        }
        "BoxRatios" => {
            if !matches!(head, "ParametricPlot3D" | "SphericalPlot3D") {
                return None;
            }
            out.box_ratios_automatic = false;
            out.box_ratios = Some(vector_value(replacement)?);
        }
        "ImageSize" => out.card = Some(card_value(replacement)?),
        "ViewPoint" => {
            if let Some((azimuth, elevation)) = view_direction(replacement) {
                out.camera_az = Some(azimuth);
                out.camera_el = Some(elevation);
                out.view_point_infinity = true;
            } else {
                let point = vector_value(replacement)?;
                out.camera_az = Some(point[1].atan2(point[0]));
                out.camera_el = Some(point[2].atan2(point[0].hypot(point[1])));
                out.view_point_finite = true;
            }
        }
        "ViewProjection" => match replacement.as_ref() {
            Expr::String(value) if value == "Orthographic" => {
                out.view_projection_seen = true;
                out.orthographic = true;
            }
            Expr::String(value) if value == "Perspective" => {
                out.view_projection_seen = true;
                out.orthographic = false;
            }
            _ => return None,
        },
        "Filling" | "AxesLabel" | "PlotLabel" | "PlotLegends" | "PlotLabels" | "Epilog"
        | "Prolog" => {
            if !empty(replacement) {
                return None;
            }
        }
        _ => return None,
    }
    Some(())
}

fn parse_scene_option(head: &str, option: &Expr, out: &mut SceneOptions) {
    let Expr::Rule {
        pattern,
        replacement,
    } = option
    else {
        return;
    };
    let Some(name) = identifier(pattern) else {
        return;
    };
    match name {
        "PlotRange" => {
            out.plot_range_seen = true;
            if range_noop(replacement) {
                out.plot_range = None;
            } else {
                out.plot_range = plot_range_value(head, replacement);
            }
        }
        "BoxRatios" => {
            out.box_ratios_seen = true;
            out.box_ratios_automatic = automatic(replacement);
            out.box_ratios = vector_value(replacement);
        }
        "Boxed" => {
            out.boxed = match replacement.as_ref() {
                Expr::Identifier(value) if value == "True" => Some(true),
                Expr::Identifier(value) if value == "False" => Some(false),
                _ => None,
            };
        }
        "Axes" => {
            out.axes = match replacement.as_ref() {
                Expr::Identifier(value) if value == "True" => Some(true),
                Expr::Identifier(value) if value == "False" => Some(false),
                _ => None,
            };
        }
        "ViewPoint" => {
            if let Some((azimuth, elevation)) = view_direction(replacement) {
                out.camera_az = Some(azimuth);
                out.camera_el = Some(elevation);
                out.orthographic = true;
            } else if let Some(point) = vector_value(replacement) {
                out.camera_az = Some(point[1].atan2(point[0]));
                out.camera_el = Some(point[2].atan2(point[0].hypot(point[1])));
                out.view_point_finite = true;
            }
        }
        "ViewProjection" => match replacement.as_ref() {
            Expr::String(value) if value == "Orthographic" => {
                out.view_projection_seen = true;
                out.orthographic = true;
            }
            Expr::String(value) if value == "Perspective" => {
                out.view_projection_seen = true;
                out.orthographic = false;
            }
            _ => {}
        },
        "Mesh" => out.mesh = mesh_value(replacement, false, ""),
        "MeshStyle" => {
            out.mesh_style_none =
                matches!(replacement.as_ref(), Expr::Identifier(value) if value == "None");
        }
        "BoundaryStyle" => {
            out.boundary_off =
                matches!(replacement.as_ref(), Expr::Identifier(value) if value == "None");
        }
        _ => {}
    }
}

pub(super) fn numeric(expr: &Expr) -> Option<f64> {
    if let Some(value) = number(Some(expr)) {
        return Some(value);
    }
    let n = Expr::FunctionCall {
        name: "N".to_string(),
        args: vec![expr.clone()].into(),
    };
    let value = woxi::evaluator::evaluate_expr_to_expr(&n).ok()?;
    number(Some(&value))
}

/// The sign of an infinity expression, matching Woxi's `ViewPoint` forms:
/// `Infinity`, `-Infinity`, and `DirectedInfinity[±1]`.
fn infinity_sign(expr: &Expr) -> Option<f64> {
    match expr {
        Expr::Identifier(name) if name == "Infinity" => Some(1.0),
        Expr::UnaryOp {
            op: woxi::syntax::UnaryOperator::Minus,
            operand,
        } => infinity_sign(operand).map(|sign| -sign),
        Expr::FunctionCall { name, args } if name == "DirectedInfinity" => {
            Some(match args.first() {
                Some(Expr::Integer(value)) if *value < 0 => -1.0,
                _ => 1.0,
            })
        }
        _ => None,
    }
}

/// A `ViewPoint` with an infinite component looks from infinitely far away.
/// Woxi uses the signs of the infinite components for the direction and
/// ignores the finite ones. `{0, 0, Infinity}` is the top view.
fn view_direction(value: &Expr) -> Option<(f64, f64)> {
    let Expr::List(items) = value else {
        return None;
    };
    if items.len() != 3 {
        return None;
    }
    let mut direction = [0.0; 3];
    let mut any_infinite = false;
    for (axis, item) in items.iter().enumerate() {
        if let Some(sign) = infinity_sign(item) {
            direction[axis] = sign;
            any_infinite = true;
        } else {
            numeric(item)?;
        }
    }
    if !any_infinite {
        return None;
    }
    let azimuth = direction[1].atan2(direction[0]);
    let elevation = direction[2].atan2(direction[0].hypot(direction[1]));
    Some((azimuth, elevation))
}

fn pair(value: &Expr) -> Option<(f64, f64)> {
    let Expr::List(items) = value else {
        return None;
    };
    if items.len() != 2 {
        return None;
    }
    let low = numeric(items.get(0)?)?;
    let high = numeric(items.get(1)?)?;
    (low.is_finite() && high.is_finite() && high > low).then_some((low, high))
}

fn axis_ranges(value: &Expr) -> Option<[Option<(f64, f64)>; 3]> {
    let Expr::List(items) = value else {
        return None;
    };
    if items.len() != 3 {
        return None;
    }
    Some(
        [
            pair(items.get(0)?)?,
            pair(items.get(1)?)?,
            pair(items.get(2)?)?,
        ]
        .map(Some),
    )
}

fn is_height_field(head: &str) -> bool {
    matches!(head, "Plot3D" | "ListPlot3D")
}

pub(super) fn plot_range_value(head: &str, value: &Expr) -> Option<[AxisRange; 3]> {
    if let Some(ranges) = axis_ranges(value) {
        return matches!(head, "Plot3D" | "ParametricPlot3D" | "SphericalPlot3D").then_some(ranges);
    }
    if is_height_field(head) || head == "SphericalPlot3D" {
        if let Some((low, high)) = pair(value) {
            return Some([None, None, Some((low, high))]);
        }
    }
    // A bare radius is only a range where the head delegates to `Graphics3D`.
    // Plot3D, ListPlot3D and ParametricPlot3D ignore it in Woxi.
    if head == "SphericalPlot3D" {
        if let Some(radius) = numeric(value) {
            if radius.is_finite() && radius > 0.0 {
                return Some([Some((-radius, radius)); 3]);
            }
        }
    }
    None
}

#[derive(Clone, Copy, Default)]
pub(super) struct Card {
    width: Option<f64>,
    height: Option<f64>,
    full: bool,
}

const DEFAULT_CARD_SIDE: f64 = 360.0;
const CARD_TINY: f64 = 100.0;
const CARD_SMALL: f64 = 180.0;
const CARD_LARGE: f64 = 576.0;

fn positive(value: &Expr) -> Option<f64> {
    let value = numeric(value)?;
    (value.is_finite() && value > 0.0).then_some(value)
}

/// One `ImageSize` dimension: `None` means `Automatic`, `Some` a fixed or
/// capped size. Woxi's list form accepts `UpTo[n]` in either slot.
fn card_dimension(value: &Expr) -> Option<Option<f64>> {
    match value {
        Expr::Identifier(name) if name == "Automatic" => Some(None),
        Expr::FunctionCall { name, args } if name == "UpTo" && args.len() == 1 => {
            card_dimension(&args[0])
        }
        other => Some(Some(positive(other)?)),
    }
}

fn card_range(value: &Expr) -> Option<(f64, f64)> {
    let Expr::List(items) = value else {
        return None;
    };
    if items.len() != 2 {
        return None;
    }
    let low = numeric(items.get(0)?)?;
    let high = numeric(items.get(1)?)?;
    (low.is_finite() && high.is_finite() && low > 0.0 && high >= low).then_some((low, high))
}

pub(super) fn card_value(value: &Expr) -> Option<Card> {
    // Woxi evaluates an arithmetic ImageSize once before reading it. This
    // is also what makes `2 {300, 200}` a 600x400 card.
    let evaluated = match value {
        Expr::BinaryOp { .. } | Expr::FunctionCall { .. } => {
            woxi::evaluator::evaluate_expr_to_expr(value).ok()
        }
        _ => None,
    };
    let value = evaluated.as_ref().unwrap_or(value);
    match value {
        Expr::Identifier(name) if name == "Automatic" => Some(Card::default()),
        Expr::Identifier(name) if name == "Full" => Some(Card {
            full: true,
            ..Card::default()
        }),
        Expr::Identifier(name) if name == "Tiny" => Some(Card {
            width: Some(CARD_TINY),
            ..Card::default()
        }),
        Expr::Identifier(name) if name == "Small" => Some(Card {
            width: Some(CARD_SMALL),
            ..Card::default()
        }),
        Expr::Identifier(name) if name == "Medium" => Some(Card {
            width: Some(DEFAULT_CARD_SIDE),
            ..Card::default()
        }),
        Expr::Identifier(name) if name == "Large" => Some(Card {
            width: Some(CARD_LARGE),
            ..Card::default()
        }),
        Expr::FunctionCall { name, args } if name == "UpTo" && args.len() == 1 => {
            card_value(&args[0])
        }
        Expr::List(items) if items.len() == 1 => match items.first()? {
            // Woxi accepts a named size wrapped in a one-element list, but
            // `{Automatic}` is not a size.
            Expr::Identifier(name) if name == "Automatic" => None,
            item => card_value(item),
        },
        Expr::List(items)
            if items.len() == 2
                && items
                    .iter()
                    .all(|item| matches!(item, Expr::List(range) if range.len() == 2)) =>
        {
            let width_range = card_range(items.get(0)?)?;
            let height_range = card_range(items.get(1)?)?;
            let mut width = DEFAULT_CARD_SIDE.clamp(width_range.0, width_range.1);
            let height = width.clamp(height_range.0, height_range.1);
            if (height - width).abs() > 0.5 {
                width = height.clamp(width_range.0, width_range.1);
            }
            Some(Card {
                width: Some(width.round()),
                height: Some(height.round()),
                full: false,
            })
        }
        Expr::List(items) if items.len() == 2 => {
            let width = card_dimension(items.get(0)?)?;
            let height = card_dimension(items.get(1)?)?;
            match (width, height) {
                (None, None) => Some(Card {
                    width: Some(DEFAULT_CARD_SIDE),
                    height: Some(DEFAULT_CARD_SIDE),
                    full: false,
                }),
                (None, Some(height)) => Some(Card {
                    width: Some(height),
                    height: Some(height),
                    full: false,
                }),
                (Some(width), None) => Some(Card {
                    width: Some(width),
                    height: Some(width),
                    full: false,
                }),
                (Some(width), Some(height)) => Some(Card {
                    width: Some(width),
                    height: Some(height),
                    full: false,
                }),
            }
        }
        other => Some(Card {
            width: Some(positive(other)?),
            ..Card::default()
        }),
    }
}

pub(super) fn card_json(card: Card) -> String {
    let width = card
        .width
        .map(json_number)
        .unwrap_or_else(|| "null".to_string());
    let height = card
        .height
        .map(json_number)
        .unwrap_or_else(|| "null".to_string());
    format!(
        "{{\"width\":{width},\"height\":{height},\"full\":{}}}",
        card.full
    )
}

pub(super) fn collect_options<'a>(expr: &'a Expr, out: &mut Vec<&'a Expr>) {
    match expr {
        Expr::Rule { .. } | Expr::RuleDelayed { .. } => out.push(expr),
        Expr::List(items) => {
            for item in items {
                collect_options(item, out);
            }
        }
        _ => {}
    }
}

const SCENE_HEADS: &[&str] = &[
    "Plot3D",
    "ListPlot3D",
    "ParametricPlot3D",
    "ContourPlot3D",
    "RegionPlot3D",
    "SphericalPlot3D",
];

fn is_scene_head(name: &str) -> bool {
    SCENE_HEADS.contains(&name)
}

pub(super) fn call_of(statement: &str) -> Option<Expr> {
    let last = crate::eval::split_semicolons(statement)
        .into_iter()
        .rev()
        .find(|part| !part.trim().is_empty())?;
    woxi::syntax::string_to_expr(last.trim()).ok()
}

pub(super) fn call_options(call: &Expr) -> Option<(&str, Vec<&Expr>)> {
    let Expr::FunctionCall { name, args } = call else {
        return None;
    };
    let head = name.as_str();
    if !is_scene_head(head) {
        return None;
    }
    let mut options = Vec::new();
    for option in &args[1..] {
        collect_options(option, &mut options);
    }
    Some((head, options))
}

fn call_iterator(call: &Expr, index: usize) -> Option<(f64, f64)> {
    let Expr::FunctionCall { args, .. } = call else {
        return None;
    };
    let Expr::List(items) = args.get(index)? else {
        return None;
    };
    if items.len() != 3 {
        return None;
    }
    let low = numeric(items.get(1)?)?;
    let high = numeric(items.get(2)?)?;
    (low.is_finite() && high.is_finite() && high > low).then_some((low, high))
}

pub(super) fn source_view(head: &str, call: &Expr, coverage: [(f64, f64); 3]) -> [(f64, f64); 3] {
    let iterator = |index| call_iterator(call, index);
    match head {
        "Plot3D" => [
            iterator(1).unwrap_or(coverage[0]),
            iterator(2).unwrap_or(coverage[1]),
            coverage[2],
        ],
        "ContourPlot3D" | "RegionPlot3D" => [
            iterator(1).unwrap_or(coverage[0]),
            iterator(2).unwrap_or(coverage[1]),
            iterator(3).unwrap_or(coverage[2]),
        ],
        _ => coverage,
    }
}

const BOX_SPAN_FLOOR: f64 = 1e-9;

fn spans(values: [(f64, f64); 3]) -> [f64; 3] {
    [
        (values[0].1 - values[0].0).max(BOX_SPAN_FLOOR),
        (values[1].1 - values[1].0).max(BOX_SPAN_FLOOR),
        (values[2].1 - values[2].0).max(BOX_SPAN_FLOOR),
    ]
}

fn data_box_ratios(values: [(f64, f64); 3]) -> [f64; 3] {
    let spans = spans(values);
    let longest = spans.iter().copied().fold(0.0_f64, f64::max);
    if !longest.is_finite() || longest <= 0.0 {
        DEFAULT_BOX_RATIOS
    } else {
        [spans[0] / longest, spans[1] / longest, spans[2] / longest]
    }
}

const DEFAULT_Z_SCALE: f64 = 0.4;
const DEFAULT_BOX_RATIOS: [f64; 3] = [1.0, 1.0, DEFAULT_Z_SCALE];
const CUBE_BOX_RATIOS: [f64; 3] = [1.0, 1.0, 1.0];

/// The box each plot head uses when the caller does not name `BoxRatios`.
/// Woxi's structure carries the head's default, so prefer that when it is
/// present. `ParametricPlot3D` and `SphericalPlot3D` shape their box like the
/// effective view (including an explicit `PlotRange`), not like the raw sample
/// coverage. ListPlot3D has no structure default. Its standalone picture uses
/// the flattened Plot3D box. The RegionPlot3D fallback also flattens z, but
/// the signed-field path (the common case) carries a cube in its structure.
pub(super) fn default_box_ratios(
    head: &str,
    scene_ratios: Option<[f64; 3]>,
    explicit: Option<[f64; 3]>,
    automatic: bool,
    ranges: [(f64, f64); 3],
) -> [f64; 3] {
    if let Some(ratios) = explicit {
        return ratios;
    }
    if automatic && matches!(head, "ParametricPlot3D" | "SphericalPlot3D") {
        return data_box_ratios(ranges);
    }
    if let Some(ratios) = scene_ratios {
        return ratios;
    }
    match head {
        "Plot3D" | "ListPlot3D" | "RegionPlot3D" => DEFAULT_BOX_RATIOS,
        "ContourPlot3D" => CUBE_BOX_RATIOS,
        _ => data_box_ratios(ranges),
    }
}

fn identifier(expr: &Expr) -> Option<&str> {
    match expr {
        Expr::Identifier(name) => Some(name),
        _ => None,
    }
}

fn style_supported(expr: &Expr) -> bool {
    match expr {
        Expr::Identifier(name) => !matches!(
            name.as_str(),
            "Thick" | "Thin" | "Dashed" | "Dotted" | "DotDashed" | "AbsoluteThickness"
        ),
        Expr::FunctionCall { name, args } => match name.as_str() {
            "RGBColor" => args.len() == 3 && args.iter().all(|arg| numeric(arg).is_some()),
            "GrayLevel" | "Opacity" => {
                args.len() == 1 && args.first().is_some_and(|arg| numeric(arg).is_some())
            }
            "Directive" | "Style" => args.iter().all(style_supported),
            "Specularity" | "Glow" | "Lighting" | "Thickness" | "AbsoluteThickness" | "Dashing"
            | "AbsoluteDashing" | "Hue" => false,
            _ => false,
        },
        Expr::List(items) => items.iter().all(style_supported),
        _ => false,
    }
}

fn no_op(expr: &Expr) -> bool {
    match expr {
        Expr::Identifier(name) => matches!(name.as_str(), "None" | "Automatic"),
        Expr::List(items) => items.is_empty(),
        _ => false,
    }
}

pub(super) fn automatic(expr: &Expr) -> bool {
    matches!(expr, Expr::Identifier(name) if name == "Automatic")
}

/// `Automatic` is only a no-op for options whose Woxi default this scene
/// models. Unknown option names must not pass merely because their value is
/// `Automatic`. That made every future Woxi option silently enter a scene.
fn automatic_allowed(name: &str) -> bool {
    matches!(
        name,
        "Axes"
            | "AxesEdge"
            | "AxesOrigin"
            | "Background"
            | "BoundaryStyle"
            | "BoxRatios"
            | "Boxed"
            | "ColorFunction"
            | "ColorFunctionScaling"
            | "Contours"
            | "ContourStyle"
            | "Epilog"
            | "FaceGrids"
            | "FaceGridsStyle"
            | "Filling"
            | "ImageSize"
            | "Lighting"
            | "MaxRecursion"
            | "Mesh"
            | "MeshShading"
            | "MeshStyle"
            | "PlotPoints"
            | "PlotRange"
            | "PlotStyle"
            | "PlotTheme"
            | "Prolog"
            | "SphericalRegion"
            | "TextureCoordinateFunction"
            | "Ticks"
            | "ViewAngle"
            | "ViewCenter"
            | "ViewPoint"
            | "ViewProjection"
            | "ViewVector"
            | "ViewVertical"
    )
}

fn empty(expr: &Expr) -> bool {
    match expr {
        Expr::Identifier(name) => matches!(name.as_str(), "None" | "False"),
        Expr::List(items) => items.is_empty(),
        _ => false,
    }
}
