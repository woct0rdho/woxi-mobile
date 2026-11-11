use super::reset;
use super::{
    frame_extent, frame_size, handle_of, payload_range, picture_rect, scene_frame, view_request,
};
use crate::eval::evaluate_all;
use crate::plot::plot_request;

#[test]
fn view_refine_and_release() {
    reset();
    let items = evaluate_all("Plot[Sin[x], {x, 0, 1}]");
    let handle = handle_of(&items);

    let reply = plot_request(&view_request("plot_view", handle, (0.2, 0.4), (-0.5, 0.5)));
    assert!(reply.contains("\"status\":\"ok\""), "{reply}");
    assert!(reply.contains("\"svg\":\"<svg"), "{reply}");

    let reply = plot_request(&view_request(
        "plot_refine",
        handle,
        (0.2, 0.4),
        (-0.5, 0.5),
    ));
    assert!(reply.contains("\"status\":\"ok\""), "{reply}");
    // Coverage is the padded view: half a view width on each side.
    assert!(reply.contains("\"d\":[0.1,"), "{reply}");

    let released = format!("{{\"msg_type\":\"plot_release\",\"content\":{{\"handle\":{handle}}}}}");
    assert!(plot_request(&released).contains("\"status\":\"ok\""));
    let release = format!("{{\"msg_type\":\"plot_release\",\"content\":{{\"handle\":{handle}}}}}");
    assert!(plot_request(&release).contains("\"status\":\"ok\""));
    let reply = plot_request(&view_request("plot_view", handle, (0.2, 0.4), (-0.5, 0.5)));
    assert!(reply.contains("ExpiredHandle"), "{reply}");
}

#[test]
fn a_log_axis_view_through_zero_still_draws_a_frame() {
    reset();
    // A view that reaches zero on a log axis cannot be drawn (Woxi answers with an
    // axis-less SVG), so the engine moves the bound instead of passing it on, and the
    // reply reports the repaired range for the client to continue from.
    let items = evaluate_all("LogPlot[Exp[x], {x, -5, 5}]");
    let handle = handle_of(&items);
    let reply = plot_request(&view_request(
        "plot_view",
        handle,
        (-5.0, 5.0),
        (0.0, 258.0),
    ));
    assert!(reply.contains("\"status\":\"ok\""), "{reply}");
    let frame = frame_extent(&reply);
    assert!(frame[2] - frame[0] > 3000.0, "{frame:?}: {reply}");
    let (y0, y1) = payload_range(&reply, "y");
    assert!(y0 > 0.0 && y1 > y0, "{y0} {y1}");
}

#[test]
fn a_log_axis_is_resampled_in_decades() {
    reset();
    // Half a view beyond `{1, 100}` is one decade on each side. Padded linearly it would
    // be `{-50, 150}`, whose lower bound has no logarithm: the evaluation fails and the
    // client latches `resampleOff`, so the plot never re-samples again (measured on the
    // emulator). Woxi pads its own log range the same way it is padded here.
    let items = evaluate_all("LogLinearPlot[x, {x, 1, 100}]");
    let handle = handle_of(&items);
    let reply = plot_request(&view_request(
        "plot_refine",
        handle,
        (1.0, 100.0),
        (0.0, 1.0),
    ));
    assert!(reply.contains("\"status\":\"ok\""), "{reply}");
    let (low, high) = payload_range(&reply, "d");
    assert!((low - 0.1).abs() < 1e-6, "{low} {high}");
    assert!((high - 1000.0).abs() < 1e-3, "{low} {high}");
}

#[test]
fn a_crop_maps_its_range_onto_the_frame() {
    reset();
    // A one-axis picture is a `Show` crop: the renderer draws the axes at the requested
    // range and clips the curve to them, so the frame is the data rectangle. The scene
    // reports both, and they have to agree - that is what lets the client draw the series,
    // the ticks and the labels from one map.
    let items = evaluate_all("Plot[x, {x, -8, 8}]");
    let handle = handle_of(&items);
    let reply = plot_request(&view_request("plot_view", handle, (-4.0, 4.0), (-4.0, 4.0)));
    assert!(reply.contains("\"status\":\"ok\""), "{reply}");
    assert_eq!(picture_rect(&reply), scene_frame(&reply), "{reply}");
}

#[test]
fn a_view_carries_no_samples() {
    reset();
    let items = evaluate_all("Plot[Sin[x], {x, -5, 5}]");
    let handle = handle_of(&items);
    let reply = plot_request(&view_request("plot_view", handle, (0.0, 1.0), (-1.0, 1.0)));
    assert!(reply.contains("\"status\":\"ok\""), "{reply}");
    // Samples travel with the evaluation (or a re-sample), never with a view: the canvas
    // keeps the points it has, and a gesture frame is one scene, not a payload.
    assert!(!reply.contains("\"data\""), "{reply}");
}

#[test]
fn a_refine_uses_the_pad_it_is_given_and_clamps_it() {
    reset();
    let items = evaluate_all("Plot[Sin[x], {x, -5, 5}]");
    let handle = handle_of(&items);
    let refine = |pad: f64| {
        plot_request(&format!(
                "{{\"msg_type\":\"plot_refine\",\"content\":{{\"handle\":{handle},\"x\":[-2,2],\"y\":[-1,1],\"pad\":{pad}}}}}"
            ))
    };
    // A two-view pad: four view units on each side.
    let two = refine(2.0);
    assert!(two.contains("\"d\":[-10,10]"), "{two}");
    // The default (no pad) is the engine's half view.
    let half = plot_request(&view_request(
        "plot_refine",
        handle,
        (-2.0, 2.0),
        (-1.0, 1.0),
    ));
    assert!(half.contains("\"d\":[-4,4]"), "{half}");
    // The request is clamped to the engine's maximum (four views).
    let wide = refine(100.0);
    assert!(wide.contains("\"d\":[-18,18]"), "{wide}");
}

#[test]
fn a_two_axis_view_is_the_plot_evaluated_at_the_view() {
    reset();
    let items = evaluate_all("ContourPlot[x^2 + y^2 == 4, {x, -3, 3}, {y, -3, 3}]");
    let handle = handle_of(&items);
    // The picture as it was drawn is square: a 3436x3436 data area.
    let (width, height) = frame_size(&items);
    assert!((width - height).abs() < 1.0, "{items}");
    let reply = plot_request(&view_request("plot_view", handle, (-2.0, 2.0), (-2.0, 2.0)));
    assert!(reply.contains("\"status\":\"ok\""), "{reply}");
    // A crop lays a two-axis picture out again at another shape: the same six units
    // of y came back 3465 units tall for one range and 2842 for the next, which put
    // the curve somewhere other than the axes drawn over it. Evaluating at the view
    // keeps the data area the shape the plot type asks for.
    let (width, height) = frame_size(&reply);
    assert!((width - height).abs() < 1.0, "{width}x{height}: {reply}");
    // The samples are the ones the last re-sample stored: the range the picture was
    // registered at, so [-3,3] for a [-3,3] picture, not the view's own. A view frame does
    // not evaluate the plot a second time for points, so the coverage it reports is the
    // coverage the canvas is drawing from.
    assert!(reply.contains("\"d\":[-3,3]"), "{reply}");
    assert!(reply.contains("\"dy\":[-3,3]"), "{reply}");
}

#[test]
fn a_two_axis_view_keeps_the_coverage_it_has() {
    reset();
    let items = evaluate_all("ContourPlot[x^2 + y^2 == 4, {x, -3, 3}, {y, -3, 3}]");
    let handle = handle_of(&items);
    let reply = plot_request(&view_request("plot_view", handle, (-2.0, 2.0), (-2.0, 2.0)));
    assert!(reply.contains("\"status\":\"ok\""), "{reply}");
    // The picture is the view's, so its labels are the view's.
    let (width, height) = frame_size(&reply);
    assert!((width - height).abs() < 1.0, "{width}x{height}");
    // The samples stay the ones the last evaluation stored. A view costs one evaluation,
    // not two, and the coverage does not move under the client.
    assert!(reply.contains("\"d\":[-3,3]"), "{reply}");
    assert!(reply.contains("\"dy\":[-3,3]"), "{reply}");
    assert!(!reply.contains("\"data\""), "{reply}");
    // A re-sample at the view is what moves the coverage, and it pads the same way.
    let refined = plot_request(&view_request(
        "plot_refine",
        handle,
        (-2.0, 2.0),
        (-2.0, 2.0),
    ));
    assert!(refined.contains("\"d\":[-4,4]"), "{refined}");
    assert!(refined.contains("\"dy\":[-4,4]"), "{refined}");
}
