//! Android JNI wrapper around the Woxi Wolfram Language interpreter.
//!
//! The wrapper exposes the notebook interface the frontend needs, because the helpers
//! that turn interpreter output into these JSON items are internal to Woxi:
//! - `evaluateAll(input)`  -> JSON array of output items
//! - `evaluateManipulate(body, bindingsJson)` -> JSON `{svg|text}`
//! - `plotRequest(json)` -> JSON reply, see below
//! - `queryRequest(json)` -> JSON reply for typing help, see below
//! - `clear()`, `setDarkMode(enabled)`
//!
//! Item JSON shape, so the notebook frontend can render every kind of output with
//! one code path. It corresponds to Jupyter's output messages: `print` and `warning`
//! are `stream`, `text` is `execute_result`, `graphics` and `manipulate` are
//! `display_data`, `error` is `error`.
//!
//! ```json
//! [{"type":"text","text":"x^3/3","svg":"<svg ...>"},
//!  {"type":"graphics","svg":"<svg ...>","plot":{"id":3,"x":[-6.28,6.28],"y":[-1,1]}},
//!  {"type":"print","text":"..."},
//!  {"type":"warning","text":"..."},
//!  {"type":"error","text":"..."},
//!  {"type":"manipulate","body":"...","controls":[...],"initial":{"svg":"..."}}]
//! ```
//!
//! A 2D plot carries a `plot` field: a handle for the rendered graphic, like a
//! Jupyter `display_id`, plus the data range it currently shows. `s` says the plot
//! can be re-sampled (`plot_refine`, rewriting its iterators), `dn` says it samples a
//! fixed parameter domain and can only be redrawn with more points (`plot_densify`).
//! Re-evaluating the entry produces a fresh handle, i.e. the original view.
//!
//! Plot interactions use one request/reply pair per message, in the shape of a
//! Jupyter message (a `msg_type`, a `content` object, and a reply that reports
//! `status` with `ename`/`evalue` on failure):
//!
//! ```json
//! {"msg_type":"plot_view","content":{"handle":3,"x":[-1,1],"y":[-1,1]}}
//! {"msg_type":"plot_view_reply","status":"ok","content":{"type":"graphics",...}}
//! {"msg_type":"plot_view_reply","status":"error","ename":"ExpiredHandle","evalue":"..."}
//! ```
//!
//! `plot_retain`/`plot_release` keep the handle registry tied to live frontend
//! controllers, so a deleted cell frees its plot data.
//!
//! Typing help uses the same envelope, with the names from the Jupyter messaging
//! spec (`complete_request`, `inspect_request`, `is_complete_request`) so the frontend
//! could later talk to a real kernel unchanged:
//!
//! ```json
//! {"msg_type":"complete_request","content":{"code":"Plo","cursor_pos":3,"limit":24}}
//! {"msg_type":"complete_reply","status":"ok","content":{
//!   "matches":["Plot","Plot3D"],"cursor_start":0,"cursor_end":3,
//!   "metadata":{"_jupyter_types_experimental":[{"text":"Plot",...}],
//!               "_woxi":[{"implemented":1,"category":"plotting","doc":"..."}]}}}
//! ```
//!
//! `catalog_request` is a Woxi extension (Jupyter has no message for the whole
//! namespace). It only reports the number of symbols and the version they came from. None of these messages execute the
//! entry they are asked about, and none of them touch `%` history.
//!
//! All evaluation happens in the calling thread. The Kotlin side keeps a single-threaded executor so interpreter
//! state stays consistent, with views served before background re-sampling.

mod assist;
mod eval;
mod json;
mod manipulate;
mod output;
mod plot;
mod typeset;

use jni::errors::LogErrorAndDefault;
use jni::objects::{JClass, JString};
use jni::sys::{jboolean, jstring};
use jni::{Env, EnvUnowned};

use crate::assist::query_request;
use crate::eval::{evaluate_all, evaluate_manipulate};
use crate::plot::{clear_plot_views, plot_request};

// JNI entry points
//
// `jni` 0.22 hands a native method an `EnvUnowned`, which is FFI safe. The usable
// `Env` only exists inside `with_env`. Failures (a JNI error or a Rust panic) are
// resolved through `LogErrorAndDefault`, which logs and returns the default value -
// a null `jstring` here - so nothing unwinds into the JVM.

pub(crate) fn read_string(env: &Env, value: &JString) -> jni::errors::Result<String> {
    value.mutf8_chars(env).map(|chars| chars.to_string())
}

pub(crate) fn write_string(env: &mut Env, text: &str) -> jni::errors::Result<jstring> {
    env.new_string(text).map(|output| output.into_raw())
}

/// Runs `f` with the usable environment, turning a JNI error or a panic into the
/// default return value.
pub(crate) fn with_env<'frame, T: Default>(
    mut unowned: EnvUnowned<'frame>,
    f: impl FnOnce(&mut Env<'frame>) -> jni::errors::Result<T>,
) -> T {
    unowned.with_env(f).resolve::<LogErrorAndDefault>()
}

pub(crate) fn with_string<'frame, F>(
    unowned: EnvUnowned<'frame>,
    input: JString<'frame>,
    f: F,
) -> jstring
where
    F: FnOnce(&str) -> String + std::panic::UnwindSafe,
{
    with_env(unowned, |env| {
        let text = read_string(env, &input)?;
        // A Rust panic must not take the app down. Report it as a normal error item.
        let result = match std::panic::catch_unwind(|| f(&text)) {
            Ok(value) => value,
            Err(_) => "{\"error\":\"interpreter panicked\"}".to_string(),
        };
        write_string(env, &result)
    })
}

#[no_mangle]
pub extern "system" fn Java_com_woctordho_woximobile_NativeEngine_evaluateAll<'frame>(
    unowned: EnvUnowned<'frame>,
    _class: JClass<'frame>,
    input: JString<'frame>,
) -> jstring {
    with_string(unowned, input, evaluate_all)
}

#[no_mangle]
pub extern "system" fn Java_com_woctordho_woximobile_NativeEngine_evaluateManipulate<'frame>(
    unowned: EnvUnowned<'frame>,
    _class: JClass<'frame>,
    body: JString<'frame>,
    bindings: JString<'frame>,
) -> jstring {
    with_env(unowned, |env| {
        let body_text = read_string(env, &body)?;
        let bindings_text = read_string(env, &bindings)?;
        let result =
            match std::panic::catch_unwind(|| evaluate_manipulate(&body_text, &bindings_text)) {
                Ok(value) => value,
                Err(_) => "{\"text\":\"interpreter panicked\"}".to_string(),
            };
        write_string(env, &result)
    })
}

#[no_mangle]
pub extern "system" fn Java_com_woctordho_woximobile_NativeEngine_plotRequest<'frame>(
    unowned: EnvUnowned<'frame>,
    _class: JClass<'frame>,
    request: JString<'frame>,
) -> jstring {
    with_string(unowned, request, plot_request)
}

#[no_mangle]
pub extern "system" fn Java_com_woctordho_woximobile_NativeEngine_queryRequest<'frame>(
    unowned: EnvUnowned<'frame>,
    _class: JClass<'frame>,
    request: JString<'frame>,
) -> jstring {
    with_string(unowned, request, query_request)
}

#[no_mangle]
pub extern "system" fn Java_com_woctordho_woximobile_NativeEngine_clear<'frame>(
    _unowned: EnvUnowned<'frame>,
    _class: JClass<'frame>,
) {
    let _ = std::panic::catch_unwind(clear_plot_views);
    let _ = std::panic::catch_unwind(woxi::clear_state);
}

#[no_mangle]
pub extern "system" fn Java_com_woctordho_woximobile_NativeEngine_setDarkMode<'frame>(
    _unowned: EnvUnowned<'frame>,
    _class: JClass<'frame>,
    enabled: jboolean,
) {
    // `jboolean` is a plain `bool` since jni 0.22 (it was a `u8` before).
    let _ = std::panic::catch_unwind(move || woxi::set_dark_mode(enabled));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assist::complete::{rank_band, remember_usage, RANKS, USED_SYMBOLS};
    use crate::plot::{held_statement, literal_statement, resample_safe, split_semicolons};
    use woxi::syntax::Expr;

    fn reset() {
        woxi::clear_state();
        clear_plot_views();
    }

    fn parse(src: &str) -> Expr {
        woxi::syntax::string_to_expr(src).expect("parses")
    }

    fn handle_of(items: &str) -> u64 {
        let at = items.find("\"id\":").expect("plot payload") + 5;
        let rest = &items[at..];
        let end = rest
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(rest.len());
        rest[..end].parse().expect("handle")
    }

    fn view_request(kind: &str, handle: u64, x: (f64, f64), y: (f64, f64)) -> String {
        format!(
            "{{\"msg_type\":\"{kind}\",\"content\":{{\"handle\":{handle},\"x\":[{},{}],\"y\":[{},{}]}}}}",
            x.0, x.1, y.0, y.1
        )
    }

    #[test]
    fn bare_literals_are_parenthesised() {
        assert_eq!(literal_statement("42"), "(42)");
        assert_eq!(literal_statement(" 3.5 "), "(3.5)");
        assert_eq!(literal_statement("\"hi\""), "(\"hi\")");
        assert_eq!(literal_statement("{1, 2}"), "({1, 2})");
        assert_eq!(literal_statement("42;"), "42;");
        assert_eq!(literal_statement("a = 1"), "a = 1");
        assert_eq!(
            literal_statement("Plot[Sin[x], {x, 0, 1}]"),
            "Plot[Sin[x], {x, 0, 1}]"
        );
    }

    #[test]
    fn semicolons_split_at_top_level_only() {
        assert_eq!(split_semicolons("a = 2; Plot[a x, {x, 0, 1}]").len(), 2);
        assert_eq!(split_semicolons("f[1;2]; g").len(), 2);
        assert_eq!(split_semicolons("\"a;b\"; c").len(), 2);
        assert_eq!(split_semicolons("a = 2").len(), 1);
    }

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
        let held = held_statement("Plot[Sin[x], {x, 0, 1}]").expect("plot statement");
        assert_eq!(held.sites.len(), 1);
        // A wrapper that may run code is not captured, so it is never re-run.
        assert!(held_statement("Module[{y = 2}, Plot[y x, {x, 0, 1}]]").is_none());
        // Nothing was evaluated, so the interpreter history is untouched.
        assert!(woxi::get_last_output().is_none());
    }

    #[test]
    fn percent_sees_bare_literals() {
        reset();
        evaluate_all("42");
        let items = evaluate_all("%");
        assert!(items.contains("\"text\":\"42\""), "{items}");
    }

    #[test]
    fn view_refine_and_release() {
        reset();
        let items = evaluate_all("Plot[Sin[x], {x, 0, 1}]");
        let handle = handle_of(&items);

        let reply = plot_request(&view_request("plot_view", handle, (0.2, 0.4), (-0.5, 0.5)));
        assert!(reply.contains("\"status\":\"ok\""), "{reply}");
        assert!(reply.contains("\"svg\":\"<svg"), "{reply}");

        let reply = plot_request(&view_request(
            "plot_refine",
            handle,
            (0.2, 0.4),
            (-0.5, 0.5),
        ));
        assert!(reply.contains("\"status\":\"ok\""), "{reply}");
        // Coverage is the padded view.
        assert!(reply.contains("\"d\":[0.15"), "{reply}");

        let retain =
            format!("{{\"msg_type\":\"plot_retain\",\"content\":{{\"handle\":{handle}}}}}");
        assert!(plot_request(&retain).contains("\"status\":\"ok\""));
        let release =
            format!("{{\"msg_type\":\"plot_release\",\"content\":{{\"handle\":{handle}}}}}");
        assert!(plot_request(&release).contains("\"status\":\"ok\""));
        let reply = plot_request(&view_request("plot_view", handle, (0.2, 0.4), (-0.5, 0.5)));
        assert!(reply.contains("ExpiredHandle"), "{reply}");
    }

    #[test]
    fn a_plot_inside_a_module_is_cached_only() {
        reset();
        let items = evaluate_all("Module[{y = 2}, Plot[y x, {x, 0, 1}]]");
        assert!(items.contains("\"plot\""), "{items}");
        assert!(items.contains("\"s\":false"), "{items}");
    }

    #[test]
    fn parametric_plots_densify_instead_of_resampling() {
        reset();
        let items = evaluate_all("ParametricPlot[{Cos[t], Sin[t]}, {t, 0, Pi/2}]");
        let handle = handle_of(&items);
        assert!(items.contains("\"dn\":true"), "{items}");
        assert!(items.contains("\"s\":false"), "{items}");

        let densify = format!(
            "{{\"msg_type\":\"plot_densify\",\"content\":{{\"handle\":{handle},\"x\":[-0.2,1.2],\"y\":[-0.2,1.2],\"level\":2}}}}"
        );
        let reply = plot_request(&densify);
        assert!(reply.contains("\"status\":\"ok\""), "{reply}");

        let reply = plot_request(&view_request("plot_refine", handle, (0.0, 1.0), (0.0, 1.0)));
        assert!(reply.contains("UnsupportedPlotRequest"), "{reply}");
    }

    #[test]
    fn unknown_messages_are_reported() {
        let reply = plot_request("{\"msg_type\":\"plot_dance\"}");
        assert!(reply.contains("\"status\":\"error\""), "{reply}");
        assert!(reply.contains("UnknownMessage"), "{reply}");
    }

    // typing help

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

    /// The document's used-name set outlives a request by design, so a test that
    /// counts names has to start from a clean document.
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
    fn format_request_normalises_spacing() {
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
        // A name the document already uses is matched at any length.
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
}
