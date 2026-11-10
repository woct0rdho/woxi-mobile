//! Prototypes and definitions: slot roles and examples learned from the gallery, and
//! where a symbol is defined.

use crate::assist::complete::symbol_table;
use crate::json::{json_escape, json_string_array};

use woxi::syntax::Expr;

/// One argument of a call, as the shape classifier sees it.
pub(crate) struct Slot {
    role: &'static str,
    name: String,
    examples: Vec<String>,
}

pub(crate) fn slot(role: &'static str, name: impl Into<String>, example: String) -> Slot {
    Slot {
        role,
        name: name.into(),
        examples: vec![example],
    }
}

pub(crate) fn is_number(expr: &Expr) -> bool {
    matches!(
        expr,
        Expr::Integer(_) | Expr::BigInteger(_) | Expr::Real(_) | Expr::Constant(_)
    )
}

pub(crate) fn mentions(expr: &Expr, name: &str) -> bool {
    match expr {
        Expr::Identifier(id) | Expr::Constant(id) => id == name,
        Expr::List(items) => items.iter().any(|item| mentions(item, name)),
        Expr::FunctionCall { args, .. } => args.iter().any(|arg| mentions(arg, name)),
        Expr::Rule {
            pattern,
            replacement,
        }
        | Expr::RuleDelayed {
            pattern,
            replacement,
        } => mentions(pattern, name) || mentions(replacement, name),
        Expr::UnaryOp { operand, .. } => mentions(operand, name),
        Expr::BinaryOp { left, right, .. } => mentions(left, name) || mentions(right, name),
        Expr::Comparison { operands, .. } => operands.iter().any(|item| mentions(item, name)),
        Expr::Part { expr, index } => mentions(expr, name) || mentions(index, name),
        _ => false,
    }
}

/// `{v, ...}` at the start of a list: the iterator form of `Plot`, `Table`, `Sum` and
/// friends. Returns the slot name and the variable the other arguments refer to.
pub(crate) fn iterator_of(expr: &Expr) -> Option<(String, String)> {
    let Expr::List(items) = expr else {
        return None;
    };
    let list: Vec<&Expr> = items.iter().collect();
    if list.len() < 2 || list.len() > 4 {
        return None;
    }
    let Expr::Identifier(variable) = list[0] else {
        return None;
    };
    let name = match list.len() {
        2 => format!("{{{variable}, {variable}max}}"),
        3 => format!("{{{variable}, {variable}min, {variable}max}}"),
        _ => format!("{{{variable}, {variable}min, {variable}max, d{variable}}}"),
    };
    Some((name, variable.clone()))
}

pub(crate) fn classify_argument(expr: &Expr, iterators: &[String]) -> Slot {
    let text = woxi::syntax::expr_to_input_form(expr);
    if let Some((name, variable)) = iterator_of(expr) {
        if iterators.iter().any(|known| known == &variable) {
            return slot("iterator", name, text);
        }
    }
    match expr {
        Expr::Rule { pattern, .. } | Expr::RuleDelayed { pattern, .. } => {
            let name = match pattern.as_ref() {
                Expr::Identifier(name) => name.clone(),
                _ => "opt".to_string(),
            };
            slot("option", name, text)
        }
        Expr::List(items) => {
            let all_rules = !items.is_empty()
                && items
                    .iter()
                    .all(|item| matches!(item, Expr::Rule { .. } | Expr::RuleDelayed { .. }));
            if all_rules {
                return slot("options", "opts", text);
            }
            let all_numbers = !items.is_empty() && items.iter().all(is_number);
            if all_numbers {
                return slot("data", "data", text);
            }
            if iterators.iter().any(|variable| mentions(expr, variable)) {
                return slot("expression", "{f1, f2, ...}", text);
            }
            slot("list", "list", text)
        }
        _ if is_number(expr) => slot("number", "n", text),
        Expr::Identifier(_) => slot("symbol", "sym", text),
        _ => {
            if iterators.iter().any(|variable| mentions(expr, variable)) {
                slot("expression", "f", text)
            } else {
                slot("expression", "expr", text)
            }
        }
    }
}

/// Every call inside an expression, with its arguments classified by shape.
pub(crate) fn learn_calls(expr: &Expr, out: &mut Vec<(String, Vec<Slot>)>) {
    if let Expr::FunctionCall { name, args } = expr {
        let list: Vec<&Expr> = args.iter().collect();
        if !list.is_empty() {
            // Which arguments are iterators: a list starting with a symbol, whose
            // bounds are numbers or whose variable is used by another argument.
            let mut iterators: Vec<String> = Vec::new();
            for (index, arg) in list.iter().enumerate() {
                let Some((_, variable)) = iterator_of(arg) else {
                    continue;
                };
                let numeric_bounds = match arg {
                    Expr::List(items) => items.iter().skip(1).all(is_number),
                    _ => false,
                };
                let used_elsewhere = list
                    .iter()
                    .enumerate()
                    .any(|(other, candidate)| other != index && mentions(candidate, &variable));
                if numeric_bounds || used_elsewhere {
                    iterators.push(variable);
                }
            }
            let slots: Vec<Slot> = list
                .iter()
                .map(|arg| classify_argument(arg, &iterators))
                .collect();
            out.push((name.clone(), slots));
        }
        for arg in args.iter() {
            learn_calls(arg, out);
        }
    }
    match expr {
        Expr::List(items) => {
            for item in items.iter() {
                learn_calls(item, out);
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
            learn_calls(pattern, out);
            learn_calls(replacement, out);
        }
        Expr::BinaryOp { left, right, .. } => {
            learn_calls(left, out);
            learn_calls(right, out);
        }
        _ => {}
    }
}

/// Slot names, roles and example arguments learned from the shipped example gallery.
/// The same examples are what the sheet shows, so a prototype can never disagree with
/// an example the user can insert.
pub(crate) fn prototypes_content(json: &str) -> String {
    let examples = json_string_array(json, "examples");
    let mut learned: Vec<(String, Vec<Slot>)> = Vec::new();
    for example in &examples {
        if let Ok(expr) = woxi::syntax::string_to_expr(example) {
            learn_calls(&expr, &mut learned);
        }
    }

    let mut order: Vec<String> = Vec::new();
    let mut table: std::collections::HashMap<String, Vec<Vec<Slot>>> =
        std::collections::HashMap::new();
    for (head, slots) in learned {
        let signature: Vec<(&'static str, String)> =
            slots.iter().map(|s| (s.role, s.name.clone())).collect();
        if !table.contains_key(&head) {
            if order.len() >= 80 {
                continue;
            }
            order.push(head.clone());
            table.insert(head.clone(), Vec::new());
        }
        let variants = table.get_mut(&head).expect("inserted above");
        let existing = variants.iter_mut().find(|variant| {
            variant
                .iter()
                .map(|s| (s.role, s.name.clone()))
                .collect::<Vec<_>>()
                == signature
        });
        match existing {
            Some(variant) => {
                for (target, fresh) in variant.iter_mut().zip(slots) {
                    if target.examples.len() < 3
                        && !target
                            .examples
                            .iter()
                            .any(|known| known == &fresh.examples[0])
                    {
                        target.examples.push(fresh.examples[0].clone());
                    }
                }
            }
            None => {
                if variants.len() < 3 {
                    variants.push(slots);
                }
            }
        }
    }

    let heads: Vec<String> = order
        .iter()
        .map(|head| {
            let variants: Vec<String> = table[head]
                .iter()
                .map(|slots| {
                    let slots: Vec<String> = slots
                        .iter()
                        .map(|slot| {
                            let examples: Vec<String> = slot
                                .examples
                                .iter()
                                .map(|example| format!("\"{}\"", json_escape(example)))
                                .collect();
                            format!(
                                "{{\"role\":\"{}\",\"name\":\"{}\",\"examples\":[{}]}}",
                                slot.role,
                                json_escape(&slot.name),
                                examples.join(",")
                            )
                        })
                        .collect();
                    format!("{{\"slots\":[{}]}}", slots.join(","))
                })
                .collect();
            format!("\"{}\":[{}]", json_escape(head), variants.join(","))
        })
        .collect();
    format!("{{\"heads\":{{{}}}}}", heads.join(","))
}

pub(crate) fn collect_patterns(expr: &Expr, names: &mut Vec<String>) {
    match expr {
        Expr::Pattern { name, .. }
        | Expr::PatternTest { name, .. }
        | Expr::PatternOptional { name, .. } => {
            if !name.is_empty() && !names.iter().any(|known| known == name) {
                names.push(name.clone());
            }
        }
        Expr::FunctionCall { args, .. } => {
            for arg in args.iter() {
                collect_patterns(arg, names);
            }
        }
        Expr::List(items) => {
            for item in items.iter() {
                collect_patterns(item, names);
            }
        }
        _ => {}
    }
}

/// The pattern names bound by a definition's left-hand side: the parameters that are
/// in scope in its body, which is what completion should offer first there.
pub(crate) fn parameters_of(statement: &str) -> Vec<String> {
    let Ok(expr) = woxi::syntax::string_to_expr(statement) else {
        return Vec::new();
    };
    let target = match &expr {
        Expr::FunctionCall { name, args }
            if matches!(
                name.as_str(),
                "Set" | "SetDelayed" | "TagSet" | "TagSetDelayed" | "UpSet" | "UpSetDelayed"
            ) =>
        {
            args.first()
        }
        _ => Some(&expr),
    };
    let mut names = Vec::new();
    if let Some(target) = target {
        collect_patterns(target, &mut names);
    }
    names
}

/// Where each symbol of a notebook is defined, per entry, with the definition's byte
/// range and its parameters. One request for the whole notebook, debounced by the
/// caller.
pub(crate) fn definitions_content(json: &str) -> String {
    use woxi::lsp::analysis;

    let codes = json_string_array(json, "codes");
    let mut entries = Vec::with_capacity(codes.len());
    for code in &codes {
        let tokens = analysis::tokenize(code);
        let definitions = analysis::find_definitions(code, &tokens);
        let rows: Vec<String> = definitions
            .iter()
            .map(|definition| {
                let parameters =
                    parameters_of(&code[definition.full_range.0..definition.full_range.1]);
                let parameters: Vec<String> = parameters
                    .iter()
                    .map(|name| format!("\"{}\"", json_escape(name)))
                    .collect();
                format!(
                    "{{\"name\":\"{}\",\"kind\":\"{}\",\"start\":{},\"end\":{},\"params\":[{}]}}",
                    json_escape(&definition.name),
                    match definition.kind {
                        analysis::DefinitionKind::Function => "function",
                        analysis::DefinitionKind::Variable => "variable",
                    },
                    definition.full_range.0,
                    definition.full_range.1,
                    parameters.join(",")
                )
            })
            .collect();
        entries.push(format!("[{}]", rows.join(",")));
    }
    format!("{{\"entries\":[{}]}}", entries.join(","))
}

pub(crate) fn catalog_content() -> String {
    format!(
        "{{\"version\":\"{}\",\"total\":{}}}",
        env!("CARGO_PKG_VERSION"),
        symbol_table().len()
    )
}
