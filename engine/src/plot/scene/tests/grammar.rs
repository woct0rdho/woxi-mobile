use super::{numbers_after, scene_of, scene_of_axes};

/// The statements the scene grammar is pinned against: every option that changes the
/// picture's layout or its ink, plus the pictures the scene must refuse.
const GRAMMAR: &[(&str, bool)] = &[
    ("Plot[Sin[x], {x, -5, 5}]", false),
    ("Plot[Sin[x], {x, -5, 5}, Frame -> True]", false),
    (
        "Plot[Sin[x], {x, -5, 5}, Frame -> True, FrameLabel -> {\"time\", \"value\"}]",
        false,
    ),
    (
        "Plot[Sin[x], {x, -5, 5}, AxesLabel -> {\"time\", \"value\"}]",
        false,
    ),
    ("Plot[Sin[x], {x, -5, 5}, PlotLabel -> \"Sine\"]", false),
    ("Plot[Sin[x], {x, -5, 5}, Ticks -> None]", false),
    (
        "Plot[Sin[x], {x, -5, 5}, Ticks -> {{-3, 0, 3}, {-1, 0, 1}}]",
        false,
    ),
    ("Plot[Sin[x], {x, -5, 5}, AspectRatio -> 1/2]", false),
    ("Plot[Sin[x], {x, -5, 5}, AspectRatio -> 1]", false),
    ("Plot[Sin[x], {x, -5, 5}, ImageSize -> {600, 200}]", false),
    (
        "Plot[Sin[x], {x, -5, 5}, PlotStyle -> Directive[Thick, Dashed, Red]]",
        false,
    ),
    (
        "Plot[Sin[x], {x, -5, 5}, GridLines -> Automatic, GridLinesStyle -> Dashed]",
        false,
    ),
    ("Plot[Sin[x], {x, -5, 5}, Filling -> Axis]", false),
    (
        "Plot[Sin[x], {x, -5, 5}, AxesStyle -> {Red, Blue}, TicksStyle -> 14]",
        false,
    ),
    ("LogPlot[Exp[x], {x, -3, 3}]", false),
    ("ContourPlot[x^2 + y^2 == 4, {x, -3, 3}, {y, -3, 3}]", true),
    ("DensityPlot[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}]", false),
    (
        "Plot[Sin[x], {x, -5, 5}, Epilog -> {Red, Disk[{0, 0}, 0.2]}]",
        false,
    ),
];

/// A scene's fingerprint: the numbers the layout is pinned to, rounded so that last-bit
/// differences between machines do not count, and the counts that say which grammar the
/// picture used. A Woxi upgrade that changes the picture grammar or the layout changes this
/// line, and the fixture test says so.
fn fingerprint(statement: &str, two_axis: bool) -> String {
    let Some(json) = scene_of_axes(statement, two_axis) else {
        return "none".to_string();
    };
    let round = |values: Vec<f64>| {
        values
            .iter()
            .map(|value| format!("{:.1}", value))
            .collect::<Vec<_>>()
            .join(",")
    };
    let mut labels: Vec<&str> = Vec::new();
    let mut at = 0;
    while let Some(found) = json[at..].find("\"t\":\"") {
        let start = at + found + 5;
        let end = json[start..]
            .find('"')
            .map(|end| start + end)
            .unwrap_or(start);
        labels.push(&json[start..end]);
        at = end;
    }
    labels.sort_unstable();
    let count = |needle: &str| json.matches(needle).count();
    format!(
            "box={} frame={} rect={} bg={} fs={} lines={} ticks={} labeled={} texts={} dashed={} rotated={} anchors=end:{},middle:{},start:{} labels={}",
            round(numbers_after(&json, "\"box\":[")),
            round(numbers_after(&json, "\"frame\":[")),
            round(numbers_after(&json, "\"rect\":[")),
            json.split("\"bg\":\"").nth(1).and_then(|rest| rest.split('"').next()).unwrap_or("?"),
            if json.contains("\"fs\":{") { "set" } else { "none" },
            json.split("\"lines\":[").nth(1).and_then(|rest| rest.split("],\"ticks\":").next()).map_or(0, |rest| rest.matches("\"w\":").count()),
            count("\"o\":\""),
            count("\"l\":{"),
            json.split("\"texts\":[").nth(1).map_or(0, |rest| rest.matches("\"x\":").count()),
            count("\"d\":["),
            count("\"r\":{"),
            count("\"a\":\"end\""),
            count("\"a\":\"middle\""),
            count("\"a\":\"start\""),
            labels.join("|")
        )
}

/// Woxi's picture grammar is what the scene reads; when Woxi changes it, the fingerprints
/// change. `WOXI_UPDATE_FIXTURES=1 cargo test --profile fast the_scene_grammar_matches_the_fixture`
/// rewrites the file, so the diff is reviewed rather than silently absorbed.
#[test]
fn the_scene_grammar_matches_the_fixture() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/scenes.txt");
    let produced: String = GRAMMAR
        .iter()
        .map(|(statement, two_axis)| {
            format!("{statement}\n  {}\n", fingerprint(statement, *two_axis))
        })
        .collect();
    if std::env::var("WOXI_UPDATE_FIXTURES").is_ok() {
        std::fs::write(path, &produced).expect("write fixture");
        // One whole scene, for the client's test: the field names the canvas reads are a
        // contract between the two languages, and a rename on either side must fail a test.
        let sample = "Plot[Sin[x], {x, -5, 5}, Frame -> True, FrameLabel -> {\"time\", \"value\"}, GridLines -> Automatic, GridLinesStyle -> Dashed]";
        let scene = scene_of(sample).expect("sample scene");
        std::fs::write(
            concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/scene.json"),
            format!("{scene}\n"),
        )
        .expect("write scene fixture");
        return;
    }
    let expected = std::fs::read_to_string(path).expect("read fixture");
    assert_eq!(produced.trim_end(), expected.trim_end());
}
