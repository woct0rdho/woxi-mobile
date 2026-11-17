//! Arc tracing through matched arms.

use std::collections::HashMap;

use super::geometry::*;
use super::graph::ChainOut;

/// Identity of one side of a split run: `(zone, chain, run, after)`.
pub(super) type ArmKey = (usize, usize, usize, bool);

pub(super) fn add_arc(
    arcs: &mut Vec<Arc>,
    arms: &mut Vec<Arm>,
    by_key: &mut HashMap<ArmKey, usize>,
    kind: usize,
    points: Vec<Point>,
    placements: [Option<ArmKey>; 2],
) {
    let arc_id = arcs.len();
    let mut ends = [End::Free, End::Free];
    for (end, placement) in placements.into_iter().enumerate() {
        let Some((zone, arm_chain, run, after)) = placement else {
            continue;
        };
        let key = (zone, arm_chain, run, after);
        let id = arms.len();
        arms.push(Arm {
            arc: arc_id,
            end,
            zone,
        });
        by_key.insert(key, id);
        ends[end] = End::Arm(id);
    }
    arcs.push(Arc { points, kind, ends });
}

#[derive(Clone)]
pub(super) struct Cut {
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) zone: usize,
    pub(super) run: usize,
}

pub(super) struct Arc {
    pub(super) points: Vec<Point>,
    pub(super) kind: usize,
    pub(super) ends: [End; 2],
}

#[derive(Clone, Copy)]
pub(super) enum End {
    Free,
    Arm(usize),
}

pub(super) struct Arm {
    pub(super) arc: usize,
    pub(super) end: usize,
    pub(super) zone: usize,
}

pub(super) fn trace_chains(
    arcs: &[Arc],
    arms: &[Arm],
    mates: &[Option<usize>],
    zone_points: &[Option<Point>],
    grid: Grid,
) -> Vec<ChainOut> {
    let mut visited = vec![false; arcs.len()];
    let mut out = Vec::new();
    for seed in 0..arcs.len() {
        if visited[seed] {
            continue;
        }
        let start_end = if matches!(arcs[seed].ends[0], End::Free) {
            0
        } else if matches!(arcs[seed].ends[1], End::Free) {
            1
        } else {
            0
        };
        let mut points = Vec::new();
        let kind = arcs[seed].kind;
        let mut current = seed;
        let mut entry = start_end;
        if let End::Arm(arm_id) = arcs[seed].ends[entry] {
            if mates[arm_id].is_some() {
                if let Some(point) = zone_points[arms[arm_id].zone] {
                    points.push(grid.denormalize(point));
                }
            }
        }
        loop {
            if visited[current] {
                break;
            }
            visited[current] = true;
            let arc = &arcs[current];
            if entry == 0 {
                points.extend(arc.points.iter().copied());
            } else {
                points.extend(arc.points.iter().rev().copied());
            }
            let exit = 1 - entry;
            let End::Arm(arm_id) = arc.ends[exit] else {
                break;
            };
            let Some(mate_id) = mates[arm_id] else {
                break;
            };
            let arm = &arms[arm_id];
            if let Some(point) = zone_points[arm.zone] {
                points.push(grid.denormalize(point));
            }
            let mate = &arms[mate_id];
            current = mate.arc;
            entry = mate.end;
        }
        if !points.is_empty() {
            out.push(ChainOut { points, kind });
        }
    }
    out
}
