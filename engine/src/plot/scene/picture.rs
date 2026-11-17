use super::svg::{
    closed_rect, color_of, is_series, length_em, pair_of, rotation_of, segment, text_lines, Element,
};
use super::types::{Segment, Text};
use super::BACKGROUND_COVER;

/// What one SVG's flat element list contributes, before the geometry is fitted.
pub(super) struct Picture {
    pub(super) background: Option<String>,
    pub(super) frame: Option<[f64; 4]>,
    pub(super) frame_style: Option<(String, f64)>,
    pub(super) segments: Vec<Segment>,
    pub(super) texts: Vec<Text>,
    pub(super) canvas: Option<[f64; 4]>,
}

/// Reads the flat SVG grammar into a picture. A single element the scene cannot express refuses
/// the whole picture. The geometry fitted after this is pure numbers.
pub(super) fn parse_picture(elements: &[Element<'_>], series_colors: &[String]) -> Option<Picture> {
    let mut picture = Picture {
        background: None,
        frame: None,
        frame_style: None,
        segments: Vec::new(),
        texts: Vec::new(),
        canvas: None,
    };
    for element in elements {
        match element.name {
            "svg" => {
                let width = element.number("width")?;
                let height = element.number("height")?;
                let numbers: Vec<f64> = element
                    .attr("viewBox")?
                    .split(|ch: char| ch == ',' || ch.is_whitespace())
                    .filter(|part| !part.is_empty())
                    .filter_map(|part| part.trim().parse::<f64>().ok())
                    .collect();
                if numbers.len() != 4
                    || !(width.is_finite() && width > 0.0)
                    || !(height.is_finite() && height > 0.0)
                {
                    return None;
                }
                picture.canvas = Some(numbers.try_into().ok()?);
            }
            "rect" => {
                let at = [
                    element.number("x")?,
                    element.number("y")?,
                    element.number("width")?,
                    element.number("height")?,
                ];
                if let Some(fill) = element.attr("fill") {
                    if fill != "none" && !element.invisible() {
                        // The background covers the picture. Anything smaller is a legend or an
                        // inset, which the scene does not model.
                        let box_of = picture.canvas?;
                        if at[2] >= box_of[2] * BACKGROUND_COVER
                            && at[3] >= box_of[3] * BACKGROUND_COVER
                        {
                            picture.background = Some(color_of(fill)?);
                        } else {
                            return None;
                        }
                        continue;
                    }
                }
                if element.attr("fill") == Some("none") && !element.invisible() {
                    let color = element.attr("stroke").and_then(color_of)?;
                    if picture.frame.replace(at).is_some() {
                        return None;
                    }
                    picture.frame_style = Some((color, element.stroke_width()));
                    continue;
                }
                return None;
            }
            "line" => {
                let at = [
                    element.number("x1")?,
                    element.number("y1")?,
                    element.number("x2")?,
                    element.number("y2")?,
                ];
                if element.invisible() {
                    continue;
                }
                picture.segments.push(segment(element, at)?);
            }
            "polyline" => {
                if element.invisible() {
                    continue;
                }
                let points = element.attr("points")?;
                // A curve can carry tens of thousands of points. Only a two-point segment and the
                // five-point frame outline need their coordinates parsed. A series is drawn from
                // the payload, so its points are never materialized here. Peek at six tokens: a
                // longer list cannot be either of those shapes (a frame with extra collinear
                // points is handled below, but it is not a series and is rare).
                let mut tokens = points.split_whitespace();
                let head: Vec<&str> = tokens.by_ref().take(6).collect();
                let more = tokens.next().is_some();
                let series = is_series(element, series_colors);
                match head.len() {
                    2 => {
                        // A joined two-point series (a `ListPlot` with `Joined -> True`) is a
                        // diagonal polyline. It is not a value line, so it must not go through the
                        // segment branch, which refuses diagonals and would refuse the whole scene.
                        // The canvas draws it from the samples.
                        if !series {
                            let first = pair_of(head[0])?;
                            let second = pair_of(head[1])?;
                            picture
                                .segments
                                .push(segment(element, [first.0, first.1, second.0, second.1])?);
                        }
                    }
                    _ => {
                        // A frame is five points (four corners and back), or a handful more on
                        // its outline. A longer non-series polyline is parsed in full so a frame
                        // with extra outline points still fits `closed_rect`. A longer series is
                        // not parsed at all: the canvas draws it from the payload.
                        let small = !more && (head.len() == 5 || head.len() == 6);
                        if series && !small {
                            // The curve. The canvas draws it from the samples.
                            continue;
                        }
                        let pairs: Vec<(&str, &str)> = if small {
                            head.iter()
                                .filter_map(|token| token.split_once(','))
                                .collect()
                        } else {
                            points
                                .split_whitespace()
                                .filter_map(|pair| pair.split_once(','))
                                .collect()
                        };
                        if let Some(rect) = closed_rect(&pairs) {
                            // A framed plot draws its frame as one closed polyline, not a rect. The
                            // shape decides before the color: a user's `FrameStyle` may equal a
                            // series color.
                            if picture.frame.replace(rect).is_some() {
                                return None;
                            }
                            picture.frame_style = Some((
                                element.attr("stroke").and_then(color_of)?,
                                element.stroke_width(),
                            ));
                        } else if !series {
                            return None;
                        }
                    }
                }
            }
            "path" => {
                // Only `M x1 y1 L x2 y2` (the renderer's two-point segments). A command whose
                // argument count differs (`H`, `V`) is refused rather than misread: the scene
                // models axis-aligned segments, not arbitrary paths.
                let parts: Vec<f64> = element
                    .attr("d")?
                    .split(['M', 'L', 'm', 'l', ',', ' '])
                    .filter(|part| !part.is_empty())
                    .filter_map(|part| part.trim().parse().ok())
                    .collect();
                if parts.len() != 4 || element.invisible() {
                    return None;
                }
                picture
                    .segments
                    .push(segment(element, [parts[0], parts[1], parts[2], parts[3]])?);
            }
            "text" => {
                // Invisible placeholder text draws nothing, like an invisible shape. A zero-opacity
                // label must not become ink on the canvas.
                if element.invisible() {
                    continue;
                }
                let size = element.number("font-size")?;
                if size <= 0.0 {
                    return None;
                }
                let mut y = element.number("y")?;
                // `dy` is in the text's own units: `0.76em` is 0.76 of the font size, `0.5ex`
                // half of that. The renderer writes both around a framed plot's labels.
                if let Some(offset) = element.attr("dy") {
                    if let Some(shift) = length_em(offset, size) {
                        y += shift;
                    }
                }
                let (rotation, cx, cy) = rotation_of(element)?;
                let parent_x = element.number("x")?;
                let anchor = element.attr("text-anchor").unwrap_or("start").to_string();
                let color = element.attr("fill").and_then(color_of)?;
                // A multi-line label is one `<text>` with a `<tspan>` per line: each line is a
                // text of its own for the client, at the baseline the renderer gave it.
                for (line, x, baseline) in text_lines(element.text, parent_x, y, size) {
                    picture.texts.push(Text {
                        text: line,
                        x,
                        y: baseline,
                        anchor: anchor.clone(),
                        size,
                        color: color.clone(),
                        rotation,
                        cx,
                        cy,
                    });
                }
            }
            "polygon" | "circle" | "ellipse" => {
                if !element.invisible() && !is_series(element, series_colors) {
                    return None;
                }
            }
            "g" | "defs" | "image" | "use" | "clipPath" => return None,
            _ => return None,
        }
    }
    Some(picture)
}

#[cfg(test)]
mod tests {
    use crate::plot::scene::tests::{scene_of, scene_of_axes};
    use crate::plot::scene::types::escape;

    #[test]
    fn a_raster_and_an_epilog_are_not_scenes() {
        assert!(scene_of("DensityPlot[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}]").is_none());
        assert!(scene_of("Plot[Sin[x], {x, -5, 5}, Epilog -> {Red, Disk[{0, 0}, 0.2]}]").is_none());
        assert!(scene_of("Graphics[{Circle[{0, 0}, 1]}]").is_none());
        // A two-axis picture whose curves cannot give a data rectangle is refused rather than
        // mapped onto its frame (which would draw the curve a few percent off).
        assert!(scene_of_axes("ContourPlot[x == 0, {x, -3, 3}, {y, -3, 3}]", true).is_none());
    }

    #[test]
    fn a_joined_two_point_series_is_a_curve_not_a_value_line() {
        // Woxi writes a two-point joined `ListPlot` as a two-point polyline. The scene's
        // two-point branch is for value lines. A diagonal segment would be refused (the scene
        // only models axis-aligned lines) and take the whole picture with it.
        let json = scene_of("ListPlot[{{0, 0}, {1, 1}}, Joined -> True]").expect("scene");
        assert!(json.contains("\"frame\":["), "{json}");
        // The picture's axes are value lines. The diagonal curve is not one of them.
        assert!(json.contains("\"lines\":["), "{json}");
    }

    #[test]
    fn a_label_is_escaped_into_one_json_string() {
        // A quote or a backslash in a label must not end the scene's JSON string. A control
        // character would make the whole reply unparseable, so it travels as an escape too.
        assert_eq!(escape("a\"b\\c"), "a\\\"b\\\\c");
        assert_eq!(escape("a\nb\tc"), "a\\nb\\tc");
        assert_eq!(escape("\u{1}"), "\\u0001");
    }

    #[test]
    fn a_multi_line_label_keeps_each_line() {
        // Woxi writes a multi-line label as one <text> with a <tspan> per line. The scene must
        // take the lines apart: one text per line, each at its own baseline, so the client draws
        // them where the renderer did. Refusing the whole picture for a two-line title would be
        // the alternative, and it is a much worse one.
        let json = scene_of("Plot[Sin[x], {x, -5, 5}, PlotLabel -> \"a\\nb\"]").expect("scene");
        assert!(json.contains("\"t\":\"a\""), "{json}");
        assert!(json.contains("\"t\":\"b\""), "{json}");
        let centered = json[json.find("\"texts\":[").expect("texts")..]
            .matches("\"a\":\"middle\"")
            .count();
        assert_eq!(centered, 2, "both lines are centered: {json}");
    }

    #[test]
    fn a_multi_line_y_label_is_rotated_line_by_line() {
        let json =
            scene_of("Plot[Sin[x], {x, -5, 5}, Frame -> True, FrameLabel -> {None, \"a\\nb\"}]")
                .expect("scene");
        assert!(json.contains("\"t\":\"a\""), "{json}");
        assert!(json.contains("\"t\":\"b\""), "{json}");
        assert_eq!(
            json.matches("\"r\":{\"a\":-90").count(),
            2,
            "both lines carry the quarter turn: {json}"
        );
    }
}
