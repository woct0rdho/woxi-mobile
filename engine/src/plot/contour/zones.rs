//! Contact zones and the straight-through test.

use std::collections::{BTreeMap, HashMap};

use super::geometry::*;
use super::params::*;

pub(super) struct Run {
    pub(super) chain: usize,
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) split: bool,
}

pub(super) struct Zone {
    pub(super) centre: Point,
    pub(super) runs: Vec<Run>,
}

pub(super) fn find_zones(chains: &[Vec<Point>]) -> Option<Vec<Zone>> {
    let radius = CONTACT_STEPS;
    let mut vertices = Vec::new();
    for (chain, points) in chains.iter().enumerate() {
        for (index, &point) in points.iter().enumerate() {
            if point.0.is_finite() && point.1.is_finite() {
                vertices.push((chain, index, point));
            }
        }
    }
    if vertices.len() < 2 {
        return None;
    }
    let mut dsu = Dsu::new(vertices.len());
    let cell =
        |p: Point| -> (i64, i64) { ((p.0 / radius).floor() as i64, (p.1 / radius).floor() as i64) };
    let mut grid: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (id, (_, _, point)) in vertices.iter().enumerate() {
        grid.entry(cell(*point)).or_default().push(id);
    }
    for (id, (chain, _, point)) in vertices.iter().enumerate() {
        let (cx, cy) = cell(*point);
        for dx in -1..=1 {
            for dy in -1..=1 {
                let Some(ids) = grid.get(&(cx + dx, cy + dy)) else {
                    continue;
                };
                for &other in ids {
                    if other <= id {
                        continue;
                    }
                    let (other_chain, _, other_point) = vertices[other];
                    if *chain == other_chain {
                        continue;
                    }
                    if distance(*point, other_point) > radius {
                        continue;
                    }
                    dsu.union(id, other);
                }
            }
        }
    }

    let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for id in 0..vertices.len() {
        groups.entry(dsu.find(id)).or_default().push(id);
    }
    // A saddle can produce two contact clusters a cell apart: one for the
    // vertical arms and one for the horizontal arms. They are one junction,
    // not two independent crossings. Merge clusters whose centres are within
    // the same contact radius before constructing runs.
    let groups: Vec<Vec<usize>> = groups
        .into_values()
        .filter(|members| {
            let first = members.first().map(|&id| vertices[id].0);
            members.iter().any(|&id| Some(vertices[id].0) != first)
        })
        .collect();
    let centres: Vec<Point> = groups
        .iter()
        .map(|members| centre(members, &vertices))
        .collect();
    let mut group_dsu = Dsu::new(groups.len());
    let mut group_grid: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (index, &centre) in centres.iter().enumerate() {
        group_grid.entry(cell(centre)).or_default().push(index);
    }
    for a in 0..groups.len() {
        let (cx, cy) = cell(centres[a]);
        for dx in -1..=1 {
            for dy in -1..=1 {
                let Some(ids) = group_grid.get(&(cx + dx, cy + dy)) else {
                    continue;
                };
                for &b in ids {
                    if b <= a {
                        continue;
                    }
                    if distance(centres[a], centres[b]) <= radius {
                        group_dsu.union(a, b);
                    }
                }
            }
        }
    }
    let mut merged: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (index, members) in groups.into_iter().enumerate() {
        let root = group_dsu.find(index);
        merged.entry(root).or_default().extend(members);
    }
    let mut zones = Vec::new();
    for members in merged.values() {
        let mut by_chain: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
        for &id in members {
            by_chain
                .entry(vertices[id].0)
                .or_default()
                .push(vertices[id].1);
        }
        let centre = centre(members, &vertices);
        let mut runs = Vec::new();
        for (chain, mut indices) in by_chain {
            indices.sort_unstable();
            indices.dedup();
            let mut start = 0;
            while start < indices.len() {
                let mut end = start;
                while end + 1 < indices.len()
                    && indices[end + 1] <= indices[end] + MAX_CONTACT_INDEX_GAP
                    && distance(chains[chain][indices[end]], chains[chain][indices[end + 1]])
                        <= MAX_GAP_STEPS
                {
                    end += 1;
                }
                let run_start = indices[start];
                let run_end = indices[end];
                let split = !passes_through(chains[chain].as_slice(), run_start, run_end);
                runs.push(Run {
                    chain,
                    start: run_start,
                    end: run_end,
                    split,
                });
                start = end + 1;
            }
        }
        if runs.iter().any(|run| run.split) {
            zones.push(Zone { centre, runs });
        }
    }
    zones.sort_by(|a, b| {
        a.centre
            .0
            .total_cmp(&b.centre.0)
            .then_with(|| a.centre.1.total_cmp(&b.centre.1))
    });
    (!zones.is_empty()).then_some(zones)
}

fn passes_through(points: &[Point], start: usize, end: usize) -> bool {
    if start == 0 || end + 1 >= points.len() {
        return false;
    }
    let before = points[start - 1];
    let after = points[end + 1];
    let Some(line) = line_between(before, after) else {
        return false;
    };
    // A single contact point can sit on a right-angle corner whose chord
    // offset is still below the offset tolerance. Check the local turns too,
    // so a chain that bends into a U hook is not mistaken for a straight line.
    let mut previous_line: Option<Line> = None;
    for pair in points[start - 1..=end + 1].windows(2) {
        let Some(next_line) = line_between(pair[0], pair[1]) else {
            return false;
        };
        if let Some(previous_line) = previous_line {
            if angle_between(previous_line.angle(), next_line.angle()) > MAX_LINE_ANGLE {
                return false;
            }
        }
        previous_line = Some(next_line);
    }
    points[start - 1..=end + 1]
        .iter()
        .all(|&point| line.offset(point) <= THROUGH_OFFSET_STEPS)
}

fn centre(members: &[usize], vertices: &[(usize, usize, Point)]) -> Point {
    let mut sum = (0.0, 0.0);
    for &id in members {
        sum.0 += vertices[id].2 .0;
        sum.1 += vertices[id].2 .1;
    }
    (sum.0 / members.len() as f64, sum.1 / members.len() as f64)
}

struct Dsu {
    parent: Vec<usize>,
    rank: Vec<u8>,
}

impl Dsu {
    fn new(n: usize) -> Self {
        Self {
            parent: (0..n).collect(),
            rank: vec![0; n],
        }
    }

    fn find(&mut self, x: usize) -> usize {
        if self.parent[x] != x {
            self.parent[x] = self.find(self.parent[x]);
        }
        self.parent[x]
    }

    fn union(&mut self, a: usize, b: usize) {
        let mut ra = self.find(a);
        let mut rb = self.find(b);
        if ra == rb {
            return;
        }
        if self.rank[ra] < self.rank[rb] {
            std::mem::swap(&mut ra, &mut rb);
        }
        self.parent[rb] = ra;
        if self.rank[ra] == self.rank[rb] {
            self.rank[ra] += 1;
        }
    }
}
