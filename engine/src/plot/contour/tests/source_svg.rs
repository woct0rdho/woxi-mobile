use super::*;
use crate::plot::repair_graphic;
use woxi::syntax::Expr;

#[test]
fn svg_repair_rebuilds_the_same_boxed_crossing() {
    let svg = r#"<svg><polyline points="127,127 138,116 151,104 163,104 172,116 181,127" fill="none" stroke="red" stroke-linecap="round" stroke-linejoin="round"/><polyline points="181,73 172,84 163,98 151,98 138,84 127,73" fill="none" stroke="red" stroke-linecap="round" stroke-linejoin="round"/></svg>"#;
    let repaired = repair_svg(svg);
    assert_ne!(repaired, svg);
    assert_eq!(polylines(&repaired).len(), 2);
}

#[test]
fn source_cells_keep_their_own_x_and_y_scale() {
    let chains = vec![input(&[(0.0, 0.0), (1.0, 0.0)], 0)];
    let source = source_from_chains(&chains, (0.0, 100.0), (0.0, 1.0));
    let grid = Grid::from_source(&source).expect("source grid");
    assert_eq!(grid.cell, (1.0, 0.01));
    assert_eq!(grid.normalize((100.0, 1.0)), (100.0, 100.0));
}

#[test]
fn source_cells_follow_the_sampled_grid_not_a_fixed_hundred() {
    let chains = vec![input(&[(0.0, 0.0), (1.0, 0.5), (2.0, 0.0)], 0)];
    let source = source_from_chains(&chains, (0.0, 400.0), (0.0, 200.0));
    let grid = Grid::from_source(&source).expect("source grid");
    assert_eq!(grid.cell, (1.0, 0.5));
    assert_eq!(grid.normalize((400.0, 200.0)), (400.0, 400.0));
}

#[test]
fn svg_cells_follow_the_point_steps_not_the_outer_frame() {
    let chains = vec![chain(&[(0.0, 0.0), (1.0, 0.5), (2.0, 0.0)])];
    let grid = Grid::from_chains(
        &chains,
        Some(Bounds {
            min_x: 0.0,
            max_x: 200.0,
            min_y: 0.0,
            max_y: 100.0,
        }),
    );
    assert_eq!(grid.cell, (1.0, 0.5));
    assert_eq!(grid.origin, (4.0, 2.0));
    assert_eq!(
        grid.bounds,
        Some(Bounds {
            min_x: 0.0,
            max_x: 192.0,
            min_y: 0.0,
            max_y: 192.0
        })
    );
}

#[test]
fn a_non_square_svg_frame_sets_independent_cells() {
    let grid = Grid::from_chains(
        &[],
        Some(Bounds {
            min_x: 10.0,
            max_x: 210.0,
            min_y: 20.0,
            max_y: 120.0,
        }),
    );
    // The SVG rect is the outer padded frame. The sampled data rectangle is
    // inset by Woxi's default 2% on each side.
    assert_eq!(grid.cell, (1.92, 0.96));
    assert_eq!(grid.origin, (14.0, 22.0));
    assert_eq!(grid.normalize((206.0, 118.0)), (100.0, 100.0));
}

#[test]
fn labeled_source_series_are_never_joined() {
    let chains = vec![
        input(&[(0.0, 0.0), (0.5, 0.0), (1.0, 0.0)], 0),
        input(&[(1.3, 0.0), (1.8, 0.0), (2.3, 0.0)], 1),
    ];
    let mut source = source_from_chains(&chains, (-10.0, 10.0), (-10.0, 10.0));
    source.series[0].labels = vec![Some("a".to_string())];
    repair_source(&mut source);
    assert_eq!(source.series.len(), 2);
    assert_eq!(source.series[0].points, chains[0].points);
    assert_eq!(source.series[1].points, chains[1].points);
}

#[test]
fn an_invalid_source_range_is_left_unchanged() {
    let chains = vec![input(&[(0.0, 0.0), (1.0, 0.0)], 0)];
    let mut source = source_from_chains(&chains, (0.0, 0.0), (0.0, 0.0));
    repair_source(&mut source);
    assert_eq!(source.series.len(), 1);
    assert_eq!(source.series[0].points, chains[0].points);
}

#[test]
fn repair_graphic_visits_a_rule_wrapped_graphic() {
    let original = r#"<svg><polyline points="127,127 138,116 151,104 163,104 172,116 181,127" fill="none" stroke="red" stroke-linecap="round" stroke-linejoin="round"/><polyline points="181,73 172,84 163,98 151,98 138,84 127,73" fill="none" stroke="red" stroke-linecap="round" stroke-linejoin="round"/></svg>"#;
    let graphic = Expr::Graphics {
        svg: original.to_string(),
        is_3d: false,
        source: None,
        head: None,
        structure: None,
    };
    let mut expr = Expr::Rule {
        pattern: Box::new(Expr::Identifier("x".to_string())),
        replacement: Box::new(graphic),
    };
    repair_graphic(&mut expr);
    let Expr::Rule { replacement, .. } = &expr else {
        panic!("rule");
    };
    let Expr::Graphics { svg, .. } = replacement.as_ref() else {
        panic!("graphic");
    };
    assert_ne!(svg, original);
    assert_eq!(polylines(svg).len(), 2);
}

#[test]
fn the_svg_frame_is_the_boundary_not_the_contour_extent() {
    assert_eq!(
        svg_frame_bounds(
            r##"<svg><rect x="0" y="0" width="100" height="100" fill="#FFF"/><rect x="10" y="20" width="300" height="200" fill="none" stroke="#666"/></svg>"##
        ),
        Some(Bounds {
            min_x: 10.0,
            max_x: 310.0,
            min_y: 20.0,
            max_y: 220.0,
        })
    );
    let frame = Bounds {
        min_x: 0.0,
        max_x: 10.0,
        min_y: 0.0,
        max_y: 10.0,
    };
    assert!(!frame.contains_interior((0.25, 5.0)));
    assert!(frame.contains_interior((5.0, 5.0)));
}

#[test]
fn svg_repair_preserves_unrelated_polylines() {
    let unrelated = r#"<polyline points="0,0 10,0" fill="none" stroke="gray"/>"#;
    let svg = format!(
        r##"<svg>{unrelated}<polyline points="127,127 138,116 151,104 163,104 172,116 181,127" fill="none" stroke="red" stroke-linecap="round" stroke-linejoin="round"/><polyline points="181,73 172,84 163,98 151,98 138,84 127,73" fill="none" stroke="red" stroke-linecap="round" stroke-linejoin="round"/></svg>"##
    );
    let repaired = repair_svg(&svg);
    assert_ne!(repaired, svg);
    assert!(
        repaired.contains(unrelated),
        "the unrelated polyline was rewritten"
    );
}

#[test]
fn svg_repair_preserves_a_far_same_style_polyline() {
    let unrelated = r#"<polyline points="0,0 10,0" fill="none" stroke="red"/>"#;
    let svg = format!(
        r##"<svg>{unrelated}<polyline points="127,127 138,116 151,104 163,104 172,116 181,127" fill="none" stroke="red" stroke-linecap="round" stroke-linejoin="round"/><polyline points="181,73 172,84 163,98 151,98 138,84 127,73" fill="none" stroke="red" stroke-linecap="round" stroke-linejoin="round"/></svg>"##
    );
    let repaired = repair_svg(&svg);
    assert_ne!(repaired, svg);
    assert!(
        repaired.contains(unrelated),
        "a far same-style polyline was rewritten: {repaired}"
    );
}

#[test]
fn source_series_filling_references_are_never_joined() {
    let chains = vec![
        input(&[(0.0, 0.0), (0.5, 0.0), (1.0, 0.0)], 0),
        input(&[(1.3, 0.0), (1.8, 0.0), (2.3, 0.0)], 1),
    ];
    let mut source = source_from_chains(&chains, (-10.0, 10.0), (-10.0, 10.0));
    source.series[0].filling = woxi::syntax::SeriesFilling::Series(1);
    repair_source(&mut source);
    assert_eq!(source.series.len(), 2);
    assert_eq!(source.series[0].points, chains[0].points);
    assert_eq!(source.series[1].points, chains[1].points);
}

#[test]
fn source_cell_estimate_is_stable_with_one_long_segment() {
    let mut chains = Vec::new();
    for _ in 0..9 {
        chains.push(input(&[(0.0, 0.0), (1.0, 0.0)], 0));
    }
    chains.push(input(&[(0.0, 0.0), (3.0, 0.0)], 0));
    let source = source_from_chains(&chains, (0.0, 400.0), (0.0, 1.0));
    let grid = Grid::from_source(&source).expect("source grid");
    assert_eq!(grid.cell, (1.0, 0.01));
}

#[test]
fn svg_cell_metadata_round_trips_a_small_cell() {
    let svg = r##"<svg><rect x="0" y="0" width="100" height="100" fill="none" stroke="#666666"/><polyline points="1e-9,0 2e-9,0" fill="none" stroke="red" stroke-linecap="round" stroke-linejoin="round"/></svg>"##;
    let repaired = repair_svg(svg);
    assert!(
        repaired.contains("e-9"),
        "the measured cell was rounded away: {repaired}"
    );
    assert_eq!(repair_svg(&repaired), repaired);
}

#[test]
fn the_svg_frame_must_be_stroked() {
    assert_eq!(
        svg_frame_bounds(r#"<svg><rect x="0" y="0" width="100" height="100" fill="none"/></svg>"#),
        None
    );
}

#[test]
fn source_backed_graphics_accept_plain_show_polylines() {
    let svg = r#"<svg><polyline points="0,0 10,10" fill="none" stroke="red"/></svg>"#;
    let source = source_from_chains(
        &[input(&[(0.0, 0.0), (1.0, 1.0)], 0)],
        (-1.0, 1.0),
        (-1.0, 1.0),
    );
    let mut graphic = Expr::Graphics {
        svg: svg.to_string(),
        is_3d: false,
        source: Some(Box::new(source)),
        head: None,
        structure: None,
    };
    repair_graphic(&mut graphic);
    let Expr::Graphics { svg, .. } = &graphic else {
        panic!("graphic");
    };
    assert!(svg.contains("data-woxi-contour-cell"));
}

#[test]
fn svg_point_parsing_handles_wolfram_coordinates() {
    let points = parse_points("1.5,-2 3,4 5,6").unwrap();
    assert_eq!(points, vec![(1.5, -2.0), (3.0, 4.0), (5.0, 6.0)]);
}
