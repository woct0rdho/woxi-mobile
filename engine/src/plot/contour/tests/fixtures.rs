use super::*;

fn parse_source_fixture(text: &str) -> Vec<ChainIn> {
    let mut chains = Vec::new();
    let mut points = Vec::new();
    for line in text.lines() {
        if line.starts_with("series ") {
            if !points.is_empty() {
                chains.push(ChainIn {
                    points: std::mem::take(&mut points),
                    group: 0,
                    kind: chains.len(),
                });
            }
        } else {
            for token in line.split_whitespace() {
                let (x, y) = token.split_once(',').unwrap();
                points.push((x.parse().unwrap(), y.parse().unwrap()));
            }
        }
    }
    if !points.is_empty() {
        chains.push(ChainIn {
            points,
            group: 0,
            kind: chains.len(),
        });
    }
    chains
}

fn padded_source() -> Vec<ChainIn> {
    parse_source_fixture(include_str!(
        "../../../../tests/fixtures/padded_contour_source.txt"
    ))
}

fn grid_source() -> Vec<ChainIn> {
    parse_source_fixture(include_str!(
        "../../../../tests/fixtures/singrid_source.txt"
    ))
}

fn padded_source_fixture() -> woxi::syntax::PlotSource {
    let chains = padded_source();
    let points: Vec<Vec<Point>> = chains.iter().map(|chain| chain.points.clone()).collect();
    let min_x = points
        .iter()
        .flatten()
        .map(|p| p.0)
        .fold(f64::INFINITY, f64::min);
    let max_x = points
        .iter()
        .flatten()
        .map(|p| p.0)
        .fold(f64::NEG_INFINITY, f64::max);
    let min_y = points
        .iter()
        .flatten()
        .map(|p| p.1)
        .fold(f64::INFINITY, f64::min);
    let max_y = points
        .iter()
        .flatten()
        .map(|p| p.1)
        .fold(f64::NEG_INFINITY, f64::max);
    source_from_chains(&chains, (min_x, max_x), (min_y, max_y))
}

#[test]
fn the_grid_source_gets_a_true_crossing() {
    let chains = grid_source();
    let source = source_from_chains(
        &chains,
        (-2.0 * std::f64::consts::PI, 2.0 * std::f64::consts::PI),
        (-2.0 * std::f64::consts::PI, 2.0 * std::f64::consts::PI),
    );
    let mut source = source;
    repair_source(&mut source);
    assert!(
        source.series.len() != chains.len(),
        "the hooks should be reconstructed: {} -> {}",
        chains.len(),
        source.series.len()
    );
    let points: Vec<Point> = source
        .series
        .iter()
        .flat_map(|series| series.points.clone())
        .collect();
    let junction = (0.0, std::f64::consts::PI);
    assert!(
        points.iter().any(|&point| distance(point, junction) < 0.01),
        "the crossing should meet at one junction"
    );
    assert!(
        !points
            .iter()
            .any(|&point| distance(point, (0.0, 3.2673)) < 0.01),
        "the old rounded hook endpoint should be gone"
    );
}

#[test]
fn the_source_fixture_is_repaired_to_a_fixed_point() {
    let source = padded_source_fixture();
    let raw = source.series.len();
    let mut repaired = source.clone();
    repair_source(&mut repaired);
    assert!(
        repaired.series.len() < raw,
        "the fixture should lose its double hooks: {raw} -> {}",
        repaired.series.len()
    );
    let mut again = repaired.clone();
    repair_source(&mut again);
    assert_eq!(again.series.len(), repaired.series.len());
    for (a, b) in repaired.series.iter().zip(again.series.iter()) {
        assert_eq!(a.points, b.points, "source repair should be idempotent");
    }
}

#[test]
fn the_padded_view_has_no_long_horizontal_bridges() {
    let source = padded_source_fixture();
    assert_eq!(source.series.len(), 34);
    let mut repaired = source;
    repair_source(&mut repaired);
    assert!(
        repaired.series.len() < 34,
        "the padded crossing should actually be reconstructed"
    );
    let after = horizontal_bridges(&repaired.series);
    assert_eq!(after, 0, "all interior horizontal bridges should be gone");
}

#[test]
fn source_and_svg_paths_agree_on_the_same_padded_crossing() {
    let mut source = padded_source_fixture();
    repair_source(&mut source);
    let svg = include_str!("../../../../tests/fixtures/padded_contour.svg");
    let repaired = repair_svg(svg);
    assert_eq!(
        source.series.len(),
        polylines(&repaired).len(),
        "source and SVG should reconstruct the same number of chains"
    );
}

#[test]
fn the_real_padded_svg_is_cleaned_too() {
    let svg = include_str!("../../../../tests/fixtures/padded_contour.svg");
    let repaired = repair_svg(svg);
    assert_ne!(repaired, svg);
    assert!(
        polylines(&repaired).len() < polylines(svg).len(),
        "the SVG should lose its double hooks"
    );
    let lines = polylines(&repaired);
    let all: Vec<Point> = lines.iter().flat_map(|line| line.points.clone()).collect();
    let (min_y, max_y) = all
        .iter()
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| {
            (lo.min(p.1), hi.max(p.1))
        });
    let bridges = lines
        .iter()
        .flat_map(|line| line.points.windows(2))
        .filter(|pair| {
            let y = (pair[0].1 + pair[1].1) * 0.5;
            y > min_y + 10.0
                && y < max_y - 10.0
                && (pair[0].1 - pair[1].1).abs() < 0.05
                && (pair[0].0 - pair[1].0).abs() > 10.0
        })
        .count();
    assert_eq!(bridges, 0, "the SVG should have no interior bridges");
    let twice = repair_svg(&repaired);
    assert!(twice == repaired, "SVG repair should be idempotent");
}

#[test]
fn the_grid_svg_gets_a_true_crossing() {
    let svg = include_str!("../../../../tests/fixtures/singrid.svg");
    let repaired = repair_svg(svg);
    assert_ne!(repaired, svg);
    assert!(
        polylines(&repaired).len() < polylines(svg).len(),
        "the rounded grid hooks should be reconstructed: raw {} repaired {}",
        polylines(svg).len(),
        polylines(&repaired).len()
    );
    assert_eq!(repair_svg(&repaired), repaired);
}

fn horizontal_bridges(chains: &[woxi::syntax::PlotSeriesData]) -> usize {
    let all: Vec<Point> = chains.iter().flat_map(|c| c.points.clone()).collect();
    let (min_y, max_y) = all
        .iter()
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| {
            (lo.min(p.1), hi.max(p.1))
        });
    chains
        .iter()
        .flat_map(|chain| chain.points.windows(2))
        .filter(|pair| {
            let y = (pair[0].1 + pair[1].1) * 0.5;
            y > min_y + 2.0
                && y < max_y - 2.0
                && (pair[0].1 - pair[1].1).abs() < 0.05
                && (pair[0].0 - pair[1].0).abs() > 0.6
        })
        .count()
}
