//! A 3D picture as a compact client scene.
//!
//! Woxi's 3D renderer paints everything into an SVG. For interaction the frontend needs
//! the same picture without the SVG: the indexed (or literal) points, polygon cells and
//! mesh lines of the symbolic `Graphics3D` structure Woxi already keeps, plus the camera,
//! the current `PlotRange`, the sampled coverage and the card size. Points and lines stay
//! in data units so the client can pan and zoom the view inside a fixed box without
//! re-uploading the mesh. This module extracts that form once, for the plot heads that
//! emit a `GraphicsComplex`. A picture with a primitive this module cannot express is
//! left to the SVG renderer (the caller gets `None`), so there is only one interaction
//! path and unsupported pictures stay still.

use std::collections::HashMap;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use woxi::syntax::Expr;

use crate::json::{json_array, json_number, json_object, json_range};

mod options;

use options::{
    call_of, call_options, card_json, collect_options, default_box_ratios, parse_options,
    source_view,
};

/// Woxi's default `ViewPoint`. The camera distance of a box of side 2 is
/// twice the norm of this vector.
const DEFAULT_VIEW_POINT: [f64; 3] = [1.3, -2.4, 2.0];
/// The default camera of a 3D plot (`Camera::default`).
const DEFAULT_AZIMUTH: f64 = -1.07;
const DEFAULT_ELEVATION: f64 = 0.63;
/// Woxi's `Camera::for_box` normalizes the box to this full side before
/// scaling the camera distance by the longest ratio.
const BOX_SIDE: f64 = 2.0;
const MIN_RANGE_SPAN: f64 = 1e-12;
const DEGENERATE_RANGE_PAD: f64 = 0.5;
const DEFAULT_COLOR: [u8; 3] = SURFACE_COLORS[0];
const DEFAULT_LINE_COLOR: [u8; 3] = [0, 0, 0];
/// Woxi's default `Mesh` count for a parameter grid (`plot3d.rs`, 15).
const PARAMETRIC_MESH_LEVELS: usize = 15;
/// Woxi writes the default parameter mesh with `Opacity[0.63]`.
const MESH_OPACITY: f64 = 0.63;
/// `Graphics3D`'s automatic display region pads each side by 2%.
const SPHERICAL_PADDING: f64 = 0.02;
/// Woxi's `theme_surface` colors, quantized to 8-bit channels.
const SURFACE_COLORS: [[u8; 3]; 10] = [
    [225, 156, 36],
    [94, 129, 181],
    [143, 176, 50],
    [235, 98, 53],
    [147, 130, 217],
    [197, 110, 26],
    [0, 153, 153],
    [230, 92, 174],
    [143, 179, 0],
    [230, 138, 0],
];

#[derive(Clone, Copy)]
struct Theme {
    background: &'static str,
    axis: [u8; 3],
    label: [u8; 3],
}

fn theme() -> Theme {
    if woxi::is_dark_mode() {
        Theme {
            background: "#1a1a1a",
            axis: [153, 153, 153],
            label: [153, 153, 153],
        }
    } else {
        Theme {
            background: "#ffffff",
            axis: [102, 102, 102],
            label: [102, 102, 102],
        }
    }
}

fn theme_json(theme: Theme) -> String {
    json_object(&[
        ("background", Some(format!("\"{}\"", theme.background))),
        (
            "axis",
            Some(json_array(
                theme
                    .axis
                    .iter()
                    .map(|value| json_number(f64::from(*value))),
            )),
        ),
        (
            "label",
            Some(json_array(
                theme
                    .label
                    .iter()
                    .map(|value| json_number(f64::from(*value))),
            )),
        ),
    ])
}

#[derive(Clone, Copy)]
struct Style {
    color: Option<[u8; 3]>,
    opacity: f64,
}

impl Default for Style {
    fn default() -> Self {
        Style {
            color: None,
            opacity: 1.0,
        }
    }
}

struct Extract {
    points: Vec<[f64; 3]>,
    faces: Vec<[u32; 3]>,
    colors: Vec<[u8; 4]>,
    lines: Vec<[f64; 3]>,
    line_colors: Vec<[u8; 4]>,
    style: Style,
    /// The first index of the `GraphicsComplex` being walked (1-based Woxi indices).
    base: usize,
    surface_index: usize,
    /// Parametric mesh reconstruction and the Plot3D default boundary need
    /// the indexed quad grid. Other heads do not.
    collect_grids: bool,
    grids: Vec<SurfaceGrid>,
}

struct SurfaceGrid {
    base: usize,
    points: usize,
    quads: Vec<[u32; 4]>,
}

impl Extract {
    fn new(collect_grids: bool) -> Self {
        Extract {
            points: Vec::new(),
            faces: Vec::new(),
            colors: Vec::new(),
            lines: Vec::new(),
            line_colors: Vec::new(),
            style: Style::default(),
            base: 0,
            surface_index: 0,
            collect_grids,
            grids: Vec::new(),
        }
    }

    fn complex(&mut self, args: &[Expr]) -> bool {
        let [points, primitives, options @ ..] = args else {
            return false;
        };
        if !complex_options(options) {
            return false;
        }
        let Expr::List(points) = points else {
            return false;
        };
        let outer_base = self.base;
        let outer_style = self.style;
        if self.style.color.is_none() {
            self.style.color = Some(SURFACE_COLORS[self.surface_index % SURFACE_COLORS.len()]);
        }
        self.surface_index += 1;
        let base = self.points.len();
        self.base = base;
        for point in points {
            let Some(value) = point3(point) else {
                self.base = outer_base;
                self.style = outer_style;
                return false;
            };
            self.points.push(value);
        }
        if self.collect_grids {
            self.grids.push(SurfaceGrid {
                base,
                points: self.points.len() - base,
                quads: Vec::new(),
            });
        }
        let ok = self.walk(primitives);
        self.base = outer_base;
        self.style = outer_style;
        ok
    }

    fn walk(&mut self, expr: &Expr) -> bool {
        match expr {
            Expr::List(items) => {
                // A list that wraps exactly one primitive is a per-face style group
                // (`{Opacity[...], RGBColor[...], Polygon[...]}`). Its directives must
                // not leak onto the cells after it.
                let face_count = items.iter().filter(|item| is_face(item)).count();
                let saved = self.style;
                for item in items {
                    if !self.walk(item) {
                        return false;
                    }
                }
                if face_count == 1 {
                    self.style = saved;
                }
                true
            }
            Expr::Rule { pattern, .. } | Expr::RuleDelayed { pattern, .. } => !visual_rule(pattern),
            Expr::FunctionCall { name, args } => match name.as_str() {
                "GraphicsComplex" => self.complex(args),
                "Polygon" => self.polygon(args),
                "Line" => self.line(args),
                "RGBColor" => {
                    if let Some(color) = rgb(args) {
                        self.style.color = Some(color);
                    }
                    true
                }
                "GrayLevel" => {
                    if let Some(gray) = number(args.first()) {
                        let value = (gray.clamp(0.0, 1.0) * 255.0).round() as u8;
                        self.style.color = Some([value; 3]);
                    }
                    true
                }
                "Opacity" => {
                    if let Some(value) = number(args.first()) {
                        self.style.opacity = value.clamp(0.0, 1.0);
                    }
                    true
                }
                "Directive" => args.iter().all(|arg| self.walk(arg)),
                "Style" => {
                    let Some((content, directives)) = args.split_first() else {
                        return false;
                    };
                    let saved = self.style;
                    for directive in directives {
                        if !self.walk(directive) {
                            return false;
                        }
                    }
                    let ok = self.walk(content);
                    self.style = saved;
                    ok
                }
                "EdgeForm" => edge_form_noop(args),
                // The client recomputes normals from the mesh, so the
                // structure's normals are redundant rather than ignored
                // shading data.
                "VertexNormals" => true,
                // The surface structures carry default specularity and line
                // thickness directives. The client uses a fixed two-sided
                // light and fixed line widths, so these defaults are known
                // approximations rather than additional colours to carry.
                "Specularity" | "AbsoluteThickness" => true,
                // These directives change what the picture looks like and
                // have no representation in the scene payload. Refuse the
                // picture instead of silently drawing a different surface.
                "Lighting" | "Glow" | "Thickness" | "Dashing" | "AbsoluteDashing"
                | "VertexColors" | "Texture" | "CapForm" | "JoinForm" => false,
                _ => false,
            },
            _ => false,
        }
    }

    fn polygon(&mut self, args: &[Expr]) -> bool {
        let Some(arg) = args.first() else {
            return false;
        };
        let Expr::List(items) = arg else {
            return false;
        };
        if items.iter().all(is_index) {
            return self.cell(items);
        }
        if items.iter().all(|item| matches!(item, Expr::List(_))) {
            if items.iter().all(|item| match item {
                Expr::List(cell) => cell_indices(cell),
                _ => false,
            }) {
                return items.iter().all(|item| match item {
                    Expr::List(cell) => self.cell(cell),
                    _ => false,
                });
            }
            if items.iter().all(|item| point3(item).is_some()) {
                return self.literal_cell(items);
            }
            if items.iter().all(|item| match item {
                Expr::List(points) => points.iter().all(|point| point3(point).is_some()),
                _ => false,
            }) {
                return items.iter().all(|item| match item {
                    Expr::List(points) => self.literal_cell(points),
                    _ => false,
                });
            }
        }
        false
    }

    fn cell(&mut self, items: &[Expr]) -> bool {
        let indices: Vec<u32> = items.iter().filter_map(index).collect();
        if indices.len() != items.len() || indices.len() < 3 {
            return false;
        }
        let available = self.points.len();
        if indices
            .iter()
            .any(|index| self.base + *index as usize > available)
        {
            return false;
        }
        let alpha = (self.style.opacity.clamp(0.0, 1.0) * 255.0).round() as u8;
        let [red, green, blue] = self.style.color.unwrap_or(DEFAULT_COLOR);
        let color = [red, green, blue, alpha];
        let base = self.base as u32;
        let at = |index: u32| base + index - 1;
        if let [a, b, c, d] = indices.as_slice() {
            if let Some(grid) = self.grids.last_mut() {
                grid.quads.push([*a - 1, *b - 1, *c - 1, *d - 1]);
            }
            // Woxi's standalone surface renderers split a quad on the b-d
            // diagonal. A fan from a would use the other diagonal and change
            // the silhouette and shading of a coarse surface.
            self.faces.push([at(*a), at(*b), at(*d)]);
            self.colors.push(color);
            self.faces.push([at(*c), at(*d), at(*b)]);
            self.colors.push(color);
        } else {
            for pair in indices[1..].windows(2) {
                self.faces.push([at(indices[0]), at(pair[0]), at(pair[1])]);
                self.colors.push(color);
            }
        }
        true
    }

    fn literal_cell(&mut self, items: &[Expr]) -> bool {
        let points: Vec<[f64; 3]> = items.iter().filter_map(point3).collect();
        if points.len() != items.len() || points.len() < 3 {
            return false;
        }
        let start = self.points.len() as u32;
        self.points.extend(points);
        let alpha = (self.style.opacity.clamp(0.0, 1.0) * 255.0).round() as u8;
        let [red, green, blue] = self.style.color.unwrap_or(DEFAULT_COLOR);
        let color = [red, green, blue, alpha];
        let first_face = self.faces.len();
        if items.len() == 4 {
            // Match the standalone surface renderer's b-d diagonal.
            self.faces.push([start, start + 1, start + 3]);
            self.faces.push([start + 2, start + 3, start + 1]);
        } else {
            for index in 1..items.len() as u32 - 1 {
                self.faces.push([start, start + index, start + index + 1]);
            }
        }
        self.colors
            .extend(std::iter::repeat_n(color, self.faces.len() - first_face));
        true
    }

    fn line(&mut self, args: &[Expr]) -> bool {
        let Some(arg) = args.first() else {
            return false;
        };
        let Expr::List(items) = arg else {
            return false;
        };
        let style = self.style;
        if items.iter().all(is_index) {
            self.polyline(items, style)
        } else if items.iter().all(|item| point3(item).is_some()) {
            self.literal_polyline(items, style)
        } else if items.iter().all(|item| matches!(item, Expr::List(_))) {
            if items.iter().all(|item| match item {
                Expr::List(points) => points.iter().all(is_index),
                _ => false,
            }) {
                items.iter().all(|item| match item {
                    Expr::List(points) => self.polyline(points, style),
                    _ => false,
                })
            } else if items.iter().all(|item| match item {
                Expr::List(points) => points.iter().all(|point| point3(point).is_some()),
                _ => false,
            }) {
                items.iter().all(|item| match item {
                    Expr::List(points) => self.literal_polyline(points, style),
                    _ => false,
                })
            } else {
                false
            }
        } else {
            false
        }
    }

    fn push_line(&mut self, a: [f64; 3], b: [f64; 3], style: Style) {
        let alpha = (style.opacity.clamp(0.0, 1.0) * 255.0).round() as u8;
        let [red, green, blue] = style.color.unwrap_or(DEFAULT_LINE_COLOR);
        let color = [red, green, blue, alpha];
        self.lines.push(a);
        self.lines.push(b);
        self.line_colors.push(color);
        self.line_colors.push(color);
    }

    fn literal_polyline(&mut self, items: &[Expr], style: Style) -> bool {
        let points: Vec<[f64; 3]> = items.iter().filter_map(point3).collect();
        if points.len() != items.len() || points.len() < 2 {
            return false;
        }
        for pair in points.windows(2) {
            self.push_line(pair[0], pair[1], style);
        }
        true
    }

    fn polyline(&mut self, items: &[Expr], style: Style) -> bool {
        let indices: Vec<u32> = items.iter().filter_map(index).collect();
        if indices.len() != items.len() {
            return false;
        }
        let available = self.points.len();
        if indices
            .iter()
            .any(|index| self.base + *index as usize > available)
        {
            return false;
        }
        for pair in indices.windows(2) {
            let a = self.points[self.base + pair[0] as usize - 1];
            let b = self.points[self.base + pair[1] as usize - 1];
            self.push_line(a, b, style);
        }
        true
    }

    /// ParametricPlot3D's symbolic structure omits its default mesh lines.
    /// Reconstruct Woxi's 15 interior levels (17 lines including edges) from
    /// the indexed quad grid. The structure carries the same samples the
    /// standalone SVG uses.
    fn add_parametric_mesh(&mut self, levels: usize) -> bool {
        let mut lines = Vec::new();
        for grid in &self.grids {
            let Some(first) = grid.quads.first() else {
                return false;
            };
            let Some(stride) = first[1].checked_sub(first[0]) else {
                return false;
            };
            if stride < 2
                || first[3] != first[0] + 1
                || first[2] != first[1] + 1
                || grid.points == 0
            {
                return false;
            }
            let Some(max_local) = grid.quads.iter().flat_map(|quad| quad.iter()).max() else {
                return false;
            };
            let rows = max_local / stride;
            let cols = stride - 1;
            if rows == 0
                || grid.quads.len() != rows as usize * cols as usize
                || grid.points < (rows as usize + 1) * stride as usize
            {
                // A grid with undefined samples leaves cells out of the
                // structure. The inferred grid is then incomplete, so its
                // default mesh cannot be reconstructed faithfully.
                return false;
            }
            let point = |row: u32, col: u32| -> Option<[f64; 3]> {
                let local = row as usize * stride as usize + col as usize;
                if row > rows || col > cols || local >= grid.points {
                    return None;
                }
                Some(self.points[grid.base + local])
            };
            let mut push = |a: [f64; 3], b: [f64; 3]| {
                lines.push(a);
                lines.push(b);
            };
            let lerp = |a: [f64; 3], b: [f64; 3], f: f64| {
                [
                    a[0] + (b[0] - a[0]) * f,
                    a[1] + (b[1] - a[1]) * f,
                    a[2] + (b[2] - a[2]) * f,
                ]
            };
            for m in 0..=levels + 1 {
                for axis in 0..2 {
                    let (across, along) = if axis == 0 {
                        (rows, cols)
                    } else {
                        (cols, rows)
                    };
                    if across == 0 {
                        continue;
                    }
                    let level = across as f64 * m as f64 / (levels + 1) as f64;
                    let low = (level.floor() as u32).min(across - 1);
                    let fraction = level - low as f64;
                    let at = |along: u32| -> Option<[f64; 3]> {
                        let a = if axis == 0 {
                            point(low, along)
                        } else {
                            point(along, low)
                        }?;
                        if fraction == 0.0 {
                            return Some(a);
                        }
                        let b = if axis == 0 {
                            point(low + 1, along)
                        } else {
                            point(along, low + 1)
                        }?;
                        Some(lerp(a, b, fraction))
                    };
                    for j in 0..along {
                        if let (Some(a), Some(b)) = (at(j), at(j + 1)) {
                            push(a, b);
                        }
                    }
                }
            }
        }
        if lines.is_empty() {
            return true;
        }
        let style = Style {
            color: Some(DEFAULT_LINE_COLOR),
            opacity: MESH_OPACITY,
        };
        for pair in lines.as_chunks::<2>().0 {
            self.push_line(pair[0], pair[1], style);
        }
        true
    }

    /// `Plot3D`'s default `BoundaryStyle` is not carried by the symbolic
    /// structure. Reconstruct it from the quad grid's one-use edges.
    fn add_boundary_lines(&mut self, style: Style) -> bool {
        let mut segments = Vec::new();
        for grid in &self.grids {
            let mut edges: HashMap<(u32, u32), usize> = HashMap::new();
            for quad in &grid.quads {
                for (a, b) in [
                    (quad[0], quad[1]),
                    (quad[1], quad[2]),
                    (quad[2], quad[3]),
                    (quad[3], quad[0]),
                ] {
                    let key = if a < b { (a, b) } else { (b, a) };
                    *edges.entry(key).or_default() += 1;
                }
            }
            let mut boundary: Vec<(u32, u32)> = edges
                .into_iter()
                .filter_map(|(edge, count)| (count == 1).then_some(edge))
                .collect();
            boundary.sort_unstable();
            for (a, b) in boundary {
                if a as usize >= grid.points || b as usize >= grid.points {
                    return false;
                }
                segments.push([
                    self.points[grid.base + a as usize],
                    self.points[grid.base + b as usize],
                ]);
            }
        }
        for [a, b] in segments {
            self.push_line(a, b, style);
        }
        true
    }
}

fn is_face(expr: &Expr) -> bool {
    matches!(expr, Expr::FunctionCall { name, .. } if name == "Polygon" || name == "Line")
}

fn option_name(expr: &Expr) -> Option<&str> {
    match expr {
        Expr::Identifier(name) => Some(name),
        _ => None,
    }
}

/// Options on a `GraphicsComplex` itself. `VertexNormals` is redundant (the
/// client computes normals), but any other option carries visual data this
/// extractor does not model.
fn complex_options(options: &[Expr]) -> bool {
    options.iter().all(|option| match option {
        Expr::Rule { pattern, .. } | Expr::RuleDelayed { pattern, .. } => {
            matches!(option_name(pattern), Some("VertexNormals"))
        }
        _ => false,
    })
}

fn visual_rule(expr: &Expr) -> bool {
    matches!(
        option_name(expr),
        Some("VertexColors" | "Texture" | "TextureCoordinates")
    )
}

/// `EdgeForm[]`, `EdgeForm[None]` and `EdgeForm[0]` are the no-edge forms
/// Woxi puts in a structure. Any real edge style would change the picture.
fn edge_form_noop(args: &[Expr]) -> bool {
    args.is_empty()
        || (args.len() == 1
            && (number(args.first()) == Some(0.0)
                || matches!(args.first(), Some(Expr::Identifier(name)) if name == "None" || name == "False")))
}

fn is_index(expr: &Expr) -> bool {
    matches!(expr, Expr::Integer(value) if *value >= 1)
}

fn cell_indices(items: &[Expr]) -> bool {
    items.len() >= 3
        && items
            .iter()
            .all(|item| matches!(item, Expr::Integer(value) if *value >= 1))
}

fn index(expr: &Expr) -> Option<u32> {
    match expr {
        Expr::Integer(value) if *value >= 1 && *value <= u32::MAX as i128 => Some(*value as u32),
        _ => None,
    }
}

pub(super) fn point3(expr: &Expr) -> Option<[f64; 3]> {
    let Expr::List(items) = expr else {
        return None;
    };
    if items.len() < 3 {
        return None;
    }
    Some([
        number(items.get(0))?,
        number(items.get(1))?,
        number(items.get(2))?,
    ])
}

pub(super) fn rgb(args: &[Expr]) -> Option<[u8; 3]> {
    if args.len() != 3 {
        return None;
    }
    let mut channels = [0.0; 3];
    for (channel, arg) in channels.iter_mut().zip(args) {
        *channel = number(Some(arg))?.clamp(0.0, 1.0);
    }
    Some(channels.map(|value| (value * 255.0).round() as u8))
}

pub(super) fn number(expr: Option<&Expr>) -> Option<f64> {
    match expr? {
        Expr::Integer(value) => Some(*value as f64),
        Expr::Real(value) if value.is_finite() => Some(*value),
        _ => None,
    }
}

fn range(points: &[[f64; 3]], axis: usize) -> Option<(f64, f64)> {
    let mut low = f64::INFINITY;
    let mut high = f64::NEG_INFINITY;
    for point in points {
        low = low.min(point[axis]);
        high = high.max(point[axis]);
    }
    if !low.is_finite() || !high.is_finite() {
        return None;
    }
    if high - low < MIN_RANGE_SPAN {
        Some((low - DEGENERATE_RANGE_PAD, high + DEGENERATE_RANGE_PAD))
    } else {
        Some((low, high))
    }
}

/// The client payload is f32 and the shader subtracts the f32 view low from
/// each f32 coordinate. Keep a scene static unless both the coordinates and
/// the view bounds survive that round trip relative to the visible span. An
/// offset far larger than the span otherwise produces a surface that jumps
/// inside the box. Lines are checked too: a literal line can carry a large
/// offset that the polygon vertices do not.
const F32_VIEW_TOLERANCE: f64 = 64.0 * f32::EPSILON as f64;

fn f32_faithful(points: &[[f64; 3]], lines: &[[f64; 3]], ranges: [(f64, f64); 3]) -> bool {
    for point in points.iter().chain(lines) {
        for axis in 0..3 {
            let value = point[axis];
            let converted = value as f32;
            if !converted.is_finite() {
                return false;
            }
            let span = (ranges[axis].1 - ranges[axis].0).abs().max(MIN_RANGE_SPAN);
            let tolerance = span * F32_VIEW_TOLERANCE + value.abs() * 1e-12;
            if (converted as f64 - value).abs() > tolerance {
                return false;
            }
        }
    }
    for (low, high) in ranges {
        let span = (high - low).abs().max(MIN_RANGE_SPAN);
        let tolerance = span * F32_VIEW_TOLERANCE;
        let converted_low = low as f32 as f64;
        let converted_high = high as f32 as f64;
        if !converted_low.is_finite()
            || !converted_high.is_finite()
            || (converted_low - low).abs() > tolerance
            || (converted_high - high).abs() > tolerance
        {
            return false;
        }
    }
    true
}

fn bytes_f32(values: &[[f64; 3]]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(values.len() * 12);
    for point in values {
        for value in point {
            bytes.extend_from_slice(&(*value as f32).to_le_bytes());
        }
    }
    bytes
}

fn bytes_u32(values: &[[u32; 3]]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(values.len() * 12);
    for face in values {
        for value in face {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
    }
    bytes
}

fn bytes_rgba(values: &[[u8; 4]]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for color in values {
        bytes.extend_from_slice(color);
    }
    bytes
}

/// The heads whose `Graphics3D` structure this scene understands. A wrapped picture
/// (`Show`, `Module`, `Manipulate`) is deliberately left to the SVG renderer: without
/// its direct call the option policy cannot tell which options the head honoured.
pub(crate) fn scene3d(expr: &Expr, statement: &str) -> Option<String> {
    let call = call_of(statement)?;
    let (head, source_options) = call_options(&call)?;

    let Expr::Graphics {
        is_3d: true,
        structure: Some(structure),
        ..
    } = expr
    else {
        return None;
    };
    let Expr::FunctionCall { name, args } = structure.as_ref() else {
        return None;
    };
    if name != "Graphics3D" || args.is_empty() {
        return None;
    }

    let mut scene_options = Vec::new();
    for option in &args[1..] {
        collect_options(option, &mut scene_options);
    }
    let parsed = parse_options(head, &source_options, &scene_options)?;
    if parsed.view_point_finite && !parsed.orthographic {
        // A finite ViewPoint changes the perspective camera distance. Those
        // view options are still static. It is usable as a direction for an
        // orthographic camera, where the distance does not affect the image.
        return None;
    }

    let mut extract = Extract::new(matches!(head, "ParametricPlot3D" | "Plot3D"));
    if !extract.walk(&args[0]) || extract.faces.is_empty() {
        return None;
    }

    if head == "ParametricPlot3D"
        && !parsed.mesh_disabled
        && !parsed.mesh_custom
        && !parsed.mesh_style_none
        && !extract.add_parametric_mesh(PARAMETRIC_MESH_LEVELS)
    {
        return None;
    }

    if head == "Plot3D"
        && !parsed.boundary_off
        && !extract.add_boundary_lines(Style {
            color: Some(DEFAULT_LINE_COLOR),
            opacity: 1.0,
        })
    {
        return None;
    }

    let coverage = [
        range(&extract.points, 0)?,
        range(&extract.points, 1)?,
        range(&extract.points, 2)?,
    ];

    let mut ranges = source_view(head, &call, coverage);
    let parsed_range = parsed.plot_range;
    if let Some(parsed) = parsed_range {
        if head == "Plot3D" {
            // Woxi narrows the sampled x/y domain only when both
            // intersections are non-empty. If either one misses the
            // iterator domain, it leaves both domains alone.
            if let (Some((px0, px1)), Some((py0, py1))) = (parsed[0], parsed[1]) {
                let x = (ranges[0].0.max(px0), ranges[0].1.min(px1));
                let y = (ranges[1].0.max(py0), ranges[1].1.min(py1));
                if x.1 > x.0 && y.1 > y.0 {
                    ranges[0] = x;
                    ranges[1] = y;
                }
            }
            if let Some((low, high)) = parsed[2] {
                ranges[2] = (low, high);
            }
        } else {
            for (axis, range) in parsed.iter().enumerate() {
                if let Some(range) = range {
                    ranges[axis] = *range;
                }
            }
        }
    }
    // `SphericalPlot3D` delegates to `Graphics3D`, whose automatic display
    // region pads the primitive bounds by 2% on each side. The other heads
    // render their own box without that pad. An explicit PlotRange pins the
    // region and disables the pad.
    if head == "SphericalPlot3D" && parsed_range.is_none() {
        for range in &mut ranges {
            let pad = (range.1 - range.0) * SPHERICAL_PADDING;
            range.0 -= pad;
            range.1 += pad;
        }
    }
    for range in &mut ranges {
        if range.1 - range.0 < MIN_RANGE_SPAN {
            range.0 -= DEGENERATE_RANGE_PAD;
            range.1 += DEGENERATE_RANGE_PAD;
        }
    }
    if !f32_faithful(&extract.points, &extract.lines, ranges) {
        return None;
    }

    let scene_ratios = parsed.box_ratios_scene;
    let explicit_ratios = if matches!(head, "ParametricPlot3D" | "SphericalPlot3D") {
        parsed.box_ratios_source.or(scene_ratios)
    } else {
        None
    };
    let box_ratios = default_box_ratios(
        head,
        scene_ratios,
        explicit_ratios,
        parsed.box_ratios_automatic,
        ranges,
    );
    if box_ratios
        .iter()
        .any(|value| !value.is_finite() || *value <= 0.0)
    {
        return None;
    }

    let boxed = parsed.boxed.unwrap_or(true);
    // Woxi's `Plot3D` and contour/region heads tie their axes to the box.
    // `SphericalPlot3D` keeps its default `Axes -> True` when Boxed is false,
    // and `Graphics3D` then draws the three unboxed axis lines.
    let axes_flag = parsed.axes.unwrap_or(true) && (boxed || head == "SphericalPlot3D");
    let scene_theme = theme();
    let longest = box_ratios.iter().copied().fold(0.0_f64, f64::max);
    let view_point_norm = DEFAULT_VIEW_POINT
        .iter()
        .map(|value| value * value)
        .sum::<f64>()
        .sqrt();
    let distance = BOX_SIDE * longest * view_point_norm;
    let camera = json_object(&[
        (
            "az",
            Some(json_number(parsed.camera_az.unwrap_or(DEFAULT_AZIMUTH))),
        ),
        (
            "el",
            Some(json_number(parsed.camera_el.unwrap_or(DEFAULT_ELEVATION))),
        ),
        ("dist", Some(json_number(distance))),
        ("perspective", Some((!parsed.orthographic).to_string())),
    ]);
    let ranges_json = json_array(ranges.iter().map(|range| json_range(*range)));
    let coverage_json = json_array(coverage.iter().map(|range| json_range(*range)));
    let box_json = json_array(box_ratios.iter().copied().map(json_number));
    let card_payload = card_json(parsed.card.unwrap_or_default());
    let vertices = BASE64.encode(bytes_f32(&extract.points));
    let indices = BASE64.encode(bytes_u32(&extract.faces));
    let colors = BASE64.encode(bytes_rgba(&extract.colors));
    let lines = BASE64.encode(bytes_f32(&extract.lines));
    let line_colors = BASE64.encode(bytes_rgba(&extract.line_colors));

    Some(json_object(&[
        ("camera", Some(camera)),
        ("ranges", Some(ranges_json)),
        ("box", Some(box_json)),
        ("vertices", Some(format!("\"{vertices}\""))),
        ("indices", Some(format!("\"{indices}\""))),
        ("colors", Some(format!("\"{colors}\""))),
        ("lines", Some(format!("\"{lines}\""))),
        ("lineColors", Some(format!("\"{line_colors}\""))),
        ("theme", Some(theme_json(scene_theme))),
        ("axes", Some(axes_flag.to_string())),
        ("boxed", Some(boxed.to_string())),
        ("coverage", Some(coverage_json)),
        ("card", Some(card_payload)),
    ]))
}

#[cfg(test)]
mod tests;
