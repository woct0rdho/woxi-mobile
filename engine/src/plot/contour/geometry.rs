//! Cell-space geometry and the source/SVG coordinate transform.

use woxi::syntax::PlotSource;

use super::params::{
    BOUNDARY_MARGIN_STEPS, CELL_ESTIMATE_TOLERANCE, MIN_CELL, WOXI_FIELD_GRID,
    WOXI_FIELD_RANGE_PADDING,
};

pub(super) type Point = (f64, f64);

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Bounds {
    pub(super) min_x: f64,
    pub(super) max_x: f64,
    pub(super) min_y: f64,
    pub(super) max_y: f64,
}

impl Bounds {
    pub(super) fn contains_interior(self, point: Point) -> bool {
        point.0 > self.min_x + BOUNDARY_MARGIN_STEPS
            && point.0 < self.max_x - BOUNDARY_MARGIN_STEPS
            && point.1 > self.min_y + BOUNDARY_MARGIN_STEPS
            && point.1 < self.max_y - BOUNDARY_MARGIN_STEPS
    }

    /// Woxi draws the SVG frame outside the data rectangle. The frame's
    /// fill-less rect is the outer box. Inset it by the field plot's default
    /// `PlotRangePadding` before using it as the sampled rectangle.
    fn inset(self, fraction: f64) -> Self {
        let pad_x = (self.max_x - self.min_x) * fraction;
        let pad_y = (self.max_y - self.min_y) * fraction;
        Self {
            min_x: self.min_x + pad_x,
            max_x: self.max_x - pad_x,
            min_y: self.min_y + pad_y,
            max_y: self.max_y - pad_y,
        }
    }
}

/// The coordinate transform and the sampled frame used by one cleanup group.
///
/// The graph works in cell units: one Woxi grid cell is one unit on each axis.
/// When the caller knows the frame, the source range or SVG frame supplies
/// independent x and y cell scales. Only a frame-less SVG falls back to the
/// median point spacing on both axes.
#[derive(Clone, Copy)]
pub(super) struct Grid {
    pub(super) origin: Point,
    pub(super) cell: Point,
    /// The sampled frame in cell coordinates, when the caller knows it.
    pub(super) bounds: Option<Bounds>,
}

impl Grid {
    /// The SVG frame is the outer, padded rectangle. The data rectangle is
    /// inset by Woxi's default padding. Cells are measured from the raw point
    /// steps, with one hundredth of the data rectangle as the fallback. A
    /// frame-less SVG has only point spacing to go on. That remains the median
    /// fallback.
    #[cfg(test)]
    pub(super) fn from_chains(chains: &[Vec<Point>], frame: Option<Bounds>) -> Self {
        Self::from_chains_with_cell(chains, frame, None)
    }

    pub(super) fn from_chains_with_cell(
        chains: &[Vec<Point>],
        frame: Option<Bounds>,
        measured: Option<Point>,
    ) -> Self {
        let data = frame.map(|frame| frame.inset(WOXI_FIELD_RANGE_PADDING));
        let fallback = data.map(|data| {
            (
                (data.max_x - data.min_x) / WOXI_FIELD_GRID,
                (data.max_y - data.min_y) / WOXI_FIELD_GRID,
            )
        });
        let cell = measured
            .filter(|cell| {
                cell.0.is_finite() && cell.1.is_finite() && cell.0 > MIN_CELL && cell.1 > MIN_CELL
            })
            .or_else(|| {
                fallback.map(|fallback| estimate_cell(chains.iter().map(Vec::as_slice), fallback))
            })
            .unwrap_or_else(|| {
                let step = median_step(chains);
                (step, step)
            });
        let origin = data.map_or((0.0, 0.0), |data| (data.min_x, data.min_y));
        let bounds = data.map(|data| Bounds {
            min_x: 0.0,
            max_x: (data.max_x - data.min_x) / cell.0,
            min_y: 0.0,
            max_y: (data.max_y - data.min_y) / cell.1,
        });
        Self {
            origin,
            cell,
            bounds,
        }
    }

    pub(super) fn from_source(source: &PlotSource) -> Option<Self> {
        let x0 = source.x_range.0.min(source.x_range.1);
        let x1 = source.x_range.0.max(source.x_range.1);
        let y0 = source.y_range.0.min(source.y_range.1);
        let y1 = source.y_range.0.max(source.y_range.1);
        let span = ((x1 - x0) / WOXI_FIELD_GRID, (y1 - y0) / WOXI_FIELD_GRID);
        if !span.0.is_finite() || !span.1.is_finite() || span.0 <= MIN_CELL || span.1 <= MIN_CELL {
            return None;
        }
        let points = source.series.iter().map(|series| series.points.as_slice());
        let cell = estimate_cell(points, span);
        if !cell.0.is_finite() || !cell.1.is_finite() || cell.0 <= MIN_CELL || cell.1 <= MIN_CELL {
            return None;
        }
        Some(Self {
            origin: (x0, y0),
            cell,
            bounds: Some(Bounds {
                min_x: 0.0,
                max_x: (x1 - x0) / cell.0,
                min_y: 0.0,
                max_y: (y1 - y0) / cell.1,
            }),
        })
    }

    pub(super) fn normalize(self, point: Point) -> Point {
        (
            (point.0 - self.origin.0) / self.cell.0,
            (point.1 - self.origin.1) / self.cell.1,
        )
    }

    pub(super) fn denormalize(self, point: Point) -> Point {
        (
            self.origin.0 + point.0 * self.cell.0,
            self.origin.1 + point.1 * self.cell.1,
        )
    }
}

/// The source and SVG cleanup use the same reconstruction in cell units. The
/// only difference is the coordinate transform.

#[derive(Clone, Copy)]
pub(super) struct Line {
    pub(super) origin: Point,
    pub(super) dir: Point,
}

impl Line {
    pub(super) fn angle(self) -> f64 {
        self.dir
            .1
            .atan2(self.dir.0)
            .rem_euclid(std::f64::consts::PI)
    }

    pub(super) fn offset(self, p: Point) -> f64 {
        cross((p.0 - self.origin.0, p.1 - self.origin.1), self.dir).abs()
    }
}

pub(super) fn cross(a: Point, b: Point) -> f64 {
    a.0 * b.1 - a.1 * b.0
}

pub(super) fn sub(a: Point, b: Point) -> Point {
    (a.0 - b.0, a.1 - b.1)
}

pub(super) fn dot(a: Point, b: Point) -> f64 {
    a.0 * b.0 + a.1 * b.1
}

pub(super) fn norm(p: Point) -> f64 {
    p.0.hypot(p.1)
}

pub(super) fn distance(a: Point, b: Point) -> f64 {
    norm(sub(a, b))
}

pub(super) fn angle_between(a: f64, b: f64) -> f64 {
    let d = (a - b).abs().rem_euclid(std::f64::consts::PI);
    d.min(std::f64::consts::PI - d)
}

pub(super) fn line_between(a: Point, b: Point) -> Option<Line> {
    let d = sub(b, a);
    let len = norm(d);
    if !len.is_finite() || len <= f64::EPSILON {
        return None;
    }
    Some(Line {
        origin: a,
        dir: (d.0 / len, d.1 / len),
    })
}

pub(super) fn midpoint(a: Point, b: Point) -> Point {
    ((a.0 + b.0) * 0.5, (a.1 + b.1) * 0.5)
}

/// Measure the cell from the raw marching-squares chains. A raw Woxi chain
/// contains at most one cell per segment, and it usually contains a segment
/// that spans a full cell in each direction. Taking the median of the
/// per-chain maxima keeps a repaired junction-to-arm segment (or one unrelated
/// long polyline in a `Show`) from changing the grid on a later pass. The
/// fallback is used only when a direction has no step with two points.
///
/// The result is in the caller's coordinate units. A repaired SVG stores it
/// in the root metadata before another repair. A source is measured once per
/// `repair_source` call.
fn estimate_cell<'a>(chains: impl IntoIterator<Item = &'a [Point]>, fallback: Point) -> Point {
    let mut x_steps = Vec::new();
    let mut y_steps = Vec::new();
    for chain in chains {
        let mut max_x = 0.0f64;
        let mut max_y = 0.0f64;
        for pair in chain.windows(2) {
            let dx = (pair[1].0 - pair[0].0).abs();
            let dy = (pair[1].1 - pair[0].1).abs();
            if dx.is_finite() && dx > max_x {
                max_x = dx;
            }
            if dy.is_finite() && dy > max_y {
                max_y = dy;
            }
        }
        if max_x > MIN_CELL {
            x_steps.push(max_x);
        }
        if max_y > MIN_CELL {
            y_steps.push(max_y);
        }
    }
    (
        reconcile_step(median_step_from(x_steps, fallback.0), fallback.0),
        reconcile_step(median_step_from(y_steps, fallback.1), fallback.1),
    )
}

/// Woxi's normal field grid is 100 cells. When the per-chain estimate is
/// within rounding distance of that fallback, keep the exact fallback. This
/// absorbs one-decimal SVG coordinates without hiding a genuinely finer
/// `RegionFunction` grid or a coarser `ListContourPlot` grid. A source is
/// measured once per `repair_source` call. Unlike SVG, it has no place to
/// persist the cell across calls.
fn reconcile_step(estimated: f64, fallback: f64) -> f64 {
    if !fallback.is_finite() || fallback <= MIN_CELL {
        return estimated;
    }
    let ratio = estimated / fallback;
    if (1.0 - CELL_ESTIMATE_TOLERANCE..=1.0 + CELL_ESTIMATE_TOLERANCE).contains(&ratio) {
        fallback
    } else {
        estimated
    }
}

fn median_step_from(mut steps: Vec<f64>, fallback: f64) -> f64 {
    if steps.is_empty() {
        return fallback;
    }
    steps.sort_by(|a, b| a.total_cmp(b));
    let step = steps[steps.len() / 2];
    if step.is_finite() && step > MIN_CELL {
        step
    } else {
        fallback
    }
}

pub(super) fn median_step(items: &[Vec<Point>]) -> f64 {
    let mut steps = Vec::new();
    for chain in items {
        for pair in chain.windows(2) {
            let d = distance(pair[0], pair[1]);
            if d.is_finite() && d > MIN_CELL {
                steps.push(d);
            }
        }
    }
    if steps.is_empty() {
        return 1.0;
    }
    steps.sort_by(|a, b| a.total_cmp(b));
    let step = steps[steps.len() / 2];
    if step.is_finite() && step > MIN_CELL {
        step
    } else {
        1.0
    }
}
