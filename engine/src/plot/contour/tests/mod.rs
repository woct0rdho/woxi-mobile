use woxi::syntax::{PlotSeriesData, PlotSource};

use super::geometry::*;
use super::graph::*;
use super::source::*;
use super::svg::*;

mod arm_matching;
mod fixtures;
mod graph;
mod source_svg;

pub(super) fn chain(points: &[(f64, f64)]) -> Vec<Point> {
    points.to_vec()
}

pub(super) fn input(points: &[(f64, f64)], kind: usize) -> ChainIn {
    ChainIn {
        points: chain(points),
        group: 0,
        kind,
    }
}

pub(super) fn repaired_with_grid(chains: &[ChainIn], grid: Grid) -> Vec<ChainOut> {
    repair_groups_with_grid(chains, grid)
}

pub(super) fn source_series(points: Vec<Point>) -> PlotSeriesData {
    PlotSeriesData {
        points,
        color: (61, 153, 204),
        color_expr: None,
        is_scatter: false,
        filling: woxi::syntax::SeriesFilling::None,
        fill_color: None,
        fill_opacity: None,
        marker: None,
        thickness: None,
        point_size: None,
        point_size_expr: None,
        dashing: None,
        opacity: None,
        labels: Vec::new(),
        mesh_full_points: Vec::new(),
    }
}

pub(super) fn source_from_chains(
    chains: &[ChainIn],
    x_range: (f64, f64),
    y_range: (f64, f64),
) -> PlotSource {
    PlotSource {
        series: chains
            .iter()
            .map(|chain| source_series(chain.points.clone()))
            .collect(),
        x_range,
        y_range,
        image_size: (1000, 1000),
        options: Vec::new(),
        log_x: false,
        log_y: false,
        plot_range: None,
        data_x_range: None,
    }
}

/// Two U hooks, one opening right and one opening left: the raw Woxi
/// `Sin[x] == Cos[y]` crossing before reconstruction.
pub(super) fn boxed_crossing() -> Vec<ChainIn> {
    let lower = [
        (1.0, -0.5),
        (1.2, -0.4),
        (1.4, -0.3),
        (1.6, -0.2),
        (1.8, -0.1),
        (2.0, -0.2),
        (2.2, -0.3),
        (2.4, -0.4),
        (2.6, -0.5),
    ];
    let upper: Vec<(f64, f64)> = lower.iter().map(|&(x, y)| (x, -y)).collect();
    vec![input(&lower, 0), input(&upper, 1)]
}
