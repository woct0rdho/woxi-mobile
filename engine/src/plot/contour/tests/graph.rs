use super::*;

#[test]
fn a_boxed_crossing_becomes_one_clean_x() {
    let out = repair_groups(&boxed_crossing());
    assert_eq!(out.len(), 2);
    let centre = (1.8, 0.0);
    assert!(
        out.iter()
            .all(|chain| chain.points.iter().any(|&p| distance(p, centre) < 0.02)),
        "both rebuilt contours should pass through the junction: {out:?}"
    );
    assert!(
        out.iter().all(|chain| chain
            .points
            .windows(2)
            .all(|pair| distance(pair[0], pair[1]) < 0.6)),
        "no long bridge should remain: {out:?}"
    );
}

#[test]
fn a_clean_crossing_is_returned_unchanged() {
    let chains = vec![
        input(&[(0.0, 0.0), (1.0, 1.0), (2.0, 2.0)], 0),
        input(&[(0.0, 2.0), (1.0, 1.0), (2.0, 0.0)], 1),
    ];
    let out = repair_groups(&chains);
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].points, chains[0].points);
    assert_eq!(out[1].points, chains[1].points);
}

#[test]
fn a_smooth_curve_and_a_sharp_corner_are_left_alone() {
    let circle: Vec<(f64, f64)> = (0..24)
        .map(|i| {
            let a = i as f64 / 24.0 * std::f64::consts::TAU;
            (a.cos(), a.sin())
        })
        .collect();
    let corner = [(0.0, 1.0), (1.0, 0.0), (2.0, 1.0)];
    let chains = vec![input(&circle, 0), input(&corner, 1)];
    let out = repair_groups(&chains);
    assert_eq!(out[0].points, chains[0].points);
    assert_eq!(out[1].points, chains[1].points);
}

#[test]
fn a_one_point_chain_is_preserved() {
    let chains = vec![input(&[(5.0, 5.0)], 0)];
    let out = repair_groups(&chains);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].points, chains[0].points);
}

#[test]
fn a_pile_of_fragments_does_not_overflow_the_zone_mask() {
    let mut chains = boxed_crossing();
    for index in 0..80 {
        let y = 0.1 + index as f64 * 0.0001;
        chains.push(input(&[(1.8, y), (1.8, y + 0.3)], index + 2));
    }
    let out = repair_groups(&chains);
    assert!(out.len() >= chains.len());
    assert!(
        out.iter().filter(|chain| chain.points.len() == 2).count() >= 80,
        "every fragment should be preserved"
    );
}

#[test]
fn an_extra_fragment_does_not_disable_a_valid_crossing() {
    let mut chains = boxed_crossing();
    chains.push(input(&[(1.8, 0.4), (1.8, 0.6)], 2));
    let out = repair_groups(&chains);
    assert!(
        out.iter()
            .any(|chain| chain.points.iter().any(|&p| distance(p, (1.8, 0.0)) < 0.05)),
        "the boxed crossing should still be repaired"
    );
    assert!(
        out.iter()
            .any(|chain| chain.points.iter().any(|&p| distance(p, (1.8, 0.4)) < 0.01)),
        "the unrelated fragment should be preserved: {out:?}"
    );
}

#[test]
fn two_chain_ends_across_a_gap_are_joined() {
    let chains = vec![
        input(&[(0.0, 0.0), (0.5, 0.0), (1.0, 0.0)], 0),
        input(&[(1.3, 0.0), (1.8, 0.0), (2.3, 0.0)], 1),
    ];
    let out = repair_groups(&chains);
    assert_eq!(out.len(), 1);
    assert!(out[0].points.iter().any(|p| (p.0 - 1.15).abs() < 0.2));
}

#[test]
fn a_single_chain_self_crossing_is_not_zoned() {
    let chains = vec![input(
        &[(0.0, 0.0), (1.0, 1.0), (2.0, 0.0), (1.0, -1.0), (0.5, 0.0)],
        0,
    )];
    let out = repair_groups(&chains);
    assert_eq!(out[0].points, chains[0].points);
}

#[test]
fn two_lines_that_only_pass_close_are_not_joined() {
    let chains = vec![
        input(&[(0.0, 0.0), (1.0, 0.0), (2.0, 0.0)], 0),
        input(&[(0.0, 0.2), (1.0, 0.2), (2.0, 0.2)], 1),
    ];
    let out = repair_groups(&chains);
    assert_eq!(out[0].points, chains[0].points);
    assert_eq!(out[1].points, chains[1].points);
}

#[test]
fn a_t_junction_is_not_a_crossing() {
    let chains = vec![
        input(&[(0.0, 0.0), (1.0, 1.0), (2.0, 2.0)], 0),
        input(&[(1.0, 0.9), (1.0, 1.0), (1.0, 1.1)], 1),
    ];
    let out = repair_groups(&chains);
    assert_eq!(out[0].points, chains[0].points);
    assert_eq!(out[1].points, chains[1].points);
}

#[test]
fn a_junction_on_the_sampled_frame_is_not_joined() {
    let chains = boxed_crossing();
    let grid = Grid {
        origin: (0.0, 0.0),
        cell: (1.0, 1.0),
        // The crossing is at y = 0, on the lower frame edge.
        bounds: Some(Bounds {
            min_x: -10.0,
            max_x: 10.0,
            min_y: 0.0,
            max_y: 1.0,
        }),
    };
    let out = repaired_with_grid(&chains, grid);
    assert_eq!(out[0].points, chains[0].points);
    assert_eq!(out[1].points, chains[1].points);
}

#[test]
fn different_styles_are_never_joined() {
    let mut chains = boxed_crossing();
    chains[1].group = 1;
    let out = repair_groups(&chains);
    assert_eq!(out[0].points, chains[0].points);
    assert_eq!(out[1].points, chains[1].points);
}

#[test]
fn a_repair_is_idempotent() {
    let once = repair_groups(&boxed_crossing());
    let twice = repair_groups(
        &once
            .iter()
            .enumerate()
            .map(|(kind, chain)| ChainIn {
                points: chain.points.clone(),
                group: 0,
                kind,
            })
            .collect::<Vec<_>>(),
    );
    assert_eq!(once.len(), twice.len());
    for (a, b) in once.iter().zip(twice.iter()) {
        assert_eq!(a.points, b.points);
    }
}

#[test]
fn a_non_square_grid_still_repairs_a_crossing() {
    let mut chains = boxed_crossing();
    for chain in &mut chains {
        for point in &mut chain.points {
            point.0 *= 10.0;
        }
    }
    let grid = Grid {
        origin: (0.0, 0.0),
        cell: (1.0, 0.1),
        bounds: Some(Bounds {
            min_x: -50.0,
            max_x: 50.0,
            min_y: -50.0,
            max_y: 50.0,
        }),
    };
    let out = repaired_with_grid(&chains, grid);
    assert_eq!(out.len(), 2);
    assert!(
        out.iter()
            .all(|chain| chain.points.iter().any(|&p| {
                distance(grid.normalize((1.8 * 10.0, 0.0)), grid.normalize(p)) < 0.2
            })),
        "both curves should meet at the shared junction: {out:?}"
    );
}
