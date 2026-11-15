//! Regenerates `data/option_symbols.txt`, the option symbols the completion knows.
//!
//! Woxi has no static table of options: each function declares them, and `Options[f]`
//! evaluates the declaration. The list is the union of the rule names over every function
//! Woxi says takes options, which is what lets a chip insert `Axes` instead of `Axes[]`
//! without asking the interpreter on every keystroke.
//!
//! Run from `engine/`:
//!
//! ```text
//! cargo run --profile fast --example gen_option_symbols -- data/option_symbols.txt
//! ```

use std::collections::BTreeSet;

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: gen_option_symbols <output path>");
        std::process::exit(2);
    });
    woxi::clear_state();
    let mut names = BTreeSet::new();
    let mut heads = 0usize;
    let mut with_options = 0usize;
    for name in woxi::evaluator::functions::get_builtin_function_names() {
        if !woxi::evaluator::dispatch::arg_count::takes_options(name) {
            continue;
        }
        heads += 1;
        let value = woxi::interpret_to_expr(&format!("Options[{name}]"));
        let rules = match &value {
            Ok(woxi::syntax::Expr::List(rules)) => rules,
            _ => continue,
        };
        let mut count = 0usize;
        for rule in rules.iter() {
            let pattern = match rule {
                woxi::syntax::Expr::Rule { pattern, .. }
                | woxi::syntax::Expr::RuleDelayed { pattern, .. } => pattern,
                _ => continue,
            };
            if let woxi::syntax::Expr::Identifier(option) = pattern.as_ref() {
                names.insert(option.clone());
                count += 1;
            }
        }
        if count > 0 {
            with_options += 1;
        }
    }
    let body: String = names.iter().cloned().collect::<Vec<_>>().join("\n") + "\n";
    std::fs::write(&path, body).unwrap();
    println!(
        "{heads} heads take options, {with_options} declare at least one, {} distinct option names written to {path}",
        names.len()
    );
}
