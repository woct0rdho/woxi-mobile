# Vendored data

`functions.csv` is copied from https://github.com/ad-si/Woxi , release 0.4.0 . It is not modified.

The engine reads only the `name` and `rank` columns: the rank is Woxi's own ordering of how fundamental each symbol is (rank 1 `List`, 2 `Rule`, 3 `Times`, ..., 21 `Plot`, 22 `Sin`), which the completion list uses as a prior so frequent names come first and rare ones stay out of the way. Descriptions, status and the rest arrive at run time through the interpreter's public API, so this copy only has to be refreshed when the symbol registry changes.

`option_symbols.txt` is generated from the interpreter itself, not downloaded. Woxi has no static per-function option table (its LSP and documentation do not carry one): the only per-function data is `Options[f]`, which evaluates the rules each function declares. The file is the union of the left-hand names of `Options[f]` over every `f` in Woxi's own `functions_with_options.txt` (the list its argument-count check uses): 1245 heads take options, 43 declare at least one, and together they name 144 distinct option symbols. `examples/gen_option_symbols.rs` writes it. Rerun it when Woxi's option declarations change:

```sh
cargo run --profile fast --example gen_option_symbols -- data/option_symbols.txt
```

The completion uses the list for one thing: a name that is an option symbol is inserted bare (`Axes`), never as a call (`Axes[]`). An option of the call the caret is in also gets the `->` when it is inserted from the options context. The set of a single head's options still comes from `Options[head]` at run time (cached for built-ins), so it reflects that head's declarations, not this list. Those declarations carry a default value only: Woxi has no allowed-values data for an option, which is why the bar does not offer option values yet (see the open idea in `docs/input_assistance.md`).
