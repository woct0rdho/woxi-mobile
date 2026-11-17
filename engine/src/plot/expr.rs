//! Complete child traversal for `Expr`.
//!
//! The interpreter's expression enum has many wrappers (`Rule`, `Map`,
//! `CurriedCall`, ...). A contour can sit under any of them in an evaluated
//! result, so the plot cleanup must not recurse through only the three common
//! containers it originally handled.
//!
//! One match describes the children. The macro only changes whether the
//! visitor receives `&Expr` or `&mut Expr`.

use woxi::syntax::Expr;

macro_rules! walk_children {
    ($expr:expr, $visit:ident) => {
        match $expr {
            Expr::List(items) => {
                for item in items {
                    $visit(item);
                }
            }
            Expr::FunctionCall { args, .. } => {
                for arg in args {
                    $visit(arg);
                }
            }
            Expr::BinaryOp { left, right, .. } => {
                $visit(left);
                $visit(right);
            }
            Expr::UnaryOp { operand, .. } => $visit(operand),
            Expr::Comparison { operands, .. } => {
                for operand in operands {
                    $visit(operand);
                }
            }
            Expr::CompoundExpr(items) => {
                for item in items {
                    $visit(item);
                }
            }
            Expr::Association(pairs) => {
                for (key, value) in pairs {
                    $visit(key);
                    $visit(value);
                }
            }
            Expr::Rule {
                pattern,
                replacement,
            }
            | Expr::RuleDelayed {
                pattern,
                replacement,
            } => {
                $visit(pattern);
                $visit(replacement);
            }
            Expr::ReplaceAll { expr, rules } | Expr::ReplaceRepeated { expr, rules } => {
                $visit(expr);
                $visit(rules);
            }
            Expr::Map { func, list }
            | Expr::Apply { func, list }
            | Expr::MapApply { func, list } => {
                $visit(func);
                $visit(list);
            }
            Expr::PrefixApply { func, arg } => {
                $visit(func);
                $visit(arg);
            }
            Expr::Postfix { expr, func } => {
                $visit(expr);
                $visit(func);
            }
            Expr::Part { expr, index } => {
                $visit(expr);
                $visit(index);
            }
            Expr::CurriedCall { func, args } => {
                $visit(func);
                for arg in args {
                    $visit(arg);
                }
            }
            Expr::Function { body } => $visit(body),
            Expr::NamedFunction { body, .. } => $visit(body),
            Expr::PatternOptional {
                default: Some(default),
                ..
            } => $visit(default),
            Expr::PatternOptional { default: None, .. } => {}
            Expr::PatternTest { test, .. } => $visit(test),
            Expr::Integer(_)
            | Expr::BigInteger(_)
            | Expr::Real(_)
            | Expr::BigFloat(..)
            | Expr::String(_)
            | Expr::Identifier(_)
            | Expr::Slot(_)
            | Expr::SlotSequence(_)
            | Expr::Pattern { .. }
            | Expr::Constant(_)
            | Expr::Raw(_)
            | Expr::Image { .. }
            | Expr::Graphics { .. } => {}
        }
    };
}

/// Visit every direct expression child that can contain another expression.
///
/// `Graphics.structure` is deliberately not visited: the rendered SVG/source
/// are the picture a cleanup operates on, and the symbolic structure can hold
/// the same nested graphics again.
pub(crate) fn for_each_child(expr: &Expr, f: &mut impl FnMut(&Expr)) {
    walk_children!(expr, f);
}

/// Mutable counterpart of [`for_each_child`].
pub(crate) fn for_each_child_mut(expr: &mut Expr, f: &mut impl FnMut(&mut Expr)) {
    walk_children!(expr, f);
}
