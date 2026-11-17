use woxi::syntax::PlotSource;

/// The `AxesOrigin` of a plot: `{x, y}` from the call's options, `{0, 0}` by default. Only
/// numbers are read. `Automatic` and anything else mean the default. This is the value an axis
/// line carries, whether the renderer drew it at the origin or clamped it to the range's edge.
pub(super) fn axes_origin(source: &PlotSource) -> (f64, f64) {
    use woxi::syntax::Expr;
    let number = |expression: &Expr| match expression {
        Expr::Integer(value) => Some(*value as f64),
        Expr::Real(value) => Some(*value),
        _ => None,
    };
    for option in &source.options {
        let (pattern, replacement) = match option {
            Expr::Rule {
                pattern,
                replacement,
            }
            | Expr::RuleDelayed {
                pattern,
                replacement,
            } => (pattern, replacement),
            _ => continue,
        };
        if !matches!(&**pattern, Expr::Identifier(name) if name == "AxesOrigin") {
            continue;
        }
        if let Expr::List(items) = &**replacement {
            // Woxi resolves each coordinate on its own (`parse_axes_origin`): an `Automatic`
            // one is the natural origin, 0, which the client then clamps to the near rail when
            // it is outside the view. Reading the two together would drop a numeric coordinate
            // next to an automatic one.
            let x = items.first().and_then(number).unwrap_or(0.0);
            let y = items.get(1).and_then(number).unwrap_or(0.0);
            return (x, y);
        }
    }
    (0.0, 0.0)
}

/// Options that add shapes the scene does not model, or that draw the curve differently from the
/// samples: a plot with one of them stays a still picture. Their no-op forms (`None`, `False`, an
/// empty list) are allowed, so a call that spells out a default still pans.
///
/// This is the option-level half of the rule. The other half is the picture itself, which
/// [`scene`] refuses when it holds an element the canvas could not redraw.
pub(crate) fn unmodeled_options(source: &PlotSource) -> bool {
    use woxi::syntax::Expr;
    let empty = |expression: &Expr| match expression {
        Expr::Identifier(name) => name == "None" || name == "False",
        Expr::List(items) => items.is_empty(),
        _ => false,
    };
    let automatic =
        |expression: &Expr| matches!(expression, Expr::Identifier(name) if name == "Automatic");
    source.options.iter().any(|option| {
        let (pattern, replacement) = match option {
            Expr::Rule {
                pattern,
                replacement,
            }
            | Expr::RuleDelayed {
                pattern,
                replacement,
            } => (pattern.as_ref(), replacement.as_ref()),
            _ => return false,
        };
        let Expr::Identifier(name) = pattern else {
            return false;
        };
        match name.as_str() {
            // A theme expands into options that are all modeled (styles, ticks, frame, grid).
            "PlotTheme" => false,
            "Prolog" | "Epilog" | "PlotLabels" | "PlotLegends" | "RegionFunction" => {
                !empty(replacement)
            }
            // `Mesh -> Automatic` and `Exclusions -> Automatic` are the renderer's defaults.
            "Mesh" | "MeshFunctions" | "MeshShading" | "Exclusions" => {
                !empty(replacement) && !automatic(replacement)
            }
            "ClippingStyle" => !empty(replacement),
            // A gradient along the curve cannot be drawn from one color, and a reversed axis
            // cannot be mapped from a range.
            "ColorFunction" => !empty(replacement) && !automatic(replacement),
            "ScalingFunctions" => contains_reverse(replacement),
            // `PlotRangeClipping -> False` lets primitives spill past the frame, which the canvas
            // does not draw. Woxi clips for every other value (its parser tests only `False`), so
            // `Automatic` and `True` are the default and must stay interactive.
            "PlotRangeClipping" => {
                matches!(replacement, Expr::Identifier(value) if value == "False")
            }
            _ => false,
        }
    })
}

fn contains_reverse(expression: &woxi::syntax::Expr) -> bool {
    use woxi::syntax::Expr;
    match expression {
        Expr::Identifier(name) => name == "Reverse",
        Expr::List(items) => items.iter().any(contains_reverse),
        Expr::FunctionCall { args, .. } => args.iter().any(contains_reverse),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::unmodeled_options;

    #[test]
    fn a_plot_with_an_option_that_adds_shapes_is_not_interactive() {
        let source_of = |statement: &str| {
            let graphic = woxi::interpret_with_stdout(statement)
                .map(|result| result.result)
                .ok()
                .and_then(|_| woxi::get_last_output())?;
            let woxi::syntax::Expr::Graphics { source, .. } = &graphic else {
                return None;
            };
            source.clone()
        };
        for statement in [
            "Plot[Sin[x], {x, -5, 5}, Epilog -> {Red, Disk[{0, 0}, 0.2]}]",
            "Plot[Sin[x], {x, -5, 5}, Prolog -> {Red, Line[{{-5, 0}, {5, 0}}]}]",
            "Plot[Sin[x], {x, -5, 5}, Mesh -> {5}]",
            "Plot[1/x, {x, -2, 2}, Exclusions -> {0}]",
            "Plot[Sin[x], {x, -5, 5}, PlotRangeClipping -> False]",
            "Plot[Sin[x], {x, -5, 5}, ColorFunction -> Hue]",
        ] {
            let source = source_of(statement).expect(statement);
            assert!(unmodeled_options(&source), "{statement}");
        }
        // A call that spells out a default still pans.
        for statement in [
            "Plot[Sin[x], {x, -5, 5}]",
            "Plot[Sin[x], {x, -5, 5}, Mesh -> None]",
            "Plot[Sin[x], {x, -5, 5}, Epilog -> None]",
            "Plot[Sin[x], {x, -5, 5}, Exclusions -> Automatic]",
            "Plot[Sin[x], {x, -5, 5}, PlotRangeClipping -> True]",
            "Plot[Sin[x], {x, -5, 5}, PlotRangeClipping -> Automatic]",
        ] {
            let source = source_of(statement).expect(statement);
            assert!(!unmodeled_options(&source), "{statement}");
        }
    }
}
