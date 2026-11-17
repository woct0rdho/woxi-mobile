//! Graphics-expression cleanup.

use woxi::syntax::Expr;

use super::source::repair_source;
use super::svg::repair_svg_with_source;

pub(crate) fn repair_graphic(expr: &mut Expr) {
    walk_graphic(expr, false);
}

/// A re-sample returns samples, not a picture. Its rendered SVG is only a
/// success check, so repairing it would repeat the SVG parser and graph work
/// for data the caller never reads.
pub(crate) fn repair_graphic_source(expr: &mut Expr) {
    walk_graphic(expr, true);
}

fn walk_graphic(expr: &mut Expr, source_only: bool) {
    if let Expr::Graphics { svg, source, .. } = expr {
        let has_source = source.is_some();
        if let Some(source) = source.as_mut() {
            repair_source(source);
        }
        if !source_only {
            *svg = repair_svg_with_source(svg, has_source);
        }
        return;
    }
    crate::plot::expr::for_each_child_mut(expr, &mut |child| walk_graphic(child, source_only));
}
