use super::options::axes_origin;
use super::picture::parse_picture;
use super::svg::{elements, frame_of_segments};
use super::types::{Label, Scene, Segment, Text, Tick};
use super::{
    CANVAS_SLACK, EDGE_TOUCH, FRAME_TOUCH_SLACK, LABEL_ALIGN_EM, LABEL_BAND_EM, TICK_ALIGN_SHARE,
    VALUE_LINE_SHARE,
};
use woxi::syntax::PlotSource;

/// The frame edge a tick base sits on. `vertical` is the tick mark's direction: an x-axis tick's
/// mark is vertical, so its base coordinate is a y. The frame's stroke is centered on its outline
/// and the renderer starts a frame tick at the stroke's inner edge, so the slack follows it.
pub(super) fn frame_side_of(
    frame: [f64; 4],
    stroke: f64,
    value: f64,
    vertical: bool,
) -> Option<char> {
    let slack = stroke / 2.0 + FRAME_TOUCH_SLACK;
    let (low, high, low_side, high_side) = if vertical {
        (frame[1], frame[1] + frame[3], 't', 'b')
    } else {
        (frame[0], frame[0] + frame[2], 'l', 'r')
    };
    if (value - low).abs() <= slack {
        Some(low_side)
    } else if (value - high).abs() <= slack {
        Some(high_side)
    } else {
        None
    }
}

/// The scene of one rendered picture, or `None` when the picture has an element the scene cannot
/// express (which makes the plot a still picture).
pub(crate) fn scene(
    svg: &str,
    source: &PlotSource,
    view: ((f64, f64), (f64, f64)),
    two_axis: bool,
) -> Option<Scene> {
    let elements = elements(svg)?;
    let series_colors: Vec<String> = source
        .series
        .iter()
        .flat_map(|series| [series.color, series.fill_color.unwrap_or(series.color)])
        .map(|(r, g, b)| format!("#{r:02X}{g:02X}{b:02X}"))
        .collect();
    let picture = parse_picture(&elements, &series_colors)?;

    let canvas = picture.canvas?;
    let background = picture.background?;
    let frame_style = picture.frame_style;
    // The frame: the fill-less rectangle, or the extents of the axes when the picture has none
    // (an unframed `Plot` draws two crossing lines instead).
    let frame = picture
        .frame
        .or_else(|| frame_of_segments(&picture.segments))?;
    if !(frame[2] > 0.0 && frame[3] > 0.0) {
        return None;
    }
    if frame[0] < canvas[0] - CANVAS_SLACK
        || frame[1] < canvas[1] - CANVAS_SLACK
        || frame[0] + frame[2] > canvas[0] + canvas[2] + CANVAS_SLACK
        || frame[1] + frame[3] > canvas[1] + canvas[3] + CANVAS_SLACK
    {
        return None;
    }
    let segments = picture.segments;
    let mut texts = picture.texts;

    // The data rectangle and the map from drawing space to user units. A two-axis picture is
    // drawn at its own range, where the frame lies outside the data by PlotRangePadding, so
    // the rect is measured from its curves. A one-axis picture is a Show crop, where the
    // renderer draws the axes at the requested range and clips the curve to them: there the
    // frame is the data rectangle, and fitting one from the clipped curve would be wrong.
    let frame_rect = [frame[0], frame[1], frame[0] + frame[2], frame[1] + frame[3]];
    // In the order of the range (`picture_rect`): the second number is the user y of the lowest
    // data value, which is the larger one, because the picture's y axis grows downward.
    let flipped = [frame_rect[0], frame_rect[3], frame_rect[2], frame_rect[1]];
    let data = if two_axis {
        // A two-axis picture is drawn at its own range. Its data rectangle is measured from the
        // curves. A picture whose curves cannot give that rectangle is refused instead of falling
        // back to the frame, which would draw the curve a few percent off. Woxi draws no two-axis
        // log plot today, and the mapping would be fitted in data units, so one that appears is
        // refused too.
        if source.log_x || source.log_y {
            return None;
        }
        crate::plot::frame::picture_rect(source, svg, view)?
    } else {
        flipped
    };
    if !(view.0 .1 > view.0 .0 && view.1 .1 > view.1 .0) {
        return None;
    }
    // The client's drawing space is the data space, or its logarithm on a log axis: the payload's
    // points and every value in this scene are in it, so the range has to be converted before the
    // position -> value map is fitted (a log axis draws the logarithm of the value, and the
    // renderer's ticks are placed there).
    let drawing_x = if source.log_x {
        (view.0 .0.log10(), view.0 .1.log10())
    } else {
        view.0
    };
    let drawing_y = if source.log_y {
        (view.1 .0.log10(), view.1 .1.log10())
    } else {
        view.1
    };
    if !(drawing_x.1 > drawing_x.0 && drawing_y.1 > drawing_y.0) {
        return None;
    }
    let ax = (data[2] - data[0]) / (drawing_x.1 - drawing_x.0);
    let bx = data[0] - ax * drawing_x.0;
    let ay = (data[3] - data[1]) / (drawing_y.1 - drawing_y.0);
    let by = data[1] - ay * drawing_y.0;
    if ax == 0.0 || ay == 0.0 {
        return None;
    }

    // Long segments carry a value (an axis or a grid line). The rest are ticks.
    let wide = frame[2];
    let tall = frame[3];
    let mut lines = Vec::new();
    let mut short = Vec::new();
    for segment in segments {
        let across = (segment.x2 - segment.x1).abs();
        let down = (segment.y2 - segment.y1).abs();
        if (segment.horizontal() && across >= wide * VALUE_LINE_SHARE)
            || (segment.vertical() && down >= tall * VALUE_LINE_SHARE)
        {
            lines.push(segment);
        } else {
            short.push(segment);
        }
    }

    // A value line is a grid line until a tick is found hanging off it. Then it is an axis.
    for line in &mut lines {
        line.kind = 'g';
    }

    // Ticks hang off a value line or a frame edge. The end that touches is the base. The label is
    // placed relative to it, so it follows the tick without the client knowing the anchor rule.
    // A frame's stroke is centered on its outline, so the edge is found with the stroke's width,
    // and the scene carries the edge for the client's bands instead of making it infer one.
    let frame_stroke = frame_style.as_ref().map_or(0.0, |(_, width)| *width);
    let line_at = |value: f64, vertical: bool, lines: &[Segment]| -> Option<usize> {
        lines.iter().position(|line| {
            if vertical {
                line.horizontal() && (line.y1 - value).abs() <= EDGE_TOUCH
            } else {
                line.vertical() && (line.x1 - value).abs() <= EDGE_TOUCH
            }
        })
    };
    let mut ticks = Vec::new();
    for segment in &short {
        let vertical = segment.vertical();
        let (axis, position, first, second) = if vertical {
            ('x', segment.x1, segment.y1, segment.y2)
        } else {
            ('y', segment.y1, segment.x1, segment.x2)
        };
        let first_line = line_at(first, vertical, &lines);
        let first_side = if first_line.is_none() {
            frame_side_of(frame, frame_stroke, first, vertical)
        } else {
            None
        };
        let (base, tip, hanging, side) = if let Some(index) = first_line {
            (first, second, Some(index), None)
        } else if let Some(side) = first_side {
            (first, second, None, Some(side))
        } else {
            let second_line = line_at(second, vertical, &lines);
            let second_side = if second_line.is_none() {
                frame_side_of(frame, frame_stroke, second, vertical)
            } else {
                None
            };
            if let Some(index) = second_line {
                (second, first, Some(index), None)
            } else {
                // A short segment that touches no axis line and no frame is a decoration, not a tick.
                let side = second_side?;
                (second, first, None, Some(side))
            }
        };
        let kind = if hanging.is_some() { 'a' } else { 'f' };
        if let Some(index) = hanging {
            lines[index].kind = 'a';
        }
        let value = if axis == 'x' {
            (position - bx) / ax
        } else {
            (position - by) / ay
        };
        ticks.push(Tick {
            axis,
            value,
            at: position,
            base,
            tip,
            kind,
            side,
            color: segment.color.clone(),
            width: segment.width,
            label: None,
        });
    }

    // An axis line carries its origin, not the place it was drawn. Woxi clamps an origin that
    // is outside the plot range to the range's edge, so the drawn position is then an edge
    // value: true only for this picture's view, and stale as soon as a newer scene is drawn at
    // a moved view (the axis would jump from the rail to the old edge and back as answers
    // arrive). The origin is view-independent. The client clamps it to the rail while it is
    // outside, and the axis moves in from the rail exactly when the view brings the origin in.
    // A log axis has no drawable zero: its origin is the low end, which the client's log rule
    // already places on the low rail. 0 is a stable marker there.
    let origin = axes_origin(source);
    for line in &mut lines {
        if line.kind != 'a' {
            continue;
        }
        if line.vertical() && !line.horizontal() {
            line.value = Some(if source.log_x { 0.0 } else { origin.0 });
        } else if line.horizontal() && !line.vertical() {
            line.value = Some(if source.log_y { 0.0 } else { origin.1 });
        }
    }

    // Attach each non-empty text to the tick it labels, by the renderer's rule: a centered text
    // under/above a vertical tick labels x, an end/start text beside a horizontal tick labels y.
    // Anything left is a title or an axis label, and stays where the renderer put it. The longest
    // marks are the labeled (major) ticks - a log axis has many short minors around each label -
    // so they claim their texts first.
    ticks.sort_by(|a, b| {
        let length = |tick: &Tick| (tick.tip - tick.base).abs();
        length(b).total_cmp(&length(a))
    });
    for tick in &mut ticks {
        // The nearest text along the tick's own axis: on a log axis the minor ticks sit close
        // enough to a major's label that the first match in the list can be the wrong one.
        let found = texts
            .iter()
            .enumerate()
            .filter(|(_, text)| {
                if text.text.is_empty() || text.rotated() {
                    return false;
                }
                match (tick.axis, text.anchor.as_str()) {
                    ('x', "middle") => {
                        // A tick's label is a little more than one em off its base. A
                        // `FrameLabel`/`PlotLabel` is two or more (measured: bottom label 2.48
                        // em, title 2.32 em). A wider band would take a static label for the
                        // label of the tick it happens to be centered under, and then the label
                        // would move with the data instead of staying where the renderer put it.
                        (text.x - tick.at).abs() <= wide * TICK_ALIGN_SHARE
                            && (text.y - tick.base).abs() <= LABEL_BAND_EM * text.size
                    }
                    ('y', "end") | ('y', "start") => {
                        (text.y - tick.at).abs() <= LABEL_ALIGN_EM * text.size
                            && (text.x - tick.base).abs() <= LABEL_BAND_EM * text.size
                    }
                    _ => false,
                }
            })
            .min_by(|(_, a), (_, b)| {
                let distance = |text: &Text| {
                    if tick.axis == 'x' {
                        (text.x - tick.at).abs()
                    } else {
                        (text.y - tick.at).abs()
                    }
                };
                distance(a).total_cmp(&distance(b))
            })
            .map(|(index, _)| index);
        if let Some(index) = found {
            let text = texts.remove(index);
            let (origin_x, origin_y) = if tick.axis == 'x' {
                (tick.at, tick.base)
            } else {
                (tick.base, tick.at)
            };
            tick.label = Some(Label {
                text: text.text,
                dx: text.x - origin_x,
                dy: text.y - origin_y,
                anchor: text.anchor,
                size: text.size,
                color: text.color,
            });
        }
    }
    // Texts with no ink are placeholder labels the renderer emits around a frame.
    texts.retain(|text| !text.text.is_empty());

    // Only an outline the picture really drew is a frame. An unframed plot's data area is the
    // extents of its axes, and drawing a rectangle there would add ink the renderer never put on
    // the page.
    let style = frame_style;
    Some(Scene {
        view_box: canvas,
        frame,
        data,
        background,
        style,
        lines,
        ticks,
        texts,
        ax,
        bx,
        ay,
        by,
    })
}

#[cfg(test)]
mod tests {
    use crate::plot::scene::tests::scene_obj_at;
    use crate::plot::scene::types::{label_decimals, label_text};

    #[test]
    fn an_absorbed_label_uses_the_views_number_format() {
        let statement = "Plot[Sin[x], {x, -5, 5}]";
        let crop = ((-1.0, 1.0), (-1.1, 1.1));
        let mut view = scene_obj_at(statement, crop).expect("view");
        assert_eq!(label_decimals(&view, 'x'), Some(1));
        assert_eq!(label_text(2.0, 1, false).as_deref(), Some("2.0"));
        // Half a view wider, the renderer picks a step of 1 and prints "2". The view's step of 0.5
        // prints "2.0". Absorbing the margin's "2" would flash the wrong text for one answer.
        let ahead = scene_obj_at(statement, ((-2.0, 2.0), (-1.1, 1.1))).expect("ahead");
        let before = view.ticks.len();
        view.absorb_ticks(&ahead, (false, false));
        let entering = view
            .ticks
            .iter()
            .skip(before)
            .find(|tick| tick.axis == 'x' && (tick.value - 2.0).abs() < 0.01)
            .expect("the entering 2 tick");
        assert!(
            entering.label.is_none(),
            "absorbed label {:?}",
            entering.label.as_ref().map(|label| label.text.as_str())
        );
        assert!(
            (entering.tip - entering.base).abs() > 0.0,
            "the mark travels"
        );

        // The same margin with the text the view would print keeps it: a pan with the same step
        // still gets its next labels at display rate.
        let mut matching = scene_obj_at(statement, ((-2.0, 2.0), (-1.1, 1.1))).expect("ahead");
        let tick = matching
            .ticks
            .iter_mut()
            .find(|tick| tick.axis == 'x' && (tick.value - 2.0).abs() < 0.01)
            .expect("the ahead 2 tick");
        tick.label.as_mut().expect("a label").text = "2.0".to_string();
        let mut same = scene_obj_at(statement, crop).expect("view");
        let before = same.ticks.len();
        same.absorb_ticks(&matching, (false, false));
        let entering = same
            .ticks
            .iter()
            .skip(before)
            .find(|tick| tick.axis == 'x' && (tick.value - 2.0).abs() < 0.01)
            .expect("the entering 2 tick");
        assert_eq!(
            entering.label.as_ref().map(|label| label.text.as_str()),
            Some("2.0")
        );
    }
}
