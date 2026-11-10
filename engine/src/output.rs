//! Output items: what one evaluated statement renders as, in Jupyter's output shapes.

use crate::json::json_escape;

pub(crate) fn item(kind: &str, text: &str, svg: Option<&str>) -> String {
    match svg {
        Some(svg) => format!(
            "{{\"type\":\"{}\",\"text\":\"{}\",\"svg\":\"{}\"}}",
            kind,
            json_escape(text),
            json_escape(svg)
        ),
        None => format!(
            "{{\"type\":\"{}\",\"text\":\"{}\"}}",
            kind,
            json_escape(text)
        ),
    }
}

pub(crate) fn graphics_item(svg: &str) -> String {
    format!("{{\"type\":\"graphics\",\"svg\":\"{}\"}}", json_escape(svg))
}

/// Like [`graphics_item`], with the interactive-view handle of a 2D plot.
pub(crate) fn graphics_item_with_plot(svg: &str, plot: Option<&str>) -> String {
    match plot {
        Some(plot) => format!(
            "{{\"type\":\"graphics\",\"svg\":\"{}\",\"plot\":{}}}",
            json_escape(svg),
            plot
        ),
        None => graphics_item(svg),
    }
}

/// Result text with the graphics placeholders removed (`-Graphics-` etc.).
pub(crate) fn residual_text(result: &str) -> String {
    result
        .replace("-Graphics-", "")
        .replace("-Graphics3D-", "")
        .replace("-Image-", "")
        .replace("-Sound-", "")
        .trim()
        .to_string()
}
