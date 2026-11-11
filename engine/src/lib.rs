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
//! Jupyter `display_id`, the range it shows (`x`/`y`), where that range sits in the
//! picture's own user units (`u`, fitted from the curves, for the pictures evaluated at
//! their range - a two-axis plot), the range its samples cover (`d`/`dy`), and what it
//! can do - `s` says it can be re-sampled (`plot_refine`, rewriting its iterators) and
//! `dn` that it samples a fixed parameter domain and can only be redrawn with more points
//! (`plot_densify`). `data` carries those samples for a canvas: a grid, and per series a
//! color, a width and base64 `u16` pairs. A two-axis plot reports its points mirrored in
//! y and `plot_layer` undoes that, so the points are always in the picture's own data
//! coordinates. Re-evaluating the entry produces a fresh handle, i.e. the original view.
//!
//! Plot interactions use one request/reply pair per message, in the shape of a
//! Jupyter message (a `msg_type`, a `content` object, and a reply that reports
//! `status` with `ename`/`evalue` on failure):
//!
//! ```json
//! {"msg_type":"plot_view","content":{"handle":3,"x":[-1,1],"y":[-1,1],"aspect":0.618}}
//! {"msg_type":"plot_view_reply","status":"ok","content":{"type":"graphics",...}}
//! {"msg_type":"plot_refine_reply","status":"ok","content":{"type":"graphics","plot":{...},"data":{...}}}
//! {"msg_type":"plot_view_reply","status":"error","ename":"ExpiredHandle","evalue":"..."}
//! ```
//!
//! `plot_release` frees a handle when the frontend no longer shows that plot, so a deleted
//! cell does not keep its data. Plots beyond the cap are evicted least-recently-used.
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
