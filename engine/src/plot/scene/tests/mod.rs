//! The scene reader's tests, grouped by aspect: the layout it extracts, the SVG grammar it
//! accepts or refuses, a scene drawn at another view, and the grammar fixture.

mod grammar;
mod layout;

use super::scene;
use super::types::Scene;

pub(super) fn scene_of(statement: &str) -> Option<String> {
    scene_of_axes(statement, false)
}

pub(super) fn scene_of_axes(statement: &str, two_axis: bool) -> Option<String> {
    let graphic = woxi::interpret_with_stdout(statement)
        .map(|result| result.result)
        .ok()
        .and_then(|_| woxi::get_last_output())?;
    let woxi::syntax::Expr::Graphics { svg, source, .. } = &graphic else {
        return None;
    };
    let source = source.as_ref()?;
    scene(svg, source, (source.x_range, source.y_range), two_axis).map(|scene| scene.json())
}

fn numbers_after(json: &str, needle: &str) -> Vec<f64> {
    let at = json.find(needle).expect(needle) + needle.len();
    let rest = &json[at..];
    rest[..rest.find(']').expect("end")]
        .split(',')
        .filter_map(|value| value.parse().ok())
        .collect()
}

/// A scene of a statement cropped to `view`, the way a gesture frame is rendered.
pub(super) fn scene_obj_at(statement: &str, view: ((f64, f64), (f64, f64))) -> Option<Scene> {
    use woxi::syntax::Expr;
    let graphic = woxi::interpret_with_stdout(statement)
        .map(|result| result.result)
        .ok()
        .and_then(|_| woxi::get_last_output())?;
    let axis =
        |range: (f64, f64)| Expr::List(vec![Expr::Real(range.0), Expr::Real(range.1)].into());
    let show = Expr::FunctionCall {
        name: "Show".to_string(),
        args: vec![
            graphic,
            Expr::Rule {
                pattern: Box::new(Expr::Identifier("PlotRange".to_string())),
                replacement: Box::new(Expr::List(vec![axis(view.0), axis(view.1)].into())),
            },
        ]
        .into(),
    };
    let rendered = woxi::evaluator::evaluate_expr_to_expr(&show).ok()?;
    let Expr::Graphics { svg, source, .. } = &rendered else {
        return None;
    };
    let source = source.as_ref()?;
    scene(svg, source, view, false)
}

fn scene_at(statement: &str, view: ((f64, f64), (f64, f64))) -> Option<String> {
    scene_obj_at(statement, view).map(|scene| scene.json())
}

/// The tick objects of a scene, split on their separators (a hand-written JSON reader would
/// be more code than the objects are worth in a test).
fn ticks_of(json: &str) -> Vec<&str> {
    json.split("\"ticks\":[")
        .nth(1)
        .expect("ticks")
        .split("],\"texts\":")
        .next()
        .expect("ticks end")
        .split("},{")
        .map(|tick| tick.trim_matches(|ch| ch == '{' || ch == '}'))
        .collect()
}
