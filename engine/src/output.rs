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

/// A `graphics` item: the markup, and optionally the interactive-view handle of a 2D plot
/// (the range its picture shows) and the samples a gesture draws the curve from. Either
/// may be absent: a re-sample brings samples for the picture already on screen.
pub(crate) fn graphics_item_with_plot(
    svg: Option<&str>,
    plot: Option<&str>,
    data: Option<&str>,
) -> String {
    let mut out = String::from("{\"type\":\"graphics\"");
    if let Some(svg) = svg {
        out.push_str(",\"svg\":\"");
        out.push_str(&json_escape(svg));
        out.push('"');
    }
    if let Some(plot) = plot {
        out.push_str(",\"plot\":");
        out.push_str(plot);
    }
    if let Some(data) = data {
        out.push_str(",\"data\":");
        out.push_str(data);
    }
    out.push('}');
    out
}

/// A `graphics` item for a 3D picture whose geometry is drawn by the client. The SVG is
/// deliberately absent: the scene is the picture, and the notebook keeps the scene.
pub(crate) fn graphics_item_with_plot3d(scene3d: &str) -> String {
    format!("{{\"type\":\"graphics\",\"plot3d\":{scene3d}}}")
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
