//! Contour-line reconstruction.
//!
//! Woxi samples contours with plain marching squares. Its grid is 100 cells
//! for ordinary `ContourPlot`, 400 with a `RegionFunction`, and the data grid
//! for `ListContourPlot`. Saddle cells become separate segments joined at a
//! cell edge, so a crossing can arrive as two U hooks or as two chains that
//! stop a cell or two apart. This module reconstructs the contour graph after
//! sampling: contact zones, split runs, one minimum-cost arm matching per zone,
//! one junction point, and traced chains. No point smoothing happens before the
//! topology is fixed.
//!
//! The implementation is split into geometry, parameters, zones, matching,
//! graph/tracing, PlotSource cleanup, SVG cleanup, and the graphics-expression
//! entry point.

mod geometry;
mod graph;
mod matching;
mod params;
mod source;
mod svg;
mod trace;
mod zones;

mod graphic;

pub(crate) use graphic::{repair_graphic, repair_graphic_source};
pub(crate) use svg::repair_svg_contour;

#[cfg(test)]
mod tests;
