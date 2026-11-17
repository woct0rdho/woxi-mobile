use super::super::geometry::*;
use super::super::matching::*;

fn arm(chain: usize, near: Point, far: Point, tip: Point) -> ProvisionalArm {
    let line = line_between(near, far).expect("arm line");
    ProvisionalArm {
        chain,
        run: 0,
        tip,
        near,
        far,
        line,
        key: (0, chain, 0, true),
    }
}

#[test]
fn same_chain_arms_are_never_paired() {
    let left = arm(0, (0.0, 0.0), (-1.0, 0.0), (1.0, 0.0));
    let right = arm(0, (2.0, 0.0), (3.0, 0.0), (1.0, 0.0));
    assert!(pair_cost(&left, &right).is_none());
}

#[test]
fn a_same_direction_pair_is_not_a_continuation() {
    let left = arm(0, (0.0, 0.0), (-1.0, 0.0), (1.0, 0.0));
    let same_direction = arm(1, (2.0, 0.0), (1.0, 0.0), (1.0, 0.0));
    assert!(pair_cost(&left, &same_direction).is_none());
}

#[test]
fn opposite_arms_with_a_small_gap_are_a_continuation() {
    let left = arm(0, (0.0, 0.0), (-1.0, 0.0), (1.0, 0.0));
    let right = arm(1, (2.0, 0.0), (3.0, 0.0), (1.0, 0.0));
    let cost = pair_cost(&left, &right).expect("continuation");
    assert!(cost >= 0.0);
    assert!(cost <= 3.0);
}
