use super::reset;
use crate::eval::evaluate_all;
use crate::plot::plot_request;

#[test]
fn a_picture_the_scene_cannot_express_is_not_interactive() {
    // One mechanism: an interactive plot is drawn by the client from a scene, so a picture
    // the scene cannot express gets no handle at all and stays a still picture. Mesh marks,
    // a marker drawn as text, a log axis whose data leaves the grid, and user `Graphics`
    // are all in that set.
    for statement in [
        "Plot[Sin[x], {x, -5, 5}, Mesh -> Full]",
        "ListPlot[{{1, 1}, {2, 4}}, PlotMarkers -> \"\u{2605}\"]",
        "LogPlot[x - 3, {x, 0.1, 5}]",
        "Graphics[{Circle[{0, 0}, 1]}]",
    ] {
        reset();
        let items = evaluate_all(statement);
        assert!(items.contains("\"svg\""), "{statement}: {items}");
        assert!(!items.contains("\"plot\""), "{statement}: {items}");
        assert!(!items.contains("\"data\""), "{statement}: {items}");
    }
}

#[test]
fn a_plot_inside_a_module_is_cached_only() {
    reset();
    let items = evaluate_all("Module[{y = 2}, Plot[y x, {x, 0, 1}]]");
    assert!(items.contains("\"plot\""), "{items}");
    assert!(items.contains("\"s\":false"), "{items}");
    // Its points are in data space, so the canvas gets them (see `Sampling`): a
    // one-axis plot is cropped correctly whether or not its call can be re-run.
    assert!(items.contains("\"ok\":true"), "{items}");
}

#[test]
fn a_plot_the_statement_does_not_classify_stays_a_picture() {
    reset();
    // A field plot is re-rendered by evaluating its call. `Show` re-renders the primitives
    // Woxi stored, and those are mirrored, so a crop of one comes back upside down.
    // Without the call there is nothing to evaluate, so the picture keeps its own view.
    let items = evaluate_all("Module[{}, ContourPlot[y - x^2 == 0, {x, -3, 3}, {y, -3, 3}]]");
    assert!(!items.contains("\"plot\""), "{items}");
    assert!(items.contains("\"svg\":\"<svg"), "{items}");

    // The same goes for a picture no plot head mentions: nothing says whether its points
    // are mirrored, or which way a crop would draw them.
    reset();
    evaluate_all("f[] := Plot[Sin[x], {x, -5, 5}]");
    let items = evaluate_all("f[]");
    assert!(!items.contains("\"plot\""), "{items}");
    assert!(items.contains("\"svg\":\"<svg"), "{items}");
}

#[test]
fn a_picture_built_from_primitives_stays_still() {
    reset();
    // A region plot inks less than the range it was laid out at and a user `Graphics` states
    // no ticks, so neither has a scene: they are pictures, not interactive plots.
    for statement in [
        "RegionPlot[x^2 + y^2 < 4, {x, -3, 3}, {y, -3, 3}]",
        "Graphics[{Circle[{0, 0}, 1]}]",
    ] {
        reset();
        let items = evaluate_all(statement);
        assert!(items.contains("\"svg\""), "{statement}: {items}");
        assert!(!items.contains("\"plot\""), "{statement}: {items}");
    }
}

#[test]
fn a_contour_with_cleaned_crossings_still_registers() {
    reset();
    let items = evaluate_all("ContourPlot[Sin[x] == Cos[y], {x, -2 Pi, 2 Pi}, {y, -2 Pi, 2 Pi}]");
    assert!(items.contains("\"plot\""), "{items}");
    assert!(items.contains("\"data\":"), "{items}");
    assert!(items.contains("\"ok\":true"), "{items}");
}

#[test]
fn region_and_list_contours_get_cleanup() {
    for statement in [
        "ContourPlot[Sin[x] == Cos[y], {x, -2 Pi, 2 Pi}, {y, -2 Pi, 2 Pi}, RegionFunction -> Function[{x, y, z}, x^2 + y^2 < 16]]",
        "ListContourPlot[Table[Sin[i/10] Cos[j/10], {i, 0, 20}, {j, 0, 20}]]",
        "ContourPlot[Sin[x] == Cos[y], {x, -2 Pi, 2 Pi}, {y, -2 Pi, 2 Pi}, PlotRangePadding -> Scaled[0.1]]",
        "Show[ContourPlot[Sin[x] == Cos[y], {x, -2 Pi, 2 Pi}, {y, -2 Pi, 2 Pi}], Frame -> False]",
    ] {
        reset();
        let items = evaluate_all(statement);
        assert!(items.contains("\"svg\""), "{statement}: {items}");
        assert!(
            items.contains("data-woxi-contour-cell"),
            "{statement} should carry the measured cell: {items}"
        );
    }
}

#[test]
fn unknown_messages_are_reported() {
    let reply = plot_request("{\"msg_type\":\"plot_dance\"}");
    assert!(reply.contains("\"status\":\"error\""), "{reply}");
    assert!(reply.contains("UnknownMessage"), "{reply}");
}
