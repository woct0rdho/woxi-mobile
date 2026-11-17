//! SVG polyline cleanup.

use std::collections::HashMap;

use super::geometry::*;
use super::graph::{repair_groups_with_grid, ChainIn};
use super::params::*;

pub(super) struct Polyline {
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) prefix: String,
    pub(super) suffix: String,
    pub(super) points: Vec<Point>,
    /// Whether the tag has the attributes Woxi puts on contour lines.
    pub(super) contour: bool,
}

pub(super) fn points_value(tag: &str) -> Option<(usize, usize)> {
    let at = tag.find("points")?;
    let rest = &tag[at + "points".len()..];
    let rest_at = rest.find('=')? + 1;
    let after_eq = at + "points".len() + rest_at;
    let quote = tag[after_eq..].find(['"', '\''])? + after_eq;
    let quote_char = tag[quote..].chars().next()?;
    let start = quote + 1;
    let end = tag[start..].find(quote_char)? + start;
    Some((start, end))
}

pub(super) fn parse_points(text: &str) -> Option<Vec<Point>> {
    let mut points = Vec::new();
    for token in text.split_whitespace() {
        let (x, y) = token.split_once(',')?;
        let x = x.parse::<f64>().ok()?;
        let y = y.parse::<f64>().ok()?;
        if x.is_finite() && y.is_finite() {
            points.push((x, y));
        }
    }
    (points.len() >= 2).then_some(points)
}

pub(super) fn polylines(svg: &str) -> Vec<Polyline> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while let Some(found) = svg[at..].find("<polyline") {
        let start = at + found;
        let Some(gt) = svg[start..].find('>') else {
            break;
        };
        let end = start + gt + 1;
        let tag = &svg[start..end];
        if let Some((value_start, value_end)) = points_value(tag) {
            if let Some(points) = parse_points(&tag[value_start..value_end]) {
                let contour = tag.contains("fill=\"none\"")
                    && tag.contains("stroke-linecap=\"round\"")
                    && tag.contains("stroke-linejoin=\"round\"");
                out.push(Polyline {
                    start,
                    end,
                    prefix: tag[..value_start].to_string(),
                    suffix: tag[value_end..].to_string(),
                    contour,
                    points,
                });
            }
        }
        at = end;
    }
    out
}

pub(super) fn points_text(points: &[Point]) -> String {
    let mut text = String::with_capacity(points.len() * 12);
    for (index, &(x, y)) in points.iter().enumerate() {
        if index > 0 {
            text.push(' ');
        }
        text.push_str(&format!("{x:.1},{y:.1}"));
    }
    text
}

pub(super) fn svg_number(tag: &str, name: &str) -> Option<f64> {
    let needle = format!("{name}=\"");
    let at = tag.find(&needle)? + needle.len();
    let value = tag[at..].split('"').next()?;
    value.parse().ok()
}

/// Woxi draws the outer, padded frame as the fill-less rectangle in a field
/// plot. The contour grid covers the data rectangle inside it. `Grid` applies
/// the field plot's padding when it converts this frame to sampled cells.
/// The extent of the emitted contour points is not the frame: a contour may
/// stop inside the frame or at a corner.
pub(super) fn svg_frame_bounds(svg: &str) -> Option<Bounds> {
    let mut best: Option<(f64, Bounds)> = None;
    let mut at = 0usize;
    while let Some(found) = svg[at..].find("<rect") {
        let start = at + found;
        let Some(gt) = svg[start..].find('>') else {
            break;
        };
        let end = start + gt + 1;
        let tag = &svg[start..end];
        at = end;
        if !tag.contains("fill=\"none\"")
            || !tag.contains("stroke=\"")
            || tag.contains("stroke=\"none\"")
        {
            continue;
        }
        let (Some(x), Some(y), Some(width), Some(height)) = (
            svg_number(tag, "x"),
            svg_number(tag, "y"),
            svg_number(tag, "width"),
            svg_number(tag, "height"),
        ) else {
            continue;
        };
        if !x.is_finite()
            || !y.is_finite()
            || !width.is_finite()
            || !height.is_finite()
            || width <= 0.0
            || height <= 0.0
        {
            continue;
        }
        let area = width * height;
        if best.as_ref().is_none_or(|(best_area, _)| area > *best_area) {
            best = Some((
                area,
                Bounds {
                    min_x: x,
                    max_x: x + width,
                    min_y: y,
                    max_y: y + height,
                },
            ));
        }
    }
    best.map(|(_, bounds)| bounds)
}

#[cfg(test)]
pub(crate) fn repair_svg(svg: &str) -> String {
    repair_svg_mode(svg, false)
}

/// A `Graphics` with a `PlotSource` can come from a `Show` merge whose
/// renderer emits plain `<polyline>` tags without Woxi's contour attributes.
/// In that case the source identifies the picture, so every polyline in it is
/// eligible for cleanup.
pub(super) fn repair_svg_with_source(svg: &str, has_source: bool) -> String {
    repair_svg_mode(svg, has_source)
}

/// The caller already knows the SVG is a contour picture (for example a
/// `Manipulate` body), even when the merged renderer omitted the contour
/// attributes. This is the same permissive path as a source-backed graphic.
pub(crate) fn repair_svg_contour(svg: &str) -> String {
    repair_svg_mode(svg, true)
}

fn repair_svg_mode(svg: &str, accept_all: bool) -> String {
    let elements = polylines(svg);
    if elements.is_empty() || (!accept_all && !elements.iter().any(|element| element.contour)) {
        return svg.to_string();
    }
    let points: Vec<Vec<Point>> = elements
        .iter()
        .filter(|element| accept_all || element.contour)
        .map(|element| element.points.clone())
        .collect();
    if points.is_empty() {
        return svg.to_string();
    }
    // Measure cells from the raw Woxi chains, then reuse that grid for every
    // pass. A repaired chain contains junction-to-arm segments that are
    // longer than a grid cell. Re-measuring them would make the next pass use
    // a different scale and could merge unrelated contours.
    let grid = Grid::from_chains_with_cell(&points, svg_frame_bounds(svg), read_cell_metadata(svg));
    let mut current = svg.to_string();
    for _ in 0..MAX_REPAIR_PASSES {
        let next = repair_svg_once(&current, grid, accept_all);
        if next == current {
            return with_cell_metadata(&current, grid.cell);
        }
        current = next;
    }
    with_cell_metadata(&current, grid.cell)
}

const CELL_METADATA: &str = "data-woxi-contour-cell";

fn read_cell_metadata(svg: &str) -> Option<Point> {
    let start = svg.find("<svg")?;
    let end = start + svg[start..].find('>')?;
    let tag = &svg[start..end];
    let at = tag.find(CELL_METADATA)? + CELL_METADATA.len();
    let rest = &tag[at..];
    let value_at = rest.find('=')? + 1;
    let value = &rest[value_at..];
    let quote = value.chars().next()?;
    let value = &value[quote.len_utf8()..];
    let value_end = value.find(quote)?;
    let mut parts = value[..value_end].split_whitespace();
    let x: f64 = parts.next()?.parse().ok()?;
    let y: f64 = parts.next()?.parse().ok()?;
    (x.is_finite() && y.is_finite()).then_some((x, y))
}

fn with_cell_metadata(svg: &str, cell: Point) -> String {
    let Some(start) = svg.find("<svg") else {
        return svg.to_string();
    };
    let Some(relative_end) = svg[start..].find('>') else {
        return svg.to_string();
    };
    let end = start + relative_end;
    let value = format!("{:.17e} {:.17e}", cell.0, cell.1);
    if let Some(at) = svg[start..end].find(CELL_METADATA) {
        let attr_at = start + at;
        let Some(eq) = svg[attr_at..end].find('=') else {
            return svg.to_string();
        };
        let value_at = attr_at + eq + 1;
        let Some(quote) = svg[value_at..end].chars().next() else {
            return svg.to_string();
        };
        let value_start = value_at + quote.len_utf8();
        let Some(value_len) = svg[value_start..end].find(quote) else {
            return svg.to_string();
        };
        let value_end = value_start + value_len;
        let mut out = String::with_capacity(svg.len() + value.len());
        out.push_str(&svg[..value_start]);
        out.push_str(&value);
        out.push_str(&svg[value_end..]);
        out
    } else {
        let insert_at = if svg[..end].ends_with("/>") {
            end - 1
        } else {
            end
        };
        let mut out = String::with_capacity(svg.len() + CELL_METADATA.len() + value.len() + 4);
        out.push_str(&svg[..insert_at]);
        out.push(' ');
        out.push_str(CELL_METADATA);
        out.push_str("=\"");
        out.push_str(&value);
        out.push('"');
        out.push_str(&svg[insert_at..]);
        out
    }
}

fn repair_svg_once(svg: &str, grid: Grid, accept_all: bool) -> String {
    let elements = polylines(svg);
    let mut groups: HashMap<String, usize> = HashMap::new();
    let mut next_group = 0usize;
    let chains: Vec<ChainIn> = elements
        .iter()
        .enumerate()
        .filter(|(_, element)| accept_all || element.contour)
        .map(|(kind, element)| {
            let mut key = String::with_capacity(element.prefix.len() + element.suffix.len());
            key.push_str(&element.prefix);
            key.push_str(&element.suffix);
            let group = *groups.entry(key).or_insert_with(|| {
                let group = next_group;
                next_group += 1;
                group
            });
            ChainIn {
                points: element.points.clone(),
                group,
                kind,
            }
        })
        .collect();
    if chains.is_empty() {
        return svg.to_string();
    }
    let repaired = repair_groups_with_grid(&chains, grid);

    if repaired.len() == chains.len()
        && repaired
            .iter()
            .zip(chains.iter())
            .all(|(out, input)| out.kind == input.kind && out.points == input.points)
    {
        return svg.to_string();
    }
    let mut by_kind: Vec<Vec<&[Point]>> = vec![Vec::new(); elements.len()];
    for chain in &repaired {
        by_kind[chain.kind].push(chain.points.as_slice());
    }
    let mut out = String::with_capacity(svg.len() + 64);
    let mut last = 0usize;
    for (index, element) in elements.iter().enumerate() {
        out.push_str(&svg[last..element.start]);
        if !element.contour && !accept_all {
            // Non-contour polylines are outside the graph. Never rewrite them.
            out.push_str(&svg[element.start..element.end]);
        } else if !by_kind[index].is_empty() {
            for points in &by_kind[index] {
                out.push_str(&element.prefix);
                out.push_str(&points_text(points));
                out.push_str(&element.suffix);
            }
        }
        // A contour whose chains were all consumed by a merged chain has no
        // output of its own. Omit it rather than keeping a stale copy.
        last = element.end;
    }
    out.push_str(&svg[last..]);
    out
}
