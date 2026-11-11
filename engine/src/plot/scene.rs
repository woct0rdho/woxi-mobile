//! One picture as a scene the client can draw itself: the frame, the data rectangle, the tick
//! values with the labels Woxi printed for them, grid/axis value lines, static texts and the
//! background.
//!
//! Why: Woxi renders a picture and its layout (frame, margins, tick positions, label offsets).
//! Panning that picture means either re-laying it out on every answer - which moves the frame and
//! the labels at the answer rate, and jumps when the labels change width - or moving its elements
//! by hand (the old `planOf`/`move`, which guessed which segment was an axis and which a tick,
//! measured margins in the client, and could not resize a label for a pinch). A scene carries the
//! numbers instead: the client draws the axes and labels from values at display rate, and the
//! frame and the box are decided once, so nothing about the layout moves at the picture rate.
//!
//! The scene is extracted from the SVG, because Woxi exposes no tick API. It is deliberately
//! strict: a picture with any element it cannot express - a raster (`DensityPlot`), an `Epilog`
//! primitive, a legend - is not interactive (`None`), and stays a still picture. One mechanism,
//! with no second rendering path to keep in step.
//!
//! Spaces are named throughout: a tick's `v` is in the drawing space the payload's points use
//! (data units, or their logarithm on a log axis), and every other coordinate is in the picture's
//! own user units.
//!
//! The reader is split by aspect: `svg` parses the flat SVG vocabulary, `picture` reads one
//! element list into a picture, `build` fits the scene from a picture and its source, `options`
//! decides which calls may be drawn this way, and `types` is the scene the client receives.

/// A two-point segment is axis-aligned within this many user units.
const AXIS_ALIGNED_SLACK: f64 = 0.5;
/// A background rectangle covers the picture when it spans this share of both sides.
const BACKGROUND_COVER: f64 = 0.98;
/// A segment spanning this share of the frame is a value line (an axis or a grid line), anything
/// shorter is a tick or a decoration.
const VALUE_LINE_SHARE: f64 = 0.9;
/// How close a coordinate must be to a value line to hang off it.
const EDGE_TOUCH: f64 = 1.0;
/// How far a frame tick's base may sit inside the frame: the frame's stroke is centered on its
/// outline and the renderer starts a frame tick at the stroke's inner edge.
const FRAME_TOUCH_SLACK: f64 = 1.0;
/// A tick value matches across two renders when the difference is below this share of the axis.
const TICK_MATCH_SHARE: f64 = 1e-4;
/// A label centered this close to a tick, as a share of the frame's width, can be its label.
const TICK_ALIGN_SHARE: f64 = 0.01;
/// A tick's label sits within this many ems of its base; a `FrameLabel`/`PlotLabel` is two or
/// more ems away (measured: bottom frame label 2.48 em, title 2.32 em).
const LABEL_BAND_EM: f64 = 2.0;
/// A y tick's label is centered on it within this many ems of its value.
const LABEL_ALIGN_EM: f64 = 1.0;
/// How far a frame may sit outside the picture's canvas: the renderer draws its stroke centered
/// on the outline, so half of it can stick out.
const CANVAS_SLACK: f64 = 1.0;

mod build;
mod options;
mod picture;
mod svg;
mod types;

pub(crate) use build::scene;
pub(crate) use options::unmodeled_options;

#[cfg(test)]
mod tests;
