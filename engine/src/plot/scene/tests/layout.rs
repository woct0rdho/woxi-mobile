use super::super::build::frame_side_of;
use super::{numbers_after, scene_at, scene_of, scene_of_axes, ticks_of};

#[test]
fn a_simple_plot_has_a_frame_data_ticks_and_labels() {
    let json = scene_of("Plot[Sin[x], {x, -5, 5}]").expect("scene");
    assert!(json.contains("\"frame\":["), "{json}");
    assert!(json.contains("\"rect\":["), "{json}");
    assert!(json.contains("\"-4\""), "{json}");
    assert!(json.contains("\"o\":\"x\""), "{json}");
    assert!(json.contains("\"l\":{"), "{json}");
}

#[test]
fn a_framed_contour_has_its_frame_style_and_ticks_on_both_sides() {
    let json =
        scene_of_axes("ContourPlot[x^2 + y^2 == 4, {x, -3, 3}, {y, -3, 3}]", true).expect("scene");
    assert!(json.contains("\"fs\":"), "{json}");
    assert!(json.contains("\"o\":\"y\""), "{json}");
    assert!(json.contains("\"a\":\"end\""), "{json}");
}

#[test]
fn a_log_plot_quantizes_its_ticks_in_the_drawing_space() {
    let json = scene_of("LogPlot[Exp[x], {x, -3, 3}]").expect("scene");
    // The y ticks carry log-space values, because that is the space the samples are in: the
    // tick labeled 0.05 sits at log10(0.05), not at 0.05 (and not at its magnitude).
    let ticks = ticks_of(&json);
    let tick = ticks
        .iter()
        .find(|tick| tick.contains("\"t\":\"0.05\""))
        .expect("a tick labeled 0.05");
    let value: f64 = tick
        .split("\"v\":")
        .nth(1)
        .expect("a value")
        .split(',')
        .next()
        .expect("a number")
        .parse()
        .expect("parses");
    assert!(
        (value - 0.05f64.log10()).abs() < 1e-3,
        "{value} is not log10(0.05) in {tick}"
    );
    assert!(value < 0.0, "a value below 1 is a negative decade: {tick}");
}

#[test]
fn a_framed_plot_draws_its_frame_from_a_closed_polyline() {
    let json = scene_of("Plot[Sin[x], {x, -5, 5}, Frame -> True]").expect("framed scene");
    // The frame is one closed polyline, which the scene has to take as the frame rect - the
    // picture has no <rect> for it. Both sides carry ticks, and the labels sit outside it.
    assert!(json.contains("\"fs\":{\"c\":\"#666666\""), "{json}");
    assert!(json.contains("\"a\":\"end\""), "{json}");
    assert!(json.contains("\"a\":\"middle\""), "{json}");
    assert!(json.contains("\"box\":["), "{json}");
}

#[test]
fn a_frame_keeps_its_shape_when_its_color_is_a_series_color() {
    // The default series color is the frame's, if the user asks for it. The closed-rect
    // shape, not the color, is what identifies the frame.
    let json =
        scene_of("Plot[Sin[x], {x, -5, 5}, Frame -> True, FrameStyle -> RGBColor[0.24, 0.6, 0.8]]")
            .expect("scene");
    assert!(json.contains("\"fs\":"), "{json}");
    assert!(json.contains("\"frame\":["), "{json}");
}

#[test]
fn a_frame_tick_stays_on_the_edge_the_option_put_it() {
    // `FrameTicks` chooses the edge. Woxi prints that edge's labels outside it. The scene has
    // to keep each tick on its own edge and each label on its own side - it is the only
    // record of which side a frame label belongs to, so a client that guessed left/bottom
    // would draw the right and top labels over the plot.
    let json = scene_of(
        "Plot[Sin[x], {x, -5, 5}, Frame -> True, FrameTicks -> {{None, All}, {None, All}}]",
    )
    .expect("scene");
    let frame = numbers_after(&json, "\"frame\":[");
    let (left, top, width, height) = (frame[0], frame[1], frame[2], frame[3]);
    // A tick's base sits on the frame's inner edge: half the frame's stroke inside the rect.
    let on_edge = |base: f64, edge: f64| (base - edge).abs() < 15.0;
    let mut above = 0;
    let mut beside = 0;
    for tick in ticks_of(&json) {
        if !tick.contains("\"l\":{") {
            continue;
        }
        let base: f64 = tick
            .split("\"b\":")
            .nth(1)
            .expect("a base")
            .split(',')
            .next()
            .expect("a number")
            .parse()
            .expect("parses");
        if tick.contains("\"o\":\"x\"") {
            assert!(on_edge(base, top), "an x tick on the top edge: {tick}");
            assert!(
                tick.contains("\"s\":\"t\""),
                "the top edge travels with the tick: {tick}"
            );
            let dy: f64 = tick
                .split("\"l\":{")
                .nth(1)
                .and_then(|label| label.split("\"dy\":").nth(1))
                .and_then(|value| value.split(',').next())
                .and_then(|value| value.parse().ok())
                .expect("a label offset");
            assert!(dy < 0.0, "a top label above its edge: {tick}");
            above += 1;
        } else {
            assert!(
                on_edge(base, left + width),
                "a y tick on the right edge: {tick}"
            );
            assert!(
                tick.contains("\"s\":\"r\""),
                "the right edge travels with the tick: {tick}"
            );
            let dx: f64 = tick
                .split("\"l\":{")
                .nth(1)
                .and_then(|label| label.split("\"dx\":").nth(1))
                .and_then(|value| value.split(',').next())
                .and_then(|value| value.parse().ok())
                .expect("a label offset");
            assert!(dx > 0.0, "a right label right of its edge: {tick}");
            beside += 1;
        }
    }
    assert!(above > 0, "labeled ticks above the frame: {json}");
    assert!(beside > 0, "labeled ticks beside the frame: {json}");
    assert!(height > 0.0, "a frame with a height: {json}");
}

#[test]
fn a_static_label_is_not_taken_for_a_tick_label() {
    // A FrameLabel sits about 2.5 em under its axis, a PlotLabel about 2.3 em above the frame,
    // and both are centered over the tick at 0. If the attach band were wider than that, the
    // label would become that tick's label: it would move with the data on a pan and vanish
    // when the tick leaves the view, instead of staying where the renderer put it.
    let framed =
        scene_of("Plot[Sin[x], {x, -5, 5}, Frame -> True, FrameLabel -> {\"time\", \"value\"}]")
            .expect("scene");
    assert!(framed.contains("\"t\":\"time\",\"x\":"), "{framed}");
    assert!(framed.contains("\"t\":\"value\",\"x\":"), "{framed}");
    assert!(!framed.contains("\"l\":{\"t\":\"time\""), "{framed}");
    assert!(!framed.contains("\"l\":{\"t\":\"value\""), "{framed}");
    // The tick at 0 keeps its own label, so moving the axis still moves a number.
    assert!(framed.contains("\"l\":{\"t\":\"0\""), "{framed}");

    let titled = scene_of(
        "Plot[Sin[x], {x, -5, 5}, Frame -> True, FrameTicks -> All, PlotLabel -> \"Title\"]",
    )
    .expect("scene");
    assert!(titled.contains("\"t\":\"Title\",\"x\":"), "{titled}");
    assert!(!titled.contains("\"l\":{\"t\":\"Title\""), "{titled}");

    // An AxesLabel has the wrong anchor to be a tick label, so it stays a text.
    let axes = scene_of("Plot[Sin[x], {x, -5, 5}, AxesLabel -> {\"x\", \"y\"}]").expect("scene");
    assert!(axes.contains("\"t\":\"x\",\"x\":"), "{axes}");
    assert!(!axes.contains("\"l\":{\"t\":\"x\""), "{axes}");
}

#[test]
fn a_frame_side_accounts_for_the_stroke() {
    // A frame's stroke is centered on its outline, so a tick can start half a stroke inside the
    // rectangle. The edge still has to be found: the client keeps the label's band there.
    let frame = [0.0, 0.0, 1000.0, 1000.0];
    assert_eq!(frame_side_of(frame, 10.0, 4.0, false), Some('l'));
    assert_eq!(frame_side_of(frame, 10.0, 996.0, false), Some('r'));
    assert_eq!(frame_side_of(frame, 10.0, 4.0, true), Some('t'));
    assert_eq!(frame_side_of(frame, 10.0, 996.0, true), Some('b'));
    assert_eq!(frame_side_of(frame, 10.0, 20.0, false), None);
    // A thicker stroke reaches further inside.
    assert_eq!(frame_side_of(frame, 100.0, 45.0, false), Some('l'));
    assert_eq!(frame_side_of(frame, 0.0, 45.0, false), None);
}

#[test]
fn a_frame_label_keeps_the_quarter_turn_the_renderer_gave_it() {
    let json =
        scene_of("Plot[Sin[x], {x, -5, 5}, Frame -> True, FrameLabel -> {\"time\", \"value\"}]")
            .expect("scene");
    assert!(json.contains("\"t\":\"time\""), "{json}");
    assert!(json.contains("\"t\":\"value\""), "{json}");
    // The y label is rotated about its anchor, so drawing it unrotated would put it across
    // the frame instead of beside it.
    assert!(json.contains("\"r\":{\"a\":-90"), "{json}");
    // An unlabeled frame is not rotated: the x label stays a plain text.
    let plain = scene_of("Plot[Sin[x], {x, -5, 5}, Frame -> True, FrameLabel -> {\"time\", None}]")
        .expect("scene");
    assert!(!plain.contains("\"r\":"), "{plain}");
}

#[test]
fn ticks_none_leaves_the_axes_as_the_frame() {
    let json = scene_of("Plot[Sin[x], {x, -5, 5}, Ticks -> None]").expect("scene");
    assert!(!json.contains("\"l\":{"), "{json}");
    assert!(json.contains("\"frame\":["), "{json}");
}

#[test]
fn custom_ticks_take_their_texts_from_the_picture() {
    let json = scene_of(
            "Plot[Sin[x], {x, -5, 5}, Ticks -> {{{-5, \"-five\"}, {0, \"zero\"}, {5, \"five\"}}, Automatic}]",
        )
        .expect("scene");
    assert!(json.contains("-five"), "{json}");
    assert!(json.contains("\"l\":{"), "{json}");
}

#[test]
fn a_dashed_grid_line_keeps_its_pattern() {
    let json =
        scene_of("Plot[Sin[x], {x, -5, 5}, GridLines -> Automatic, GridLinesStyle -> Dashed]")
            .expect("scene");
    assert!(
        json.contains("\"lines\":[{}") || json.contains("\"d\":["),
        "{json}"
    );
    assert!(json.contains("\"d\":["), "{json}");
}

#[test]
fn an_explicit_aspect_ratio_keeps_its_frame_shape() {
    for (statement, ratio) in [
        ("Plot[Sin[x], {x, -5, 5}, AspectRatio -> 1/2]", 0.5),
        ("Plot[Sin[x], {x, -5, 5}, AspectRatio -> 1]", 1.0),
    ] {
        let json = scene_of(statement).expect("scene");
        let frame = numbers_after(&json, "\"frame\":[");
        assert_eq!(frame.len(), 4, "{json}");
        let measured = frame[3] / frame[2];
        assert!(
            (measured - ratio).abs() < 0.01,
            "{statement}: frame {frame:?} is not {ratio}"
        );
        // The picture's own viewBox is what the card is pinned to, so it has to travel.
        let box_of = numbers_after(&json, "\"box\":[");
        assert!(box_of[2] > 0.0 && box_of[3] > 0.0, "{json}");
    }
}

#[test]
fn an_axes_origin_reads_each_coordinate_on_its_own() {
    // Woxi resolves an `Automatic` coordinate on its own (0, or the low edge when 0 is out of
    // range). Requiring both coordinates to be literals used to drop the numeric one next to an
    // automatic one, drawing the axis at 0 instead of where the user asked.
    let json = scene_of("Plot[Sin[x], {x, -5, 5}, AxesOrigin -> {Automatic, 0.5}]").expect("scene");
    assert!(json.contains("\"o\":\"y\",\"v\":0.5"), "{json}");
    let json = scene_of("Plot[Sin[x], {x, -5, 5}, AxesOrigin -> {0.5, Automatic}]").expect("scene");
    assert!(json.contains("\"o\":\"x\",\"v\":0.5"), "{json}");
}

#[test]
fn a_crossing_axis_ticks_hang_off_its_line() {
    // The axes cross inside the frame: their ticks hang off a value line (kind `a`), which is
    // what the client clamps and positions. The line itself is marked as an axis.
    let json = scene_of("Plot[Sin[x], {x, -5, 5}]").expect("scene");
    assert!(json.contains("\"k\":\"a\""), "{json}");
    let ticks = ticks_of(&json);
    assert!(
        ticks.iter().all(|tick| tick.contains("\"k\":\"a\"")),
        "{json}"
    );
    // The axes are in `lines` with the same kind.
    let lines = json.split("\"lines\":[").nth(1).expect("lines");
    let lines = lines.split("],\"ticks\":").next().expect("lines end");
    assert!(lines.contains("\"k\":\"a\""), "{json}");
}

#[test]
fn a_pinned_axis_keeps_its_ticks_on_the_line() {
    // x = 0 is left of this view, so the renderer pins the y axis to the frame's left edge.
    // Its ticks still hang off that line (kind `a`). The client clamps the line and takes the
    // ticks with it.
    let json = scene_at("Plot[Sin[x], {x, -5, 5}]", ((4.0, 6.0), (-1.1, 1.1)))
        .expect("scene at a view through positive x");
    let ticks = ticks_of(&json);
    let y: Vec<&str> = ticks
        .iter()
        .copied()
        .filter(|tick| tick.contains("\"o\":\"y\""))
        .collect();
    assert!(
        !y.is_empty() && y.iter().all(|tick| tick.contains("\"k\":\"a\"")),
        "{json}"
    );
    let x: Vec<&str> = ticks
        .iter()
        .copied()
        .filter(|tick| tick.contains("\"o\":\"x\""))
        .collect();
    assert!(x.iter().all(|tick| tick.contains("\"k\":\"a\"")), "{json}");
}

#[test]
fn a_log_axis_line_is_an_axis_like_any_other() {
    // A log axis has no zero to cross at: the renderer puts the other axis at the low end of
    // the range. Both axes carry their ticks on their line (kind `a`). The client's log rule
    // keeps that line on the low rail.
    let json = scene_of("LogPlot[Exp[x], {x, -3, 3}]").expect("log scene");
    let ticks = ticks_of(&json);
    assert!(
        ticks.iter().all(|tick| tick.contains("\"k\":\"a\"")),
        "{json}"
    );
    let lines = json.split("\"lines\":[").nth(1).expect("lines");
    let lines = lines.split("],\"ticks\":").next().expect("lines end");
    assert!(lines.contains("\"k\":\"a\""), "{json}");
}

#[test]
fn a_framed_plot_hangs_its_ticks_off_the_frame() {
    let json = scene_of("Plot[Sin[x], {x, -5, 5}, Frame -> True]").expect("framed scene");
    let ticks = ticks_of(&json);
    assert!(
        ticks.iter().all(|tick| tick.contains("\"k\":\"f\"")),
        "{json}"
    );
    let lines = json.split("\"lines\":[").nth(1).expect("lines");
    let lines = lines.split("],\"ticks\":").next().expect("lines end");
    assert!(!lines.contains("\"k\":\"a\""), "{json}");
}

#[test]
fn an_axis_line_reports_its_origin_not_its_drawn_position() {
    // `{x, 1, 3}` excludes 0: Woxi draws the y axis on the range's edge, but the line still
    // carries the origin (0). A client drawing it at a moved view then clamps it to the rail
    // instead of jumping to the edge of the picture that was rendered earlier, and the same
    // value keeps every one of the four sides stable.
    let json = scene_of("Plot[Sin[x], {x, 1, 3}]").expect("scene");
    assert!(
        json.contains("\"o\":\"x\",\"v\":0"),
        "the y axis carries 0: {json}"
    );
    assert!(
        json.contains("\"o\":\"y\",\"v\":0"),
        "the x axis carries 0: {json}"
    );

    // An explicit origin inside the range is its own value, not a boundary.
    let explicit = scene_of("Plot[Sin[x], {x, 0.5, 2.5}, AxesOrigin -> {1, 0}]").expect("scene");
    assert!(explicit.contains("\"o\":\"x\",\"v\":1"), "{explicit}");

    // A crop that includes the origin reports the same value. Nothing about the axis line
    // depends on the range the picture was drawn at.
    let cropped =
        scene_at("Plot[Sin[x], {x, 1, 3}]", ((-0.5, 0.5), (0.2, 1.0))).expect("cropped scene");
    assert!(cropped.contains("\"o\":\"x\",\"v\":0"), "{cropped}");
}
