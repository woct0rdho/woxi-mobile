//! Arm matching and the junction-point fit.

use super::geometry::*;
use super::params::*;
use super::trace::ArmKey;
use super::zones::Zone;

pub(super) struct ProvisionalArm {
    pub(super) chain: usize,
    /// Index into `Zone::runs`. Used to avoid cutting a run whose other arm
    /// was left unmatched.
    pub(super) run: usize,
    /// The endpoint of the broken run, used for the gap and the junction point.
    pub(super) tip: Point,
    /// The outside boundary point, used for the fitted line and attachment.
    pub(super) near: Point,
    pub(super) far: Point,
    pub(super) line: Line,
    /// The final arc key this arm will use: `(zone, chain, run, after)`.
    pub(super) key: ArmKey,
}

pub(super) struct MatchedZone {
    pub(super) zone: usize,
    pub(super) arms: Vec<ProvisionalArm>,
    pub(super) pairs: Vec<(usize, usize)>,
    pub(super) point: Point,
    /// Runs with every arm participating in a pair. Runs with an unmatched
    /// arm stay connected as Woxi drew them.
    pub(super) cuts: Vec<usize>,
}

pub(super) struct MatchCandidate {
    cost: f64,
    pairs: Vec<(usize, usize)>,
    cuts: Vec<usize>,
}

#[allow(clippy::needless_range_loop)]
pub(super) fn match_zone(
    zone_index: usize,
    chains: &[Vec<Point>],
    zone: &Zone,
) -> Option<MatchedZone> {
    let mut arms = Vec::new();
    let mut split_runs: Vec<usize> = Vec::new();
    for (run_index, run) in zone.runs.iter().enumerate() {
        if !run.split {
            continue;
        }
        let arms_before = arms.len();
        if run.start > 0 {
            let boundary = run.start - 1;
            if let Some(arm) = provisional_arm(
                chains,
                run.chain,
                run_index,
                zone_index,
                boundary,
                false,
                chains[run.chain][run.start],
            ) {
                arms.push(arm);
            }
        }
        if run.end + 1 < chains[run.chain].len() {
            let boundary = run.end + 1;
            if let Some(arm) = provisional_arm(
                chains,
                run.chain,
                run_index,
                zone_index,
                boundary,
                true,
                chains[run.chain][run.end],
            ) {
                arms.push(arm);
            }
        }
        // A run wholly inside the contact zone has no outside arms. It must
        // not enter the run mask: selecting it would cut a fragment without
        // any arm to reconnect, and a pile of such fragments could make the
        // mask wider than MAX_ZONE_ARMS even though the arm count is small.
        if arms.len() > arms_before {
            split_runs.push(run_index);
        }
    }
    if arms.len() < 2 || arms.len() > MAX_ZONE_ARMS {
        return None;
    }

    // Only split runs that contribute arms can be selected. Through-runs are
    // deliberately not part of this enumeration: including them would
    // multiply identical arm selections by every unrelated contour that
    // happens to pass nearby.
    let mut split_position = vec![usize::MAX; zone.runs.len()];
    for (position, &run) in split_runs.iter().enumerate() {
        split_position[run] = position;
    }

    // A run is an all-or-nothing unit: a two-arm hook must either have both
    // arms matched or remain untouched. Every run in this enumeration has at
    // least one arm, so `split_runs.len() <= arms.len() <= MAX_ZONE_ARMS`.
    let run_count = split_runs.len();
    let mut best: Option<MatchCandidate> = None;
    for run_mask in 1usize..(1usize << run_count) {
        let selected: Vec<usize> = arms
            .iter()
            .enumerate()
            .filter(|(_, arm)| {
                let position = split_position[arm.run];
                position != usize::MAX && run_mask & (1 << position) != 0
            })
            .map(|(index, _)| index)
            .collect();
        if selected.len() < 2 || !selected.len().is_multiple_of(2) {
            continue;
        }
        let Some((pair_cost, pairs)) = perfect_matching(&arms, &selected) else {
            continue;
        };
        let unmatched = arms.len() - selected.len();
        let total = pair_cost + unmatched as f64 * UNMATCHED_PENALTY;
        if best.as_ref().is_none_or(|previous| total < previous.cost) {
            let runs = split_runs
                .iter()
                .enumerate()
                .filter(|(position, _)| run_mask & (1 << position) != 0)
                .map(|(_, &run)| run)
                .collect();
            best = Some(MatchCandidate {
                cost: total,
                pairs,
                cuts: runs,
            });
        }
    }
    let MatchCandidate { pairs, cuts, .. } = best?;
    let point = zone_point(zone, &arms, &pairs);
    Some(MatchedZone {
        zone: zone_index,
        arms,
        pairs,
        point,
        cuts,
    })
}

/// Minimum-cost perfect matching over a selected subset of arms.
#[allow(clippy::needless_range_loop)]
fn perfect_matching(
    arms: &[ProvisionalArm],
    selected: &[usize],
) -> Option<(f64, Vec<(usize, usize)>)> {
    let n = selected.len();
    if n < 2 || !n.is_multiple_of(2) {
        return None;
    }
    let mut cost = vec![vec![None; n]; n];
    for a in 0..n {
        for b in (a + 1)..n {
            cost[a][b] = pair_cost(&arms[selected[a]], &arms[selected[b]]);
        }
    }
    let full = (1usize << n) - 1;
    let mut dp = vec![f64::INFINITY; full + 1];
    let mut parent: Vec<Option<(usize, usize, usize)>> = vec![None; full + 1];
    dp[0] = 0.0;
    for mask in 0..=full {
        if !dp[mask].is_finite() {
            continue;
        }
        let Some(a) = (0..n).find(|&index| mask & (1 << index) == 0) else {
            continue;
        };
        for b in (a + 1)..n {
            if mask & (1 << b) != 0 {
                continue;
            }
            let Some(pair_cost) = cost[a][b] else {
                continue;
            };
            let next = mask | (1 << a) | (1 << b);
            let value = dp[mask] + pair_cost;
            if value < dp[next] {
                dp[next] = value;
                parent[next] = Some((a, b, mask));
            }
        }
    }
    if !dp[full].is_finite() {
        return None;
    }
    let mut pairs = Vec::new();
    let mut mask = full;
    while mask != 0 {
        let (a, b, previous) = parent[mask]?;
        pairs.push((selected[a], selected[b]));
        mask = previous;
    }
    Some((dp[full], pairs))
}

fn provisional_arm(
    chains: &[Vec<Point>],
    chain: usize,
    run: usize,
    zone: usize,
    boundary: usize,
    after: bool,
    tip: Point,
) -> Option<ProvisionalArm> {
    let points = &chains[chain];
    let near = *points.get(boundary)?;
    let backward = if boundary == 0 {
        false
    } else if boundary + 1 == points.len() {
        true
    } else {
        !after
    };
    let step = if backward { -1isize } else { 1 };
    let mut far_index = boundary as isize;
    for _ in 0..TANGENT_STEPS {
        let next = far_index + step;
        if next < 0 || next >= points.len() as isize {
            break;
        }
        far_index = next;
    }
    let far = *points.get(far_index as usize)?;
    if distance(near, far) <= f64::EPSILON {
        return None;
    }
    let line = line_between(near, far)?;
    Some(ProvisionalArm {
        chain,
        run,
        tip,
        near,
        far,
        line,
        key: (zone, chain, run, after),
    })
}

pub(super) fn pair_cost(a: &ProvisionalArm, b: &ProvisionalArm) -> Option<f64> {
    if a.chain == b.chain {
        return None;
    }
    let dot = dot(a.line.dir, b.line.dir).clamp(-1.0, 1.0);
    let turn = (-dot).acos();
    if turn > MAX_LINE_ANGLE {
        return None;
    }
    let pair_line = line_between(a.near, b.near)?;
    let offset = pair_line.offset(a.far).max(pair_line.offset(b.far));
    if !offset.is_finite() || offset > MAX_OFFSET_STEPS {
        return None;
    }
    let gap = distance(a.tip, b.tip);
    if !gap.is_finite() || gap > MAX_GAP_STEPS {
        return None;
    }
    let cost = turn / MAX_LINE_ANGLE + offset / MAX_OFFSET_STEPS + gap / MAX_GAP_STEPS;
    Some(cost)
}

fn zone_point(zone: &Zone, arms: &[ProvisionalArm], pairs: &[(usize, usize)]) -> Point {
    if pairs.len() == 1 {
        let (a, b) = pairs[0];
        return midpoint(arms[a].tip, arms[b].tip);
    }
    let mut matrix = [[0.0f64; 2]; 2];
    let mut rhs = [0.0f64; 2];
    let contact_radius = CONTACT_STEPS;
    let scale = contact_radius.max(f64::MIN_POSITIVE);
    for &(a, b) in pairs {
        let Some(line) = line_between(arms[a].near, arms[b].near) else {
            continue;
        };
        let normal = (-line.dir.1, line.dir.0);
        matrix[0][0] += normal.0 * normal.0;
        matrix[0][1] += normal.0 * normal.1;
        matrix[1][1] += normal.1 * normal.1;
        let origin = (
            (line.origin.0 - zone.centre.0) / scale,
            (line.origin.1 - zone.centre.1) / scale,
        );
        let dot = dot(normal, origin);
        rhs[0] += normal.0 * dot;
        rhs[1] += normal.1 * dot;
    }
    matrix[1][0] = matrix[0][1];
    let det = matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0];
    if det.abs() < MIN_DETERMINANT {
        return mean_tip(arms, pairs);
    }
    let point = (
        zone.centre.0 + scale * (rhs[0] * matrix[1][1] - rhs[1] * matrix[0][1]) / det,
        zone.centre.1 + scale * (matrix[0][0] * rhs[1] - matrix[1][0] * rhs[0]) / det,
    );
    if distance(point, zone.centre) > MAX_JUNCTION_RADIUS_STEPS {
        return mean_tip(arms, pairs);
    }
    point
}

fn mean_tip(arms: &[ProvisionalArm], pairs: &[(usize, usize)]) -> Point {
    let mut sum = (0.0, 0.0);
    for &(a, b) in pairs {
        sum.0 += arms[a].tip.0 + arms[b].tip.0;
        sum.1 += arms[a].tip.1 + arms[b].tip.1;
    }
    sum.0 /= (pairs.len() * 2) as f64;
    sum.1 /= (pairs.len() * 2) as f64;
    sum
}
