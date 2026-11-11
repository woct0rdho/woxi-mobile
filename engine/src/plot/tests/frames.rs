use super::reset;
use super::{drawn_extent, frame_ratio, handle_of, picture_rect, scene_frame, view_request};
use crate::eval::evaluate_all;
use crate::plot::plot_request;

#[test]
fn a_crop_keeps_the_frame_aspect() {
    reset();
    // A parametric plot's picture is square, while its source's `image_size` says
    // 360x225 (a default, not the picture): a crop told that would come back 1.6:1 and
    // the circle would be an ellipse. The shape has to come from the picture's own
    // frame, which is what the client measures and sends with the view.
    let items = evaluate_all("ParametricPlot[{Cos[3 t], Sin[2 t]}, {t, 0, 2 Pi}]");
    let handle = handle_of(&items);
    let before = frame_ratio(&items);
    assert!((before - 1.0).abs() < 0.01, "{before}");
    let asked = format!(
            "{{\"msg_type\":\"plot_view\",\"content\":{{\"handle\":{handle},\"x\":[-0.36,0.36],\"y\":[-0.36,0.36],\"aspect\":{before}}}}}"
        );
    let reply = plot_request(&asked);
    assert!(reply.contains("\"status\":\"ok\""), "{reply}");
    let after = frame_ratio(&reply);
    assert!((after - before).abs() < 0.01, "{after} {before}: {reply}");
    // Without the measurement, the crop falls back to what it was told before. With
    // none at all it would be laid out at `Show`'s own default shape.
    assert!(after > 0.9, "{after}");
}

#[test]
fn a_two_axis_view_keeps_the_frame_aspect() {
    reset();
    // A two-axis picture is evaluated at the view by rewriting the user's call, so an
    // `AspectRatio` the user wrote survives, and Woxi's own choice for a contour is a
    // square whatever the range is. Both were measured at two ranges before this was
    // written down.
    let items =
        evaluate_all("ContourPlot[x^2 + y^2 == 4, {x, -3, 3}, {y, -3, 3}, AspectRatio -> 1/2]");
    let handle = handle_of(&items);
    assert!(
        (frame_ratio(&items) - 0.5).abs() < 0.01,
        "{}",
        frame_ratio(&items)
    );
    let reply = plot_request(&view_request("plot_view", handle, (-3.0, 3.0), (0.0, 3.0)));
    assert!(reply.contains("\"status\":\"ok\""), "{reply}");
    let after = frame_ratio(&reply);
    assert!((after - 0.5).abs() < 0.01, "{after}: {reply}");
}

#[test]
fn a_two_axis_picture_reports_where_its_data_rect_sits() {
    reset();
    // Woxi's field layout draws the frame outside the data, so the frame's rectangle is
    // not the data area. The payload carries the data range in the picture's own units,
    // fitted from the curves, and it has to be the inset one.
    let items = evaluate_all("ContourPlot[x^2 + y^2 == 4, {x, -3, 3}, {y, -3, 3}]");
    let rect = picture_rect(&items);
    let width = rect[2] - rect[0];
    assert!((3200.0..3400.0).contains(&width), "{rect:?}");
    assert!(rect[0] > 200.0 && rect[0] < 240.0, "{rect:?}");
    // `u[1]` belongs to the lowest data y, which is the largest user y: the picture's
    // y axis grows downward. A mirrored fit would put it the other way round.
    assert!(rect[1] > rect[3], "{rect:?}");

    // A one-axis plot draws its axes over the range it was given, so the frame is the data
    // area. The scene reports the same rectangle for both.
    reset();
    let items = evaluate_all("Plot[Sin[x], {x, -5, 5}]");
    assert_eq!(picture_rect(&items), scene_frame(&items), "{items}");
}

#[test]
fn a_two_axis_rect_agrees_with_the_drawn_curve() {
    reset();
    // An asymmetric range, where a mirror taken about the wrong point shows up: `y - x^2`
    // over y in [0,6] is a parabola whose vertex is the bottom of the picture. `u[1]` is
    // the user y of data y = 0, so it has to land on the lowest drawn point, and `u[3]`
    // (data y = 6) on the highest.
    let items = evaluate_all("ContourPlot[y - x^2 == 0, {x, -3, 3}, {y, 0, 6}]");
    let rect = picture_rect(&items);
    let drawn = drawn_extent(&items);
    assert!(rect[1] > rect[3], "{rect:?} {drawn:?}");
    // The curve has to reach both ends of its range to be comparable, and the sampler
    // does not hit the vertex exactly, so the tolerance is a few units of 3400.
    assert!((rect[1] - drawn[3]).abs() < 40.0, "{rect:?} {drawn:?}");
    assert!((rect[3] - drawn[1]).abs() < 40.0, "{rect:?} {drawn:?}");
    let span = rect[1] - rect[3];
    assert!(
        (span - (drawn[3] - drawn[1])).abs() < 60.0,
        "{rect:?} {drawn:?}"
    );
}
