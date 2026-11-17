//! Style-group reconstruction: split points, arcs, and final tracing.

use std::collections::HashMap;

use super::geometry::*;
use super::matching::{match_zone, MatchedZone};
use super::trace::{add_arc, trace_chains, Arm, ArmKey, Cut};
use super::zones::find_zones;

#[derive(Clone)]
pub(super) struct ChainIn {
    pub(super) points: Vec<Point>,
    pub(super) group: usize,
    pub(super) kind: usize,
}

#[derive(Clone, Debug)]
pub(super) struct ChainOut {
    pub(super) points: Vec<Point>,
    pub(super) kind: usize,
}

#[cfg(test)]
pub(super) fn repair_groups(chains: &[ChainIn]) -> Vec<ChainOut> {
    let points: Vec<Vec<Point>> = chains.iter().map(|chain| chain.points.clone()).collect();
    let grid = Grid::from_chains(&points, None);
    repair_groups_with_grid(chains, grid)
}

pub(super) fn repair_groups_with_grid(chains: &[ChainIn], grid: Grid) -> Vec<ChainOut> {
    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for (index, chain) in chains.iter().enumerate() {
        groups.entry(chain.group).or_default().push(index);
    }
    let mut group_ids: Vec<usize> = groups.keys().copied().collect();
    group_ids.sort_unstable();
    let mut out = Vec::new();
    for group in group_ids {
        let members = &groups[&group];
        let local: Vec<&[Point]> = members
            .iter()
            .map(|&index| chains[index].points.as_slice())
            .collect();
        let kinds: Vec<usize> = members.iter().map(|&index| chains[index].kind).collect();
        let repaired = reconstruct(&local, &kinds, grid);
        out.extend(repaired);
    }
    out
}

/// Reconstruct one style group. A group is one style, so chains can be joined
/// without changing the colour/width of the result.
fn reconstruct(chains: &[&[Point]], kinds: &[usize], grid: Grid) -> Vec<ChainOut> {
    let normalized: Vec<Vec<Point>> = chains
        .iter()
        .map(|chain| {
            chain
                .iter()
                .copied()
                .map(|point| grid.normalize(point))
                .collect()
        })
        .collect();
    let bounds = grid.bounds;
    let Some(zones) = find_zones(&normalized) else {
        return unchanged(chains, kinds);
    };
    let mut matched: Vec<MatchedZone> = Vec::new();
    for (zone_index, zone) in zones.iter().enumerate() {
        let Some(matched_zone) = match_zone(zone_index, &normalized, zone) else {
            continue;
        };
        if bounds.is_some_and(|bounds| !bounds.contains_interior(matched_zone.point)) {
            continue;
        }
        matched.push(matched_zone);
    }
    if matched.is_empty() {
        return unchanged(chains, kinds);
    }
    let mut zone_points = vec![None; zones.len()];
    for shape in &matched {
        zone_points[shape.zone] = Some(shape.point);
    }

    // Split each chain at the sampled runs that are genuinely broken. A run
    // that is straight through the zone is continuous and is not split.
    let mut cuts: Vec<Vec<Cut>> = vec![Vec::new(); chains.len()];
    for shape in &matched {
        for &run_index in &shape.cuts {
            let run = &zones[shape.zone].runs[run_index];
            cuts[run.chain].push(Cut {
                start: run.start,
                end: run.end,
                zone: shape.zone,
                run: run_index,
            });
        }
    }
    for chain_cuts in &mut cuts {
        chain_cuts.sort_by_key(|cut| cut.start);
    }

    let mut arcs = Vec::new();
    let mut arms: Vec<Arm> = Vec::new();
    let mut by_key: HashMap<ArmKey, usize> = HashMap::new();
    for (chain, chain_cuts) in cuts.iter().enumerate() {
        let points = &chains[chain];
        let mut cursor = 0usize;
        let mut previous: Option<(usize, usize)> = None;
        for cut in chain_cuts {
            if cut.start > cursor {
                add_arc(
                    &mut arcs,
                    &mut arms,
                    &mut by_key,
                    kinds[chain],
                    points[cursor..cut.start].to_vec(),
                    [
                        previous.map(|(zone, run)| (zone, chain, run, true)),
                        Some((cut.zone, chain, cut.run, false)),
                    ],
                );
            }
            previous = Some((cut.zone, cut.run));
            cursor = cut.end + 1;
        }
        if cursor < points.len() {
            add_arc(
                &mut arcs,
                &mut arms,
                &mut by_key,
                kinds[chain],
                points[cursor..].to_vec(),
                [previous.map(|(zone, run)| (zone, chain, run, true)), None],
            );
        }
    }

    // Matching uses provisional arm keys. The final arcs use the same keys,
    // so a pair maps directly without searching by chain, side, and point.
    let mut mates = vec![None; arms.len()];
    for shape in &matched {
        for (a, b) in shape.pairs.iter().copied() {
            let arm_a = &shape.arms[a];
            let arm_b = &shape.arms[b];
            let (Some(&final_a), Some(&final_b)) = (by_key.get(&arm_a.key), by_key.get(&arm_b.key))
            else {
                // The cuts are already committed. If an outside arc was not
                // produced, leave this whole style group as Woxi drew it
                // rather than deleting the segment between the cuts.
                return unchanged(chains, kinds);
            };
            mates[final_a] = Some(final_b);
            mates[final_b] = Some(final_a);
        }
    }
    trace_chains(&arcs, &arms, &mates, &zone_points, grid)
}

fn unchanged(chains: &[&[Point]], kinds: &[usize]) -> Vec<ChainOut> {
    chains
        .iter()
        .enumerate()
        .map(|(index, points)| ChainOut {
            points: points.to_vec(),
            kind: kinds[index],
        })
        .collect()
}
