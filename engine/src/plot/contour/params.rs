//! Cell, matching, and termination parameters.

// Woxi owns the grid size. Every other tolerance is expressed in cell
// units so the graph is independent of data and screen scales.

/// Contact radius in cell units. Woxi's saddle bridges span one grid cell,
/// and adjacent segments can be joined at either end of that cell. Two cells
/// cover the observed U hooks and end gaps without merging separate crossings.
pub(super) const CONTACT_STEPS: f64 = 2.0;

/// Woxi's `FIELD_GRID`. Used only as the fallback when a chain has no
/// horizontal/vertical sample step to measure.
pub(super) const WOXI_FIELD_GRID: f64 = 100.0;

/// Woxi's default `PlotRangePadding` for a field plot (`field_plot.rs`).
/// The SVG frame is the padded rectangle. The contour grid covers the data
/// rectangle inset by this fraction on each side.
pub(super) const WOXI_FIELD_RANGE_PADDING: f64 = 0.02;

/// A grid or a spacing below this is degenerate and cannot define cell units.
pub(super) const MIN_CELL: f64 = 1e-12;

/// A measured cell within this relative distance of Woxi's 100-cell fallback
/// is treated as the same cell. This absorbs one-decimal SVG coordinates and
/// repair jitter without hiding a 400-cell `RegionFunction` or a data-sized
/// `ListContourPlot` grid.
pub(super) const CELL_ESTIMATE_TOLERANCE: f64 = 0.1;

/// Contact vertices on one chain are one run when they are adjacent in the
/// raw chain (or separated by one non-contact sample). Woxi emits one vertex
/// per cell edge, so an index gap larger than two means the chain left the
/// contact zone and returned.
pub(super) const MAX_CONTACT_INDEX_GAP: usize = 2;

/// How many chain segments beyond the zone boundary define an arm's tangent.
pub(super) const TANGENT_STEPS: usize = 2;

/// A junction point this close to the sampled bounds is a boundary artifact,
/// not a free crossing.
pub(super) const BOUNDARY_MARGIN_STEPS: f64 = 0.5;

/// A path through a zone is straight enough to be left connected when every
/// sampled point is this close to the chord and its consecutive segments do
/// not turn by more than `MAX_LINE_ANGLE`. This is the test that distinguishes
/// a line passing through a crossing from a U hook.
pub(super) const THROUGH_OFFSET_STEPS: f64 = 0.55;

/// Maximum gap between the two run tips, in cell spacings. Woxi's broken
/// endpoints sit on opposite sides of a saddle cell. More than two contact
/// radii is a different contour, not a continuation.
pub(super) const MAX_GAP_STEPS: f64 = CONTACT_STEPS * 2.0;

/// A junction point farther than this from the zone centre is treated as an
/// unstable fit and replaced by the mean arm tip.
pub(super) const MAX_JUNCTION_RADIUS_STEPS: f64 = MAX_GAP_STEPS + 1.0;

/// A continuing arm must point within this angle of the opposite outward
/// tangent. The unoriented line angle is not enough on its own: two arms
/// pointing in the same direction are parallel but are not a continuation.
pub(super) const MAX_LINE_ANGLE: f64 = 35.0 * std::f64::consts::PI / 180.0;

/// Maximum perpendicular offset of an arm from its partner's line.
pub(super) const MAX_OFFSET_STEPS: f64 = CONTACT_STEPS * 0.8;

/// Cost charged for leaving one arm unmatched in a partial matching. A pair
/// has three normalized terms, so half their maximum is the point at which a
/// pair is no better than leaving both arms alone.
const PAIR_COST_TERMS: f64 = 3.0;
pub(super) const UNMATCHED_PENALTY: f64 = PAIR_COST_TERMS / 2.0;

/// The determinant below which the normal equations no longer define a
/// stable intersection. The matrix is scaled by the contact radius, so this
/// is dimensionless and independent of the plot's data units.
pub(super) const MIN_DETERMINANT: f64 = 1e-9;

/// More arms than this in one zone are left as Woxi drew them. The exact
/// matching is exponential in the arm count. Eight arms are two full Woxi
/// saddles, which is already more than the normal four-arm crossing.
pub(super) const MAX_ZONE_ARMS: usize = 8;

/// Fixed-point passes are bounded: each pass is a local graph operation and
/// more than two or three passes indicates a pathological cycle rather than
/// useful repair.
pub(super) const MAX_REPAIR_PASSES: usize = 4;
