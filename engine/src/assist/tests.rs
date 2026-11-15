use crate::assist::complete::{rank_band, remember_usage, RANKS, USED_SYMBOLS};
use crate::assist::query_request;

fn reset() {
    woxi::clear_state();
}

fn query(msg_type: &str, content: &str) -> String {
    query_request(&format!(
        "{{\"msg_type\":\"{msg_type}\",\"content\":{content}}}"
    ))
}

fn completion(code: &str, cursor: usize) -> String {
    query(
        "complete_request",
        &format!("{{\"code\":{code:?},\"cursor_pos\":{cursor}}}"),
    )
}

/// A request from inside the options region of a call, as the frontend sends it: the
/// call's head and the options it already names.
fn completion_in_options(code: &str, cursor: usize, head: &str, used: &[&str]) -> String {
    let used: Vec<String> = used.iter().map(|name| format!("{name:?}")).collect();
    query(
        "complete_request",
        &format!(
            "{{\"code\":{code:?},\"cursor_pos\":{cursor},\"context_head\":{head:?},\"context_used\":[{}]}}",
            used.join(",")
        ),
    )
}

/// The notebook's used-name set outlives a request by design, so a test that
/// counts names has to start from a clean notebook.
fn reset_used() {
    USED_SYMBOLS.with(|used| used.borrow_mut().clear());
}

#[test]
fn the_frequency_table_matches_the_registry() {
    // A handful of anchors from Woxi's own ordering, so a stale copy is noticed.
    assert_eq!(RANKS.get("List"), Some(&1));
    assert_eq!(RANKS.get("Plot"), Some(&21));
    assert_eq!(RANKS.get("Sin"), Some(&22));
    assert!(RANKS.len() > 5000, "{} ranked names", RANKS.len());
    // Unranked names sort after every ranked one, and the prior separates names
    // that the tiers cannot (`pts` means `PlotPoints` before `PetersenGraph`).
    assert_eq!(rank_band("VectorLess"), None);
    assert!(rank_band("PlotPoints") < rank_band("PetersenGraph"));
}

#[test]
fn format_request_normalizes_spacing() {
    let reply = query("format_request", "{\"codes\":[\"a=1+2\",\"\"]}");
    assert!(reply.contains("\"status\":\"ok\""), "{reply}");
    assert!(reply.contains("\"a = 1 + 2\""), "{reply}");
    // An empty entry stays empty.
    assert!(reply.contains("[\"a = 1 + 2\",\"\"]"), "{reply}");
}

#[test]
fn completion_reports_arity_so_a_leaf_call_is_not_wrapped() {
    reset_used();
    // The client decides between "wraps its argument" and "takes no argument" from
    // this, so it must agree with the registry.
    let reply = completion("Sin", 3);
    assert!(reply.contains("\"arity\":[1,1]"), "{reply}");
    let reply = completion("NotebookD", 9);
    assert!(reply.contains("\"arity\":[0,0]"), "{reply}");
}

#[test]
fn completion_prefers_frequent_names() {
    reset_used();
    // `pts` abbreviates several names. The registry's frequency order picks the
    // plotting one, which is what the user meant.
    let reply = completion("pts", 3);
    assert!(reply.contains("\"matches\":[\"PlotPoints\""), "{reply}");
    // `ListPlay` and `ListPlot` both answer `ListP`. `ListPlot` is fundamental.
    let reply = completion("ListP", 5);
    assert!(reply.contains("\"matches\":[\"ListPlot\""), "{reply}");
    // An unranked name is still offered for a short query, at the end.
    let reply = completion("Vec", 3);
    let vector_plot = reply.find("\"VectorPlot\"").expect("VectorPlot");
    let vector_less = reply.find("\"VectorLess\"").expect("VectorLess");
    assert!(vector_plot < vector_less, "{reply}");
}

#[test]
fn completion_hides_rare_names_until_the_query_is_specific() {
    reset_used();
    // `RangeFilter` sits deep in the tail: three letters are not specific enough.
    let reply = completion("Ran", 3);
    assert!(reply.contains("\"Range\""), "{reply}");
    assert!(!reply.contains("\"RangeFilter\""), "{reply}");
    // Four are, and so is abbreviating both of its words.
    let reply = completion("Rang", 4);
    assert!(reply.contains("\"RangeFilter\""), "{reply}");
    let reply = completion("RngFlt", 6);
    assert!(reply.contains("\"RangeFilter\""), "{reply}");
    // A name the notebook already uses is matched at any length.
    remember_usage("RangeFilter[1, 2]");
    let reply = completion("Rng", 3);
    assert!(reply.contains("\"RangeFilter\""), "{reply}");
}

#[test]
fn completion_ranks_prefix_before_subsequence() {
    reset_used();
    let reply = completion("Plo", 3);
    assert!(reply.contains("\"status\":\"ok\""), "{reply}");
    // The prefix matches come first and in alphabetical order.
    let plot = reply.find("\"Plot\"").expect("Plot");
    let plot_points = reply.find("\"PlotPoints\"").expect("PlotPoints");
    assert!(plot < plot_points, "{reply}");
    // Camel-case initials reach a name the prefix cannot.
    let reply = completion("PP", 2);
    assert!(reply.contains("\"PlotPoints\""), "{reply}");
    // A subsequence still matches, after the prefix matches, as long as it starts
    // the name.
    let reply = completion("PltRange", 8);
    assert!(reply.contains("\"PlotRange\""), "{reply}");
    let reply = completion("lt", 2);
    assert!(!reply.contains("\"Plot\""), "{reply}");
}

#[test]
fn completion_finds_a_word_from_the_middle() {
    reset_used();
    // A complete word in the middle of a CamelCase name.
    let reply = completion("Range", 5);
    assert!(reply.contains("\"PlotRange\""), "{reply}");
    // The exact name still comes first.
    assert!(reply.contains("\"matches\":[\"Range\""), "{reply}");
    // Abbreviations that skip letters but start words.
    let reply = completion("Rng", 3);
    assert!(reply.contains("\"PlotRange\""), "{reply}");
    let reply = completion("pts", 3);
    assert!(reply.contains("\"PlotPoints\""), "{reply}");
    // The fuzzy tier is a fallback: when the prefix already has answers it stays
    // out of the list, which is what keeps it quiet.
    let reply = completion("Pl", 2);
    assert!(!reply.contains("\"ParametricPlot\""), "{reply}");
    // A word abbreviation beats a mid-word fragment: `lot` reads `Locator`'s word
    // before it reads the middle of `Plot`.
    let reply = completion("lot", 3);
    assert!(reply.contains("\"Locator\""), "{reply}");
    // A fragment that is not a word start, and does not abbreviate words, is the
    // last resort: `otran` still reaches `PlotRange`.
    let reply = completion("otran", 5);
    assert!(reply.contains("\"PlotRange\""), "{reply}");
}

#[test]
fn completion_ranks_the_options_of_the_typed_call_first() {
    reset_used();
    // `Fr` in Plot's options region: Plot's own options come before an unrelated symbol
    // of the same tier (`Framed`), which is the point of the context.
    let code = "Plot[Sin[x], {x, -5, 5}, Fr";
    let reply = completion_in_options(code, code.len(), "Plot", &[]);
    let frame_label = reply.find("\"FrameLabel\"").expect("FrameLabel");
    let framed = reply.find("\"Framed\"").expect("Framed");
    assert!(frame_label < framed, "{reply}");
    // The same prefix outside a call has no reason to put FrameLabel first.
    let plain = completion("Fr", 2);
    assert!(plain.contains("\"FrameLabel\""), "{plain}");
}

#[test]
fn completion_demotes_an_option_the_call_already_names() {
    reset_used();
    // `Frame` is a Plot option and the call already sets it: the options still missing
    // (`FrameLabel`) come first, and `Frame` still comes before a non-option.
    let code = "Plot[Sin[x], {x, -5, 5}, Frame -> True, Fra";
    let reply = completion_in_options(code, code.len(), "Plot", &["Frame"]);
    let frame_label = reply.find("\"FrameLabel\"").expect("FrameLabel");
    let frame = reply.find("\"Frame\"").expect("Frame");
    let framed = reply.find("\"Framed\"").expect("Framed");
    assert!(frame_label < frame, "{reply}");
    assert!(frame < framed, "{reply}");
}

#[test]
fn completion_marks_option_symbols_and_the_calls_options() {
    reset_used();
    // `Axes` is an option symbol: a chip must insert `Axes`, not `Axes[]`.
    let reply = completion("Axe", 3);
    assert!(
        reply.contains("\"option\":true,\"callOption\":false"),
        "{reply}"
    );
    // In Plot's options region it is also one of Plot's options: the chip adds `->`.
    let code = "Plot[Sin[x], {x, -5, 5}, Axe";
    let reply = completion_in_options(code, code.len(), "Plot", &[]);
    assert!(
        reply.contains("\"option\":true,\"callOption\":true"),
        "{reply}"
    );
    // A function that is not an option is neither.
    let reply = completion("Sin", 3);
    assert!(
        reply.contains("\"option\":false,\"callOption\":false"),
        "{reply}"
    );
}

#[test]
fn completion_reports_the_span_to_replace() {
    let reply = completion("Sin[Plo", 7);
    assert!(reply.contains("\"cursor_start\":4"), "{reply}");
    assert!(reply.contains("\"cursor_end\":7"), "{reply}");
    // Outside a name the span is empty, so accepting inserts at the caret.
    let reply = completion("Sin[", 4);
    assert!(reply.contains("\"cursor_start\":4"), "{reply}");
    assert!(reply.contains("\"cursor_end\":4"), "{reply}");
}

#[test]
fn completion_offers_session_symbols_first() {
    reset();
    reset_used();
    let _ = woxi::interpret("myGadget[t_] := t^2");
    let reply = completion("myGad", 6);
    assert!(reply.contains("\"matches\":[\"myGadget\""), "{reply}");
    assert!(reply.contains("\"type\":\"variable\""), "{reply}");
}

#[test]
fn inspect_reports_options_without_touching_history() {
    reset();
    let _ = woxi::interpret("41 + 1");
    let before = woxi::get_last_output().map(|expr| format!("{expr:?}"));
    let reply = query(
        "inspect_request",
        "{\"code\":\"Plot[Sin[x], {x, 0, 1}]\",\"cursor_pos\":2}",
    );
    assert!(reply.contains("\"found\":true"), "{reply}");
    assert!(reply.contains("\"name\":\"Plot\""), "{reply}");
    assert!(reply.contains("\"PlotRange\""), "{reply}");
    // A delayed option default must be listed too.
    assert!(reply.contains("\"PlotTheme\""), "{reply}");
    // Attributes and the four-state status come from the interpreter.
    assert!(reply.contains("\"HoldAll\""), "{reply}");
    assert!(reply.contains("\"status\":\"implemented\""), "{reply}");
    assert!(reply.contains("plotting"), "{reply}");
    let after = woxi::get_last_output().map(|expr| format!("{expr:?}"));
    assert_eq!(before, after, "inspect must not record Out[] history");
    // A name that is only known to Wolfram is reported as not implemented.
    let reply = query(
        "inspect_request",
        "{\"code\":\"PacletInstall\",\"cursor_pos\":5}",
    );
    assert!(reply.contains("\"implemented\":0"), "{reply}");
}

#[test]
fn is_complete_separates_incomplete_from_invalid() {
    for code in [
        "Plot[x, {x, 0, 1",
        "Table[i, {i, 1, ",
        "Sin[1] +",
        "(1 +",
        "\"abc",
        "(* note",
    ] {
        let reply = query("is_complete_request", &format!("{{\"code\":{code:?}}}"));
        assert!(reply.contains("\"incomplete\""), "{code}: {reply}");
    }
    for code in ["1 + * 2", "Sin[1]]", "a = )"] {
        let reply = query("is_complete_request", &format!("{{\"code\":{code:?}}}"));
        assert!(reply.contains("\"invalid\""), "{code}: {reply}");
    }
    for code in [
        "Sin[1]",
        "Plot[Sin[x], {x, -2 Pi, 2 Pi}]",
        "Plot[x, {x, 0, 1}]",
        "a = 1;",
    ] {
        let reply = query("is_complete_request", &format!("{{\"code\":{code:?}}}"));
        assert!(reply.contains("\"complete\""), "{code}: {reply}");
    }
    // Brackets inside a string or a comment do not count.
    let reply = query("is_complete_request", "{\"code\":\"\\\"([\\\"\"}");
    assert!(reply.contains("\"complete\""), "{reply}");
}

#[test]
fn catalog_and_unknown_queries() {
    let reply = query("catalog_request", "{}");
    assert!(reply.contains("\"total\":"), "{reply}");
    assert!(reply.contains("\"version\":"), "{reply}");
    let reply = query("complete_dance", "{}");
    assert!(reply.contains("UnknownMessage"), "{reply}");
}

#[test]
fn diagnostics_flag_a_misspelling_with_a_fix() {
    let reply = query(
        "diagnostics_request",
        "{\"code\":\"Plott[Sin[x], {x, 0, 1}]\"}",
    );
    assert!(reply.contains("\"code\":\"spelling\""), "{reply}");
    assert!(reply.contains("\"fix\""), "{reply}");
    assert!(reply.contains("\"insert\":\"Plot\""), "{reply}");
}

#[test]
fn diagnostics_stay_quiet_while_typing() {
    let reply = query(
        "diagnostics_request",
        "{\"code\":\"Plot[Sin[x], {x, 0, 1\"}",
    );
    assert!(reply.contains("\"status\":\"incomplete\""), "{reply}");
    assert!(reply.contains("\"items\":[]"), "{reply}");
}

#[test]
fn prototypes_are_learned_from_examples() {
    let reply = query(
        "prototypes_request",
        "{\"examples\":[\"Plot[Sin[x], {x, -2 Pi, 2 Pi}]\",\"Table[i^2, {i, 10}]\"]}",
    );
    assert!(reply.contains("\"Plot\""), "{reply}");
    assert!(reply.contains("\"role\":\"iterator\""), "{reply}");
    assert!(reply.contains("{x, xmin, xmax}"), "{reply}");
    assert!(reply.contains("{i, imax}"), "{reply}");
    assert!(reply.contains("\"Sin[x]\""), "{reply}");
}

#[test]
fn definitions_carry_parameters() {
    let reply = query(
        "definitions_request",
        "{\"codes\":[\"f[x_, y_] := x^2 + y\",\"g = 3\"]}",
    );
    assert!(reply.contains("\"name\":\"f\""), "{reply}");
    assert!(reply.contains("\"params\":[\"x\",\"y\"]"), "{reply}");
    assert!(reply.contains("\"name\":\"g\""), "{reply}");
    // `start`/`end` are the name itself (the go-to-definition target), `full` the
    // whole assignment.
    assert!(reply.contains("\"start\":0,\"end\":1"), "{reply}");
    assert!(reply.contains("\"full\":[0,20]"), "{reply}");
}
