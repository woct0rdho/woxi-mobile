//! PlotSource cleanup.

use std::collections::HashMap;

use woxi::syntax::{PlotSeriesData, PlotSource, SeriesFilling};

use super::geometry::*;
use super::graph::{repair_groups_with_grid, ChainIn};
use super::params::*;

type MarkerStyle = (String, u64, Option<(u8, u8, u8)>, bool, bool);

#[derive(Clone, PartialEq, Eq, Hash)]
struct SourceStyle {
    color: (u8, u8, u8),
    thickness: Option<u64>,
    dashing: Option<Vec<u64>>,
    opacity: Option<u64>,
    is_scatter: bool,
    filling: (u8, Option<u64>),
    fill_color: Option<(u8, u8, u8)>,
    fill_opacity: Option<u64>,
    marker: Option<MarkerStyle>,
    point_size: Option<u64>,
}

fn filling_key(filling: SeriesFilling) -> (u8, Option<u64>) {
    match filling {
        SeriesFilling::None => (0, None),
        SeriesFilling::Axis => (1, None),
        SeriesFilling::Bottom => (2, None),
        SeriesFilling::Top => (3, None),
        SeriesFilling::Value(value) => (4, Some(value.to_bits())),
        SeriesFilling::Series(index) => (5, Some(index as u64)),
    }
}

fn source_style(series: &PlotSeriesData) -> SourceStyle {
    SourceStyle {
        color: series.color,
        thickness: series.thickness.map(f64::to_bits),
        dashing: series
            .dashing
            .as_ref()
            .map(|values| values.iter().copied().map(f64::to_bits).collect()),
        opacity: series.opacity.map(f64::to_bits),
        is_scatter: series.is_scatter,
        filling: filling_key(series.filling),
        fill_color: series.fill_color,
        fill_opacity: series.fill_opacity.map(f64::to_bits),
        marker: series.marker.as_ref().map(|marker| {
            (
                marker.glyph.clone(),
                marker.size.to_bits(),
                marker.color,
                marker.open,
                marker.automatic,
            )
        }),
        point_size: series.point_size.map(f64::to_bits),
    }
}

pub(super) fn repair_source(source: &mut PlotSource) {
    let Some(grid) = Grid::from_source(source) else {
        return;
    };
    for _ in 0..MAX_REPAIR_PASSES {
        if !repair_source_once(source, grid) {
            break;
        }
    }
}

fn repair_source_once(source: &mut PlotSource, grid: Grid) -> bool {
    if source.series.is_empty() {
        return false;
    }
    let old = std::mem::take(&mut source.series);
    // A `Filling -> Series[index]` reference is positional. If any series has
    // one, leave every series in its own group. Merging or reordering even an
    // unrelated series would change the meaning of that index.
    let has_series_filling = old
        .iter()
        .any(|series| matches!(series.filling, SeriesFilling::Series(_)));
    let mut groups: HashMap<SourceStyle, usize> = HashMap::new();
    let mut next_group = 0usize;
    let chains: Vec<ChainIn> = old
        .iter()
        .enumerate()
        .map(|(kind, series)| {
            // These series carry per-point or symbolic data that cannot be
            // reconstructed by joining chains. Leave each one in its own
            // group so cleanup never drops labels, marker expressions, or a
            // `Filling -> Series[index]` reference whose index would move.
            let unique = has_series_filling
                || series.labels.iter().any(Option::is_some)
                || !series.mesh_full_points.is_empty()
                || series.color_expr.is_some()
                || series.point_size_expr.is_some()
                || series
                    .marker
                    .as_ref()
                    .is_some_and(|marker| marker.graphics.is_some());
            let group = if unique {
                let group = next_group;
                next_group += 1;
                group
            } else {
                let style = source_style(series);
                *groups.entry(style).or_insert_with(|| {
                    let group = next_group;
                    next_group += 1;
                    group
                })
            };
            ChainIn {
                points: series.points.clone(),
                group,
                kind,
            }
        })
        .collect();
    let repaired = repair_groups_with_grid(&chains, grid);
    if repaired.len() == chains.len()
        && repaired
            .iter()
            .zip(chains.iter())
            .all(|(out, input)| out.kind == input.kind && out.points == input.points)
    {
        source.series = old;
        return false;
    }
    source.series = repaired
        .into_iter()
        .map(|chain| {
            let mut series = old[chain.kind].clone();
            series.points = chain.points;
            series
        })
        .collect();
    true
}
