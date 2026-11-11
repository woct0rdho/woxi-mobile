use super::reset;
use super::{handle_of, layer_grid, payload_range, view_request};
use crate::eval::evaluate_all;
use crate::plot::plot_request;

#[test]
fn a_log_plot_quantizes_in_log_space() {
    reset();
    let items = evaluate_all("LogPlot[Exp[x], {x, 0, 3}]");
    assert!(items.contains("\"ly\":true"), "{items}");
    let grid = layer_grid(&items);
    // The vertical grid is the logarithm of the sampled y range, so a point decodes
    // to log10(y) and the frontend needs no axis knowledge.
    assert!(grid[3] > 0.5 && grid[3] < 2.0, "{grid:?}");
}

#[test]
fn a_filled_plot_sends_its_fill_and_markers() {
    reset();
    let items = evaluate_all("Plot[Sin[x], {x, -5, 5}, Filling -> Axis]");
    assert!(items.contains("\"f\":{\"k\":\"axis\""), "{items}");
    assert!(items.contains("\"o\":0.2"), "{items}");
    // `Bottom`/`Top` are the render's y low/high, which the client resolves against the
    // view it is drawing. Freezing the picture's range here would leave a strip unfilled
    // after a pan. The kind is what travels, not a value.
    reset();
    let bottom = evaluate_all("Plot[Sin[x], {x, -5, 5}, Filling -> Bottom]");
    assert!(bottom.contains("\"f\":{\"k\":\"bottom\""), "{bottom}");
    assert!(
        !bottom.contains("\"f\":{\"k\":\"bottom\",\"v\""),
        "{bottom}"
    );

    // A filled scatter's stems are 0.3 opacity in Woxi, a filled curve's area 0.2.
    reset();
    let stems = evaluate_all("ListPlot[{{0, 0}, {1, 1}, {2, 0.5}}, Filling -> Axis]");
    assert!(stems.contains("\"f\":{\"k\":\"axis\""), "{stems}");
    assert!(stems.contains("\"o\":0.3"), "{stems}");

    // A positive value fill on a log axis is drawable and keeps the plot interactive.
    reset();
    let log_fill = evaluate_all("LogPlot[Exp[x], {x, 0, 1}, Filling -> 5]");
    assert!(log_fill.contains("\"ok\":true"), "{log_fill}");
    assert!(
        log_fill.contains("\"f\":{\"k\":\"value\",\"v\":"),
        "{log_fill}"
    );

    reset();
    let items = evaluate_all("ListPlot[{1, 4, 9}, PlotMarkers -> Automatic]");
    assert!(items.contains("\"sc\":true"), "{items}");
    assert!(items.contains("\"m\":\"circle\""), "{items}");
    // The default automatic circle is 3.49 units on Woxi's 360-unit canvas.
    assert!(items.contains("\"mr\":0.009694"), "{items}");

    // `Automatic` cycles filled and outlined glyphs. The outlined ones must travel as open, even
    // though `PlotMarker::open` is false for the whole Automatic set. Six datasets reach the
    // outlined circle (the sixth glyph).
    reset();
    let outlined =
        evaluate_all("ListPlot[Table[{x, i}, {i, 6}, {x, 1, 3}], PlotMarkers -> Automatic]");
    assert!(outlined.contains("\"mo\":true"), "{outlined}");
}

#[test]
fn a_plot_sends_its_points_in_data_coordinates() {
    reset();
    let items = evaluate_all("Plot[Sin[x], {x, -5, 5}]");
    assert!(items.contains("\"ok\":true"), "{items}");
    assert!(items.contains("\"p\":\""), "{items}");
    let grid = layer_grid(&items);
    // The grid is the extent of the curve itself, in data coordinates.
    assert!((grid[0] + 5.0).abs() < 0.01, "x0 {} in {items}", grid[0]);
    assert!((grid[1] - 5.0).abs() < 0.01, "x1 {} in {items}", grid[1]);
    assert!((grid[2] + 1.0).abs() < 0.01, "y0 {} in {items}", grid[2]);
    assert!((grid[3] - 1.0).abs() < 0.01, "y1 {} in {items}", grid[3]);
}

#[test]
fn the_coverage_is_the_iterators_domain_not_the_picture_range() {
    reset();
    // A `PlotRange` wider than the iterator draws empty space past the sampled domain. The
    // picture's range is the wider one, the samples' coverage the iterator's: reporting the
    // picture range as coverage would claim points the canvas does not have, and a pan into
    // the empty part would never ask for a re-sample.
    let items = evaluate_all("Plot[Sin[x], {x, -5, 5}, PlotRange -> {{-10, 10}, Automatic}]");
    let view = payload_range(&items, "x");
    assert!(
        (view.0 + 10.0).abs() < 0.01 && (view.1 - 10.0).abs() < 0.01,
        "the picture shows {view:?}"
    );
    let coverage = payload_range(&items, "d");
    assert!(
        (coverage.0 + 5.0).abs() < 0.01 && (coverage.1 - 5.0).abs() < 0.01,
        "the samples cover {coverage:?} in {items}"
    );
}

#[test]
fn a_samples_only_reply_describes_no_picture() {
    reset();
    // A re-sample does not replace the picture on screen, so it must not report a range
    // for one: the client writes a reply's range into the markup as "what the picture
    // shows", and a range the picture does not show would be persisted.
    let items = evaluate_all("ContourPlot[x^2 + y^2 == 4, {x, -3, 3}, {y, -3, 3}]");
    let handle = handle_of(&items);
    let reply = plot_request(&view_request("plot_refine", handle, (0.0, 2.0), (0.0, 2.0)));
    assert!(reply.contains("\"status\":\"ok\""), "{reply}");
    assert!(!reply.contains("\"svg\""), "{reply}");
    assert!(!reply.contains("\"dn\":"), "{reply}");
    assert!(!reply.contains("\"u\":"), "{reply}");
    // Neither the range it was asked about nor anything else about a picture.
    assert!(!reply.contains("\"x\":[0,2]"), "{reply}");
    assert!(!reply.contains("\"s\":true"), "{reply}");
    assert!(!reply.contains("\"s\":false"), "{reply}");
    // What it does report is the range the samples cover.
    assert!(reply.contains("\"d\":[-1,3]"), "{reply}");
    assert!(reply.contains("\"dy\":[-1,3]"), "{reply}");
}

#[test]
fn a_two_axis_plot_sends_its_points_unmirrored() {
    reset();
    // Woxi reports a contour's points mirrored in y about the midpoint of the range:
    // for `y = x^2` over [-3,3]^2 the arms come back at y = -3 instead of 3. A canvas
    // drawing them would show a flipped curve (invisible on a circle, which is why
    // it survived until an asymmetric test). `plot_layer` undoes it, so the grid of
    // the point layer is the curve's own extent - y in [0, 3], not [-3, 0].
    let items = evaluate_all("ContourPlot[y - x^2 == 0, {x, -3, 3}, {y, -3, 3}]");
    let grid = layer_grid(&items);
    assert!(
        grid[2] > -0.01 && grid[2] < 0.01,
        "y0 {} in {items}",
        grid[2]
    );
    assert!(grid[2] >= -0.01, "y0 {} in {items}", grid[2]);
    assert!(grid[3] > 2.99, "y1 {} in {items}", grid[3]);
    // A view that was panned keeps the same rule. Its midpoint is not zero. A view
    // frame does not re-sample (the canvas re-projects the points it has), so the
    // padded points come from a re-sample at that view.
    let handle = handle_of(&items);
    let reply = plot_request(&view_request(
        "plot_refine",
        handle,
        (-3.0, 3.0),
        (0.0, 6.0),
    ));
    assert!(reply.contains("\"status\":\"ok\""), "{reply}");
    let grid = layer_grid(&reply);
    // The reply pads its samples by half a view, so the curve runs past the view it
    // was asked for: here up to 9, while the view stops at 6. It also starts at 0,
    // never below (a mirrored curve would be).
    assert!(grid[2] >= -0.01, "y0 {} in {reply}", grid[2]);
    assert!(grid[3] > 6.01, "y1 {} in {reply}", grid[3]);
}

#[test]
fn a_resample_brings_samples_without_a_picture() {
    reset();
    let items = evaluate_all("ContourPlot[y - x^2 == 0, {x, -3, 3}, {y, -3, 3}]");
    let handle = handle_of(&items);
    // A view the curve crosses, so the re-sample has something to draw.
    let reply = plot_request(&view_request("plot_refine", handle, (0.0, 2.0), (0.0, 2.0)));
    assert!(reply.contains("\"status\":\"ok\""), "{reply}");
    // Samples only: the picture keeps the labels the user is looking at, and the
    // canvas redraws the curve from these points.
    assert!(!reply.contains("\"svg\""), "{reply}");
    assert!(reply.contains("\"p\":\""), "{reply}");
    // Half a view of margin, whichever axes the plot samples.
    assert!(reply.contains("\"d\":[-1,3]"), "{reply}");
    assert!(reply.contains("\"dy\":[-1,3]"), "{reply}");
}

#[test]
fn a_two_axis_refine_caps_its_pad_to_an_area() {
    reset();
    let items = evaluate_all("ContourPlot[x^2 + y^2 == 4, {x, -3, 3}, {y, -3, 3}]");
    let handle = handle_of(&items);
    let asked = format!(
            "{{\"msg_type\":\"plot_refine\",\"content\":{{\"handle\":{handle},\"x\":[0,2],\"y\":[0,2],\"pad\":4}}}}"
        );
    let reply = plot_request(&asked);
    // A two-axis re-sample evaluates an area, so the pad is capped at one view.
    assert!(reply.contains("\"d\":[-2,4]"), "{reply}");
    assert!(reply.contains("\"dy\":[-2,4]"), "{reply}");
}

#[test]
fn parametric_plots_densify_instead_of_resampling() {
    reset();
    let items = evaluate_all("ParametricPlot[{Cos[t], Sin[t]}, {t, 0, Pi/2}]");
    let handle = handle_of(&items);
    assert!(items.contains("\"dn\":true"), "{items}");
    assert!(items.contains("\"s\":false"), "{items}");

    let densify = |level: u32| {
        let request = format!(
                "{{\"msg_type\":\"plot_densify\",\"content\":{{\"handle\":{handle},\"level\":{level}}}}}"
            );
        plot_request(&request)
    };
    let shallow = densify(1);
    assert!(shallow.contains("\"status\":\"ok\""), "{shallow}");
    assert!(!shallow.contains("\"svg\""), "{shallow}");
    // More points are the whole point: each level redraws the same domain with more of
    // them (`PlotPoints` 750, then 1500, then the 2000 Woxi clamps a parametric plot to),
    // so the payload of the last level is the largest.
    let deep = densify(3);
    assert!(deep.contains("\"status\":\"ok\""), "{deep}");
    assert!(
        deep.len() > shallow.len(),
        "{} {}",
        deep.len(),
        shallow.len()
    );

    let reply = plot_request(&view_request("plot_refine", handle, (0.0, 1.0), (0.0, 1.0)));
    assert!(reply.contains("UnsupportedPlotRequest"), "{reply}");
}
