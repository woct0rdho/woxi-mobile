use super::reset;
use super::{handle_of, picture_rect, scene_tick_values, svg_of, view_request};
use crate::eval::evaluate_all;
use crate::plot::plot_request;

#[test]
fn a_gesture_frame_carries_no_picture() {
    reset();
    // The client draws an interactive plot from the scene and the samples, so during a
    // gesture the markup is not needed at all: it exists to be saved, and the answer at
    // rest brings it. On a heavy contour it is most of the reply (31 KB of a 40 KB lattice
    // picture), and every byte costs a JNI copy, a JSON parse and a DOM layout.
    let items = evaluate_all("ContourPlot[Sin[3 x] + Cos[4 y] == 0, {x, -5, 5}, {y, -5, 5}]");
    let handle = handle_of(&items);
    let gesture = format!(
            "{{\"msg_type\":\"plot_view\",\"content\":{{\"handle\":{handle},\"x\":[-4,6],\"y\":[-5,5],\"picture\":false}}}}"
        );
    let reply = plot_request(&gesture);
    assert!(reply.contains("\"status\":\"ok\""), "{reply}");
    assert!(!reply.contains("\"svg\""), "{reply}");
    // The scene is what the client draws, so it comes with every picture reply.
    assert!(reply.contains("\"scene\":{\"box\""), "{reply}");
    let rect = picture_rect(&reply);
    assert!(rect[2] - rect[0] > 3000.0, "{rect:?}");
    // The same request without the flag is the whole picture, for the saved markup.
    let reply = plot_request(&view_request("plot_view", handle, (-4.0, 6.0), (-5.0, 5.0)));
    assert!(reply.contains("\"svg\""), "{reply}");
    assert!(svg_of(&reply).contains("<polyline"), "{reply}");
}

#[test]
fn a_gesture_frame_brings_the_ticks_just_outside_the_view() {
    reset();
    // The samples reach half a view past the view. The ticks of a gesture frame do the same,
    // so one entering the frame appears at the picture's answer, not only with the next
    // picture. The layout is still the view's (the scene's frame and labels), so they draw
    // like the rest until the finger reaches them.
    let items = evaluate_all("Plot[Sin[x], {x, -5, 5}]");
    let handle = handle_of(&items);
    let gesture = format!(
            "{{\"msg_type\":\"plot_view\",\"content\":{{\"handle\":{handle},\"x\":[0.5,2.5],\"y\":[-1.1,1.1],\"picture\":false}}}}"
        );
    let reply = plot_request(&gesture);
    assert!(reply.contains("\"status\":\"ok\""), "{reply}");
    // The reply still reports the view, not the margin the ticks were rendered at.
    assert!(reply.contains("\"x\":[0.5,2.5]"), "{reply}");
    let ticks = scene_tick_values(&reply, "x");
    assert!(
        ticks.iter().any(|v| *v < 0.5),
        "no tick below the view: {ticks:?}"
    );
    assert!(
        ticks.iter().any(|v| *v > 2.5),
        "no tick above the view: {ticks:?}"
    );
    // The picture reply (no gesture flag) is the view alone: its markup must match its range.
    let reply = plot_request(&view_request("plot_view", handle, (0.5, 2.5), (-1.1, 1.1)));
    let ticks = scene_tick_values(&reply, "x");
    assert!(
        ticks.iter().all(|v| *v >= 0.5 - 1e-9 && *v <= 2.5 + 1e-9),
        "a picture scene has no ticks outside its range: {ticks:?}"
    );
}

#[test]
fn a_framed_gesture_frame_absorbs_no_ticks_outside_its_frame() {
    reset();
    // A framed plot's ticks live on the frame, so there is nothing "just outside the view" to
    // merge: the margin render's frame-edge base belongs to its own frame, not the view's, and
    // absorbing it would need a frame translation for no gain.
    let items = evaluate_all("Plot[Sin[x], {x, -5, 5}, Frame -> True]");
    let handle = handle_of(&items);
    let gesture = format!(
            "{{\"msg_type\":\"plot_view\",\"content\":{{\"handle\":{handle},\"x\":[0.5,2.5],\"y\":[-1.1,1.1],\"picture\":false}}}}"
        );
    let reply = plot_request(&gesture);
    assert!(reply.contains("\"status\":\"ok\""), "{reply}");
    let ticks = scene_tick_values(&reply, "x");
    assert!(!ticks.is_empty(), "the frame's own ticks: {ticks:?}");
    assert!(
        ticks.iter().all(|v| *v >= 0.5 - 0.05 && *v <= 2.5 + 0.05),
        "a tick outside the view's frame was absorbed: {ticks:?}"
    );
}
