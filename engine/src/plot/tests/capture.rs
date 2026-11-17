use super::parse;
use super::reset;
use crate::plot::{capture_statement, resample_safe, Sampling};

#[test]
fn only_side_effect_free_wrappers_are_resampled() {
    assert!(resample_safe(&parse("Plot[Sin[x], {x, 0, 1}]")));
    assert!(resample_safe(&parse(
        "ParametricPlot[{Cos[t], Sin[t]}, {t, 0, 1}]"
    )));
    assert!(resample_safe(&parse(
        "Show[Plot[Sin[x], {x, 0, 1}], Axes -> False]"
    )));
    assert!(resample_safe(&parse("p = Plot[Sin[x], {x, 0, 1}]")));
    assert!(!resample_safe(&parse(
        "Module[{y = 2}, Plot[y x, {x, 0, 1}]]"
    )));
    assert!(!resample_safe(&parse(
        "Table[Plot[Sin[x], {x, 0, 1}], {k, 1, 2}]"
    )));
    assert!(!resample_safe(&parse("n++; Plot[Sin[x], {x, 0, 1}]")));
}

#[test]
fn capture_is_a_pure_parse() {
    reset();
    let capture = capture_statement("Plot[Sin[x], {x, 0, 1}]");
    let held = capture.held.expect("plot statement");
    assert_eq!(held.sites.len(), 1);
    assert_eq!(capture.sampling, Sampling::Data);
    // A `ListPlot` has no iterator to rewrite, but its points are data: it keeps its
    // canvas and pans by pictures.
    let list = capture_statement("ListPlot[{1, 4, 9}]");
    assert!(list.held.is_none());
    assert_eq!(list.sampling, Sampling::Data);
    // A wrapper that may run code is not captured, so it is never re-run - but the plot
    // inside it still says which space its points are in.
    let wrapped = capture_statement("Module[{y = 2}, ContourPlot[y x, {x, 0, 1}, {y, 0, 1}]]");
    assert!(wrapped.held.is_none());
    assert_eq!(wrapped.sampling, Sampling::TwoAxis);
    // A statement that mentions no plot at all says nothing about its samples.
    let bare = capture_statement("c");
    assert!(bare.held.is_none());
    assert_eq!(bare.sampling, Sampling::Unknown);
    assert!(!bare.contour());
    // Contour heads are marked even when they are still pictures: the cleanup
    // runs on the SVG in both cases.
    assert!(!capture_statement("Plot[Sin[x], {x, 0, 1}]").contour());
    assert!(capture_statement("ContourPlot[x == 0, {x, -3, 3}, {y, -3, 3}]").contour());
    assert!(capture_statement("ListContourPlot[{{1, 2}, {3, 4}}]").contour());
    assert!(capture_statement("ComplexContourPlot[z^2 == 1, {z, -1, 1}]").contour());
    // The contour may sit under a wrapper that is not a list or function call.
    assert!(capture_statement("x -> ContourPlot[x == 0, {x, -3, 3}, {y, -3, 3}]").contour());
    assert!(capture_statement("Map[ContourPlot[x == 0, {x, -3, 3}, {y, -3, 3}] &, {1}]").contour());
    // Nothing was evaluated, so the interpreter history is untouched.
    assert!(woxi::get_last_output().is_none());
}
