//! Interactive 2D plot views.
//!
//! A rendered 2D plot is kept under a handle, the way a Jupyter kernel keeps the
//! outputs it may be asked to re-render. The stored graphic has its SVG dropped: the
//! renderer rebuilds the picture from the plot data the expression carries, so showing
//! the same plot at another `PlotRange` costs a re-render (a few milliseconds) instead
//! of re-evaluating the user's expression.
//!
//! The parts are split by what changes:
//! - [`frame`]: one picture and one reply - where its data sits in its own user units,
//!   and the samples the canvas draws, as one payload.
//! - [`handle`]: the registry of stored plots, the requests that re-render or re-sample
//!   one, and the `plot_*` protocol the frontend drives them with.
//! - [`sample`]: the statement a gesture re-runs - its plot calls, the iterator arguments
//!   that describe the axes, and the option rules that bind them to a range.
//! - [`scene`]: the SVG picture as the data the client draws: its reader, its layout and
//!   the option policy that decides whether a picture can be drawn this way at all.
//! - [`contour`]: graph reconstruction and SVG/source cleanup for contour junctions.
//! - [`expr`]: the exhaustive child walk used by wrapped graphics and contour detection.

mod contour;
pub(crate) mod expr;
mod frame;
mod handle;
mod sample;
mod scene;

#[cfg(test)]
mod tests;

pub(crate) use contour::{repair_graphic, repair_svg_contour};
pub(crate) use handle::{clear_plot_views, plot_request, register_plot};
pub(crate) use sample::{capture_statement, Capture};

#[cfg(test)]
pub(crate) use sample::{resample_safe, Sampling};
