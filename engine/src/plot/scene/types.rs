use crate::json::{json_array, json_number, json_object};

use super::{AXIS_ALIGNED_SLACK, TICK_MATCH_SHARE};

/// One segment of the picture: a value line. `kind` is `a` when ticks hang off it (an axis) and
/// `g` otherwise (a grid line): the client keeps an axis clear of the frame's border by its labels,
/// while a grid line is just ink.
#[derive(Clone)]
pub(super) struct Segment {
    pub(super) x1: f64,
    pub(super) y1: f64,
    pub(super) x2: f64,
    pub(super) y2: f64,
    pub(super) width: f64,
    pub(super) color: String,
    pub(super) dashes: Option<Vec<f64>>,
    pub(super) kind: char,
    /// An axis line's origin, in the drawing space: 0 (or the user's `AxesOrigin`). An axis is
    /// drawn where its origin is, or on the range's edge when the origin is outside it; the edge
    /// is a position, not a value, and would go stale as soon as a newer scene is drawn at a
    /// moved view. The origin is view-independent; the client clamps it to the rail when it is
    /// outside. `None` derives the value from the line's position (grid lines).
    pub(super) value: Option<f64>,
}

impl Segment {
    pub(super) fn horizontal(&self) -> bool {
        (self.y1 - self.y2).abs() <= AXIS_ALIGNED_SLACK
    }

    pub(super) fn vertical(&self) -> bool {
        (self.x1 - self.x2).abs() <= AXIS_ALIGNED_SLACK
    }
}

/// One tick: it carries a value on `axis`, spans `base..tip` across that axis in user units, sits
/// at `at` along its own axis, and may have the label the renderer printed for it, as an offset
/// from the base point.
#[derive(Clone)]
pub(super) struct Tick {
    pub(super) axis: char,
    pub(super) value: f64,
    pub(super) at: f64,
    pub(super) base: f64,
    pub(super) tip: f64,
    /// `a` when the tick hangs off an axis line (the client places it at that line's position for
    /// the current view) and `f` when it sits on a frame edge (it stays where the picture drew it).
    pub(super) kind: char,
    /// The frame edge an `f` tick sits on (`l`, `r`, `t`, `b`); `None` for an axis tick. The base
    /// can sit a frame stroke's width inside the rectangle, so the edge is not inferred from it.
    pub(super) side: Option<char>,
    /// The tick mark's own style: `TicksStyle` (or `AxesStyle`) can differ from the frame's.
    pub(super) color: String,
    pub(super) width: f64,
    pub(super) label: Option<Label>,
}

#[derive(Clone)]
pub(super) struct Label {
    pub(super) text: String,
    pub(super) dx: f64,
    pub(super) dy: f64,
    pub(super) anchor: String,
    pub(super) size: f64,
    pub(super) color: String,
}

/// One text the renderer placed: its own baseline point, and the rotation the markup asks for
/// (`FrameLabel` turns the y label a quarter turn about its anchor).
#[derive(Clone)]
pub(super) struct Text {
    pub(super) text: String,
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) anchor: String,
    pub(super) size: f64,
    pub(super) color: String,
    /// Degrees clockwise about `(cx, cy)`, in the picture's y-down space.
    pub(super) rotation: f64,
    pub(super) cx: f64,
    pub(super) cy: f64,
}

impl Text {
    pub(super) fn rotated(&self) -> bool {
        self.rotation != 0.0
    }
}

/// The decimal places every label on `axis` uses, when they are all plain decimal numbers.
/// `None` for a custom label, an exponent, or an axis with no label: an absorbed label is then
/// left off rather than guessed.
pub(super) fn label_decimals(scene: &Scene, axis: char) -> Option<usize> {
    let mut places: Option<usize> = None;
    let mut seen = false;
    for tick in &scene.ticks {
        if tick.axis != axis {
            continue;
        }
        let Some(label) = &tick.label else {
            continue;
        };
        let text = label.text.trim();
        if text.is_empty() {
            continue;
        }
        let body = text.strip_prefix('-').unwrap_or(text);
        let mut dots = 0;
        let mut digits = 0;
        for ch in body.chars() {
            if ch == '.' {
                dots += 1;
            } else if ch.is_ascii_digit() {
                digits += 1;
            } else {
                return None;
            }
        }
        if digits == 0 || dots > 1 {
            return None;
        }
        let here = body.split('.').nth(1).map_or(0, |part| part.len());
        places = Some(places.map_or(here, |current| current.max(here)));
        seen = true;
    }
    seen.then_some(places.unwrap_or(0))
}

/// The text a view printing `places` decimals would give this tick value. A logarithmic axis's
/// tick value is a decade; the label is its data value.
pub(super) fn label_text(value: f64, places: usize, logarithmic: bool) -> Option<String> {
    let value = if logarithmic {
        10f64.powf(value)
    } else {
        value
    };
    if !value.is_finite() {
        return None;
    }
    // `format!` would keep a negative zero. Woxi prints plain zero.
    let value = if value == 0.0 { 0.0 } else { value };
    Some(format!("{:.1$}", value, places))
}

/// One picture as the client draws it, before it becomes JSON. Kept as data (not a string) so a
/// gesture frame can merge the ticks of a second render into it: the picture at the view carries
/// the layout, the one at the samples' margin carries the ticks just outside it.
pub(crate) struct Scene {
    pub(super) view_box: [f64; 4],
    pub(super) frame: [f64; 4],
    pub(super) data: [f64; 4],
    pub(super) background: String,
    pub(super) style: Option<(String, f64)>,
    pub(super) lines: Vec<Segment>,
    pub(super) ticks: Vec<Tick>,
    pub(super) texts: Vec<Text>,
    /// The drawing-space -> user mapping the values in `lines` are recovered with.
    pub(super) ax: f64,
    pub(super) bx: f64,
    pub(super) ay: f64,
    pub(super) by: f64,
}

impl Scene {
    /// The scene as the client reads it.
    pub(crate) fn json(&self) -> String {
        let lines: Vec<String> = self
            .lines
            .iter()
            .map(|segment| {
                let (axis, value) = if segment.horizontal() {
                    (
                        'y',
                        segment
                            .value
                            .unwrap_or_else(|| (segment.y1 - self.by) / self.ay),
                    )
                } else {
                    (
                        'x',
                        segment
                            .value
                            .unwrap_or_else(|| (segment.x1 - self.bx) / self.ax),
                    )
                };
                json_object(&[
                    ("o", Some(format!("\"{axis}\""))),
                    ("v", Some(json_number(value))),
                    ("c", Some(format!("\"{}\"", segment.color))),
                    ("w", Some(json_number(segment.width))),
                    ("k", Some(format!("\"{}\"", segment.kind))),
                    (
                        "d",
                        segment
                            .dashes
                            .as_ref()
                            .map(|dashes| json_array(dashes.iter().copied().map(json_number))),
                    ),
                ])
            })
            .collect();
        let ticks: Vec<String> = self
            .ticks
            .iter()
            .map(|tick| {
                let label = tick.label.as_ref().map(|label| {
                    json_object(&[
                        ("t", Some(format!("\"{}\"", escape(&label.text)))),
                        ("dx", Some(json_number(label.dx))),
                        ("dy", Some(json_number(label.dy))),
                        ("a", Some(format!("\"{}\"", label.anchor))),
                        ("s", Some(json_number(label.size))),
                        ("c", Some(format!("\"{}\"", label.color))),
                    ])
                });
                json_object(&[
                    ("o", Some(format!("\"{}\"", tick.axis))),
                    ("v", Some(json_number(tick.value))),
                    ("at", Some(json_number(tick.at))),
                    ("b", Some(json_number(tick.base))),
                    ("e", Some(json_number(tick.tip))),
                    ("k", Some(format!("\"{}\"", tick.kind))),
                    ("s", tick.side.map(|side| format!("\"{side}\""))),
                    ("c", Some(format!("\"{}\"", tick.color))),
                    ("w", Some(json_number(tick.width))),
                    ("l", label),
                ])
            })
            .collect();
        let texts: Vec<String> = self
            .texts
            .iter()
            .map(|text| {
                json_object(&[
                    ("t", Some(format!("\"{}\"", escape(&text.text)))),
                    ("x", Some(json_number(text.x))),
                    ("y", Some(json_number(text.y))),
                    ("a", Some(format!("\"{}\"", text.anchor))),
                    ("s", Some(json_number(text.size))),
                    ("c", Some(format!("\"{}\"", text.color))),
                    (
                        "r",
                        text.rotated().then(|| {
                            json_object(&[
                                ("a", Some(json_number(text.rotation))),
                                ("x", Some(json_number(text.cx))),
                                ("y", Some(json_number(text.cy))),
                            ])
                        }),
                    ),
                ])
            })
            .collect();
        json_object(&[
            // The picture's own viewBox. The client maps it with the frame onto the first
            // layout and uses its width for the sample stroke/dash/marker fractions. It is not
            // the card's box (that is the frame plus the bands).
            (
                "box",
                Some(json_array(self.view_box.iter().copied().map(json_number))),
            ),
            (
                "frame",
                Some(json_array(self.frame.iter().copied().map(json_number))),
            ),
            (
                "rect",
                Some(json_array(self.data.iter().copied().map(json_number))),
            ),
            ("bg", Some(format!("\"{}\"", self.background))),
            (
                "fs",
                self.style.as_ref().map(|(color, width)| {
                    json_object(&[
                        ("c", Some(format!("\"{color}\""))),
                        ("w", Some(json_number(*width))),
                    ])
                }),
            ),
            ("lines", Some(json_array(lines))),
            ("ticks", Some(json_array(ticks))),
            ("texts", Some(json_array(texts))),
        ])
    }

    /// Whether any line in this scene is an axis (ticks hang off it). A framed plot has only
    /// grid lines; a gesture frame of it has no axis ticks to absorb from the margin render.
    pub(crate) fn has_axis_lines(&self) -> bool {
        self.lines.iter().any(|line| line.kind == 'a')
    }

    /// Adds the ticks `other` has and this scene does not, by axis and value. A gesture frame
    /// renders the picture twice: at the view (this scene: the layout) and at the samples' margin
    /// (the other): the margin's ticks are the ones the finger is about to reach, and without them
    /// they would only appear with the next picture, at the picture rate instead of the display's.
    /// Only ticks that hang off an axis line are merged. A frame tick's base and tip lie on the
    /// margin render's frame edge, not the view's, so merging one would need a frame-edge
    /// translation; a frame tick follows its value anyway, and the view's own set is the live one.
    /// `logs` says which axes are logarithmic; a tick's value is a decade on those.
    pub(crate) fn absorb_ticks(&mut self, other: &Scene, logs: (bool, bool)) {
        // Two pictures of the same plot differ in the last digit of a tick's value (their
        // coordinates are rounded to a tenth of a unit), so the duplicate test is by a fraction of
        // the axis's value span, not by exact equality - a log axis's value span is a few units.
        let span = |ax: f64, from: [f64; 4]| {
            if ax == 0.0 {
                0.0
            } else {
                ((from[2] - from[0]).abs() / ax).abs()
            }
        };
        let tolerances = (
            span(self.ax, self.data) * TICK_MATCH_SHARE,
            span(self.ay, self.data) * TICK_MATCH_SHARE,
        );
        // The margin render chooses its own tick step, and so its own label format: the same
        // value can be printed "2" there and "2.0" at the view. An absorbed label is kept only
        // when it is the text the view's own labels would give it. Otherwise the mark arrives
        // early and the label comes with the first view scene that includes it. That removes the
        // one-frame "3" -> "3.0" swap when a tick crosses into the view.
        let decimals = (label_decimals(self, 'x'), label_decimals(self, 'y'));
        for tick in &other.ticks {
            let tolerance = if tick.axis == 'x' {
                tolerances.0
            } else {
                tolerances.1
            };
            let known = self
                .ticks
                .iter()
                .any(|mine| mine.axis == tick.axis && (mine.value - tick.value).abs() <= tolerance);
            if known {
                continue;
            }
            let mut tick = tick.clone();
            // The ahead picture may draw an axis the view's picture pins (or the other way round,
            // near the origin). The view's axis lines are the witness: a tick on an axis hangs off
            // the line with that orientation. A tick with no such line is a frame tick, which the
            // view keeps on its own frame.
            let tick_axis = tick.axis;
            let has_axis_line = self.lines.iter().any(|line| {
                line.kind == 'a'
                    && if tick_axis == 'x' {
                        line.horizontal()
                    } else {
                        line.vertical()
                    }
            });
            if !has_axis_line {
                continue;
            }
            tick.kind = 'a';
            tick.side = None;
            if let Some(label) = &mut tick.label {
                let places = if tick.axis == 'x' {
                    decimals.0
                } else {
                    decimals.1
                };
                let expected = places.and_then(|places| {
                    label_text(
                        tick.value,
                        places,
                        if tick.axis == 'x' { logs.0 } else { logs.1 },
                    )
                });
                if expected.as_deref() != Some(label.text.trim()) {
                    tick.label = None;
                }
            }
            self.ticks.push(tick);
        }
    }
}

pub(super) fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}
