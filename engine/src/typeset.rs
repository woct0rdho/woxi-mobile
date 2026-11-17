//! Horizontal spacing for the SVG that Woxi's box layout produces.
//!
//! Woxi lays a row out itself: one character cell per glyph, plus the margins its
//! operator table gives the tokens it knows. Two of those choices read wrong next to
//! the code-like input - a product (`45 x`) gets a whole cell of air, and a relation
//! spelled in ASCII (`==`, `->`) gets none at all - so this pass re-emits the document
//! with the gaps the layout itself uses elsewhere.
//!
//! It changes no glyph, no element and no nesting. What it rewrites are the numbers in
//! the drawing: the `translate()` of a group, the `x2` of a fraction's bar (and the two
//! row positions that bar centers), the end of a radical's vinculum, the `width` of the
//! document, and one attribute on the root that records the size the layout was asked
//! for. The font size and the bar are read from the document; the ratios it applies are
//! Woxi's own constants (the cell of `MONO_ADVANCE`, the tiers of its `operator_space`,
//! the thin space of a box string) copied here because the crate keeps them private.
//! Working from the run's font size rather than a fixed one makes a superscript space
//! like a line of text.
//!
//! A document that declares its own root font size is not a box layout - `QuestionObject`
//! draws a panel that way - so it is left alone; the client shows such a document as a
//! picture.
//!
//! The spacing belongs in the box formatter, which is where the space between two boxes
//! is chosen; `docs/output_typesetting.md` records why working on the drawing is the
//! cheaper path, and what would replace this module.

use std::borrow::Cow;
use std::fmt::Write as _;

/// The cell the layout reserves for one character, as a fraction of the font size
/// (`MONO_ADVANCE` in Woxi's `functions::graphics`, which is private). The bundled face
/// advances the same 632/1000 em, but this number describes the layout: the fallback
/// face advances 0.602 and must not be substituted here. Used only to measure a token,
/// never to place one.
const MONO_ADVANCE: f64 = 0.632;

/// The font size `generate_output_svg` lays every result out at. The layout does not
/// write it into the drawing, and the largest run is not it (`Style[..., 24]`), so it is
/// recorded on the root element for the client instead of being guessed back out of the
/// glyph sizes.
const LAYOUT_FONT_SIZE: f64 = 14.0;

/// The gap the layout gives a `U+2009` inside a box string, as a fraction of a cell
/// (`BoxLayout::text`): the thin space that separates the factors of a product in
/// `TraditionalForm`, which is what a StandardForm product's word space becomes.
const THIN_SPACE_RATIO: f64 = 0.32;

/// The margins (in character cells) the layout's `operator_space` gives the relations
/// the StandardForm box formatter spells in ASCII instead of the glyph the table lists.
/// Rules are relations of their own; `==`/`!=`/`<=`/`>=` are equalities; `&&`/`||` are
/// `And`/`Or` (the `∧`/`∨` tier), and `|` is `Alternatives`, whose glyph the table calls
/// `VerticalSeparator` and spaces at 0.2.
const RULE_MARGIN: f64 = 0.60;
const EQUALITY_MARGIN: f64 = 0.44;
const LOGICAL_MARGIN: f64 = 0.34;
const ALTERNATIVES_MARGIN: f64 = 0.2;

/// The step of the layout's numbers (`translate(8.8,0.0)`, `x2="30.5"`) and of the gaps a
/// text run is placed with: it writes one decimal, so a smaller difference is the rounding
/// rather than a missing margin - which is also what makes a second pass a no-op.
const POSITION_STEP: f64 = 0.1;

/// One element's attributes, in the order the layout wrote them and with their values
/// untouched, so an element whose numbers did not change is re-emitted byte for byte.
#[derive(Clone)]
struct Attrs(Vec<(String, String)>);

impl Attrs {
    fn get(&self, key: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }

    fn number(&self, key: &str) -> Option<f64> {
        self.get(key)?.trim().parse().ok()
    }

    fn set(&mut self, key: &str, value: String) {
        match self.0.iter_mut().find(|(name, _)| name == key) {
            Some(pair) => pair.1 = value,
            None => self.0.push((key.to_string(), value)),
        }
    }

    fn render(&self, out: &mut String) {
        for (name, value) in &self.0 {
            out.push(' ');
            out.push_str(name);
            out.push_str("=\"");
            out.push_str(value);
            out.push('"');
        }
    }
}

/// An element that contains other elements: the `<g>` the layout wraps a row or a box
/// in.
struct Group {
    name: String,
    attrs: Attrs,
    children: Vec<Node>,
}

impl Group {
    /// The `(x, y)` of the group's `translate(...)`, when it has one.
    fn position(&self) -> Option<(f64, f64)> {
        self.attrs.get("transform").and_then(translate)
    }
}

/// A text run, kept verbatim down to any `<tspan>` the layout nested in it.
struct Text {
    attrs: Attrs,
    content: String,
}

/// A self-closing element: the geometry the layout draws a box around (a fraction's
/// bar, a radical, a stretched delimiter, a frame).
struct Leaf {
    name: String,
    attrs: Attrs,
}

enum Node {
    Group(Group),
    Text(Text),
    Leaf(Leaf),
}

impl Node {
    /// Emits the node exactly as parsed. Used for the subtrees the pass must not
    /// disturb, so it must not re-run the spacing rules.
    fn render(&self, out: &mut String) {
        match self {
            Node::Group(group) => {
                open(group, 0.0, out);
                for child in &group.children {
                    child.render(out);
                }
                close(group, out);
            }
            Node::Text(text) => {
                out.push_str("<text");
                text.attrs.render(out);
                out.push('>');
                out.push_str(&text.content);
                out.push_str("</text>");
            }
            Node::Leaf(leaf) => leaf.render(out),
        }
    }
}

impl Leaf {
    fn render(&self, out: &mut String) {
        self.render_with(&self.attrs, out);
    }

    fn render_with(&self, attrs: &Attrs, out: &mut String) {
        out.push('<');
        out.push_str(&self.name);
        attrs.render(out);
        out.push_str("/>");
    }
}

/// Opens a group, moving it by `shift` when it carries a position. The transform stays in
/// the attribute list, so a group that does not move is re-emitted exactly as parsed.
fn open(group: &Group, shift: f64, out: &mut String) {
    match group.position() {
        Some((x, y)) if shift != 0.0 => open_at(group, (x + shift, y), out),
        _ => {
            out.push('<');
            out.push_str(&group.name);
            group.attrs.render(out);
            out.push('>');
        }
    }
}

/// Opens a group at an absolute position, replacing the transform it was parsed with.
fn open_at(group: &Group, at: (f64, f64), out: &mut String) {
    let mut attrs = group.attrs.clone();
    attrs.set("transform", format!("translate({:.1},{:.1})", at.0, at.1));
    out.push('<');
    out.push_str(&group.name);
    attrs.render(out);
    out.push('>');
}

fn close(group: &Group, out: &mut String) {
    out.push_str("</");
    out.push_str(&group.name);
    out.push('>');
}

/// A cursor over the document. Every step either consumes exactly what it expects or
/// fails, so a document that is not this shape is refused rather than half-read and
/// half-rewritten.
struct Scan<'a> {
    src: &'a str,
    at: usize,
}

impl<'a> Scan<'a> {
    fn rest(&self) -> &'a str {
        &self.src[self.at..]
    }

    fn done(&self) -> bool {
        self.at >= self.src.len()
    }

    fn eat(&mut self, text: &str) -> bool {
        if self.rest().starts_with(text) {
            self.at += text.len();
            true
        } else {
            false
        }
    }

    fn expect(&mut self, text: &str) -> Option<()> {
        self.eat(text).then_some(())
    }

    fn skip_space(&mut self) {
        while matches!(self.rest().chars().next(), Some(c) if c.is_ascii_whitespace()) {
            self.at += 1;
        }
    }

    /// A tag or attribute name: a letter, then letters, digits, `-`, `_`, `.` or `:`.
    fn name(&mut self) -> Option<&'a str> {
        let rest = self.rest();
        let mut end = 0;
        for (index, c) in rest.char_indices() {
            let ok = if index == 0 {
                c.is_ascii_alphabetic()
            } else {
                c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':')
            };
            if !ok {
                break;
            }
            end = index + c.len_utf8();
        }
        if end == 0 {
            return None;
        }
        self.at += end;
        Some(&rest[..end])
    }

    /// `key="value"` pairs, then `>` or `/>`.
    fn attributes(&mut self) -> Option<(Attrs, bool)> {
        let mut attrs = Vec::new();
        loop {
            self.skip_space();
            if self.eat("/>") {
                return Some((Attrs(attrs), true));
            }
            if self.eat(">") {
                return Some((Attrs(attrs), false));
            }
            let key = self.name()?.to_string();
            self.expect("=")?;
            let quote = self
                .rest()
                .chars()
                .next()
                .filter(|c| *c == '"' || *c == '\'')?;
            self.at += 1;
            let end = self.rest().find(quote)?;
            attrs.push((key, self.rest()[..end].to_string()));
            self.at += end + 1;
        }
    }

    /// The text up to `marker`, leaving the cursor on it.
    fn until(&mut self, marker: &str) -> Option<&'a str> {
        let end = self.rest().find(marker)?;
        let text = &self.rest()[..end];
        self.at += end;
        Some(text)
    }
}

fn parse(svg: &str) -> Option<(Attrs, f64, Vec<Node>)> {
    let mut scan = Scan { src: svg, at: 0 };
    scan.skip_space();
    scan.expect("<")?;
    if scan.name()? != "svg" {
        return None;
    }
    let (attrs, self_closing) = scan.attributes()?;
    if self_closing {
        return None;
    }
    // A document that names its own root font size was drawn by another renderer
    // (`QuestionObject` is the one Woxi produces), not by the box layout, so none of the
    // assumptions below hold for it. The client treats the same attribute as "this is a
    // picture" (isDrawing, render-output.js).
    if attrs.get("font-size").is_some() {
        return None;
    }
    let children = parse_children(&mut scan, "svg")?;
    scan.skip_space();
    if !scan.done() {
        return None;
    }
    let width = attrs.number("width")?;
    Some((attrs, width, children))
}

fn parse_children(scan: &mut Scan, name: &str) -> Option<Vec<Node>> {
    let mut children = Vec::new();
    loop {
        if scan.done() {
            return None;
        }
        if scan.eat("</") {
            let closing = scan.name()?;
            scan.skip_space();
            scan.expect(">")?;
            return (closing == name).then_some(children);
        }
        if scan.rest().starts_with('<') {
            children.push(parse_element(scan)?);
            continue;
        }
        // The layout concatenates its elements with no text between them. Whitespace is
        // tolerated. Anything else means this is a document the pass does not model.
        let text = scan.until("<")?;
        if !text.trim().is_empty() {
            return None;
        }
    }
}

fn parse_element(scan: &mut Scan) -> Option<Node> {
    scan.expect("<")?;
    let name = scan.name()?;
    let (attrs, self_closing) = scan.attributes()?;
    if self_closing {
        return Some(Node::Leaf(Leaf {
            name: name.to_string(),
            attrs,
        }));
    }
    if name == "text" {
        let content = scan.until("</text>")?.to_string();
        scan.expect("</text>")?;
        return Some(Node::Text(Text { attrs, content }));
    }
    // A group the layout places with `translate(...)` is the pass's to move. The position
    // stays in the attribute list and `Group::position` reads it back.
    let children = parse_children(scan, name)?;
    Some(Node::Group(Group {
        name: name.to_string(),
        attrs,
        children,
    }))
}

/// The `(x, y)` of a `translate(...)` transform.
fn translate(value: &str) -> Option<(f64, f64)> {
    let inner = value.strip_prefix("translate(")?.strip_suffix(')')?;
    let (x, y) = inner.split_once(',')?;
    Some((x.trim().parse().ok()?, y.trim().parse().ok()?))
}

/// The change the layout needs in the gaps either side of one child of a row.
struct Gap {
    /// Added before the child: a relation's left margin.
    before: f64,
    /// Added after it: a relation's right margin, or a product's shrink.
    after: f64,
}

/// The only text run of a group that holds exactly one, which is how the layout draws
/// a single atom.
fn sole_text(node: &Node) -> Option<&Text> {
    match node {
        Node::Group(group) => match group.children.as_slice() {
            [Node::Text(text)] => Some(text),
            _ => None,
        },
        _ => None,
    }
}

/// Where a row child sits.
fn position(node: &Node) -> Option<(f64, f64)> {
    match node {
        Node::Group(group) => group.position(),
        _ => None,
    }
}

/// One character cell of a text run. `None` for a run the layout draws with an
/// explicit anchor (the `×` of a scientific notation sits in a 1.8 cell slot), whose
/// advance is not a whole number of cells.
fn cell(text: &Text) -> Option<f64> {
    if text.attrs.get("text-anchor").is_some() {
        return None;
    }
    Some(text.attrs.number("font-size")? * MONO_ADVANCE)
}

/// The margin each side of a relation token needs, in character cells: the tier the
/// layout's `operator_space` puts the equivalent glyph in. `None` when the token is not
/// a relation the pass knows - a miss leaves the gap the layout chose instead of
/// inventing one from a character class.
fn relation_tier(token: &str) -> Option<f64> {
    match token {
        // `\[Rule]` and `\[RuleDelayed]` as the layout substitutes them.
        "\u{2192}" | "\u{29F4}" => Some(RULE_MARGIN),
        // Equalities and the assignments the box formatter spells in ASCII. `=` itself is
        // absent: the layout's table already spaces it.
        "==" | "!=" | "<=" | ">=" | "<>" | "===" | "=!=" | "+=" | "-=" | "*=" | "/=" | "^="
        | ":=" => Some(EQUALITY_MARGIN),
        // `&&`/`||` are `And`/`Or` (the `∧`/`∨` tier). `|` is `Alternatives`, which the
        // table names `VerticalSeparator` and spaces at 0.2.
        "&&" | "||" => Some(LOGICAL_MARGIN),
        "|" => Some(ALTERNATIVES_MARGIN),
        _ => None,
    }
}

/// The text of a run with the entities the layout escapes put back. `svg_escape` writes
/// `&`, `<`, `>` and `"`, so a token such as `<=` arrives as `&lt;=`.
fn decode(text: &str) -> Cow<'_, str> {
    const ENTITIES: [(&str, char); 4] = [
        ("&lt;", '<'),
        ("&gt;", '>'),
        ("&amp;", '&'),
        ("&quot;", '"'),
    ];
    if !text.contains('&') {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find('&') {
        out.push_str(&rest[..index]);
        rest = &rest[index..];
        match ENTITIES.iter().find(|(entity, _)| rest.starts_with(entity)) {
            Some((entity, decoded)) => {
                out.push(*decoded);
                rest = &rest[entity.len()..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    Cow::Owned(out)
}

/// Re-emits a typeset SVG with the spacing rules applied, recording the layout's font
/// size for the client. A document the pass does not model is returned unchanged.
pub(crate) fn respace_svg(svg: &str) -> String {
    respace_document(svg).unwrap_or_else(|| svg.to_string())
}

/// The re-emitted document.
fn respace_document(svg: &str) -> Option<String> {
    let (mut attrs, width, children) = parse(svg)?;
    let mut body = String::new();
    let delta = emit_row(&children, &mut body);
    attrs.set("width", format!("{:.0}", (width + delta).max(1.0).ceil()));
    attrs.set("data-woxi-font-size", format!("{LAYOUT_FONT_SIZE}"));
    let mut markup = String::with_capacity(svg.len() + 64);
    markup.push_str("<svg");
    attrs.render(&mut markup);
    markup.push('>');
    markup.push_str(&body);
    markup.push_str("</svg>");
    Some(markup)
}

/// Re-spaces the children of a row. The accumulated shift goes into each child's
/// position; the gaps either side of it decide how far the neighbours move.
fn emit_row(children: &[Node], out: &mut String) -> f64 {
    let mut shift = 0.0;
    for index in 0..children.len() {
        // The gap is read before anything is emitted, so every position is still the
        // one the layout wrote. A relation's left margin moves the token and everything
        // after it. Its right margin, added once the token is in place, moves only what
        // follows.
        let gap = gap_after(children, index);
        shift += gap.as_ref().map_or(0.0, |gap| gap.before);
        shift += emit(&children[index], shift, out);
        shift += gap.map_or(0.0, |gap| gap.after);
    }
    shift
}

/// Re-emits one child, moving it by `shift` and reporting how much its own width
/// changed.
fn emit(node: &Node, shift: f64, out: &mut String) -> f64 {
    let Node::Group(group) = node else {
        node.render(out);
        return 0.0;
    };
    open(group, shift, out);
    let delta = emit_contents(group, out);
    close(group, out);
    delta
}

/// Re-emits a group's contents (not its tags) and reports the width change.
fn emit_contents(group: &Group, out: &mut String) -> f64 {
    if let Some(fraction) = Fraction::measure(&group.children) {
        return fraction.emit(out);
    }
    if let Some(radical) = Radical::measure(&group.children) {
        return radical.emit(&group.children, out);
    }
    // A group with a direct leaf or text child is not a row of boxes: a fraction's bar
    // and a radical's hook are leaves, and a thin-space digit group is several text runs.
    // The pass has no way to move such a child (it carries no `translate()`), so the
    // group is re-emitted exactly as it was rather than with its siblings shifted.
    if group
        .children
        .iter()
        .any(|child| !matches!(child, Node::Group(_)))
    {
        for child in &group.children {
            child.render(out);
        }
        return 0.0;
    }
    emit_row(&group.children, out)
}

/// A fraction is a numerator, a bar and a denominator, the two rows centered in the
/// bar the layout sized to the wider of them.
struct Fraction<'a> {
    numerator: &'a Group,
    bar: &'a Leaf,
    denominator: &'a Group,
    numerator_at: (f64, f64),
    denominator_at: (f64, f64),
    /// The widths the layout gave the bar and the two rows, and the padding it added
    /// to the wider row to get the bar.
    bar_width: f64,
    numerator_width: f64,
    denominator_width: f64,
    padding: f64,
}

impl<'a> Fraction<'a> {
    fn measure(children: &'a [Node]) -> Option<Self> {
        let [Node::Group(numerator), Node::Leaf(bar), Node::Group(denominator)] = children else {
            return None;
        };
        if bar.name != "line" {
            return None;
        }
        let bar_width = bar.attrs.number("x2")?;
        let numerator_at = numerator.position()?;
        let denominator_at = denominator.position()?;
        // The bar centers each row, so what is left of it either side is the row.
        let numerator_width = bar_width - 2.0 * numerator_at.0;
        let denominator_width = bar_width - 2.0 * denominator_at.0;
        if numerator_width < 0.0 || denominator_width < 0.0 {
            return None;
        }
        let padding = bar_width - numerator_width.max(denominator_width);
        Some(Self {
            numerator,
            bar,
            denominator,
            numerator_at,
            denominator_at,
            bar_width,
            numerator_width,
            denominator_width,
            padding,
        })
    }

    fn emit(&self, out: &mut String) -> f64 {
        // A row's contents do not depend on where the row sits, so they are re-spaced
        // before the bar is sized. A row that is itself a fraction re-sizes its own
        // bar first, and its shrink carries into this one.
        let mut numerator_body = String::new();
        let numerator_delta = emit_contents(self.numerator, &mut numerator_body);
        let mut denominator_body = String::new();
        let denominator_delta = emit_contents(self.denominator, &mut denominator_body);
        let (numerator_at, denominator_at, bar_width) =
            if numerator_delta == 0.0 && denominator_delta == 0.0 {
                (self.numerator_at, self.denominator_at, self.bar_width)
            } else {
                let numerator_width = self.numerator_width + numerator_delta;
                let denominator_width = self.denominator_width + denominator_delta;
                let bar_width = numerator_width.max(denominator_width) + self.padding;
                (
                    ((bar_width - numerator_width) / 2.0, self.numerator_at.1),
                    ((bar_width - denominator_width) / 2.0, self.denominator_at.1),
                    bar_width,
                )
            };
        open_at(self.numerator, numerator_at, out);
        out.push_str(&numerator_body);
        close(self.numerator, out);
        let mut bar_attrs = self.bar.attrs.clone();
        bar_attrs.set("x2", format!("{bar_width:.1}"));
        self.bar.render_with(&bar_attrs, out);
        open_at(self.denominator, denominator_at, out);
        out.push_str(&denominator_body);
        close(self.denominator, out);
        bar_width - self.bar_width
    }
}

/// A radical is a hook-and-vinculum path (`M` plus four `L` points) with the content
/// translated below the bar. The bar was drawn to the content's width, so changing the
/// content's width moves the path's last point by the same amount.
struct Radical<'a> {
    path_index: usize,
    path: &'a Leaf,
    content_index: usize,
    content: &'a Group,
    points: Vec<(char, f64, f64)>,
}

impl<'a> Radical<'a> {
    fn measure(children: &'a [Node]) -> Option<Self> {
        let mut path = None;
        for (index, child) in children.iter().enumerate() {
            let Node::Leaf(leaf) = child else { continue };
            if leaf.name != "path" {
                continue;
            }
            if path.is_some() {
                return None;
            }
            path = Some((index, leaf));
        }
        let (path_index, path) = path?;
        let points = path_points(path.attrs.get("d")?)?;
        if points.len() != 5 || points[0].0 != 'M' || points[1..].iter().any(|p| p.0 != 'L') {
            return None;
        }
        // The fourth point is where the overbar meets the content, the fifth its end.
        let (_, content_x, line_y) = points[3];
        let (_, end_x, end_y) = points[4];
        if (line_y - end_y).abs() > POSITION_STEP / 2.0 || end_x <= content_x {
            return None;
        }
        let mut content = None;
        for (index, child) in children.iter().enumerate() {
            let Node::Group(group) = child else { continue };
            let Some((x, y)) = group.position() else {
                continue;
            };
            if (x - content_x).abs() < POSITION_STEP && y > line_y {
                if content.is_some() {
                    return None;
                }
                content = Some((index, group));
            }
        }
        let (content_index, content) = content?;
        Some(Self {
            path_index,
            path,
            content_index,
            content,
            points,
        })
    }

    fn emit(&self, children: &[Node], out: &mut String) -> f64 {
        let mut content_body = String::new();
        let delta = emit_contents(self.content, &mut content_body);
        for (index, child) in children.iter().enumerate() {
            if index == self.content_index {
                open(self.content, 0.0, out);
                out.push_str(&content_body);
                close(self.content, out);
            } else if index == self.path_index {
                let mut attrs = self.path.attrs.clone();
                if delta != 0.0 {
                    attrs.set("d", rewrite_path(&self.points, self.points[4].1 + delta));
                }
                self.path.render_with(&attrs, out);
            } else {
                child.render(out);
            }
        }
        delta
    }
}

/// The points of a path made of `M` and `L` commands, one point per command. `None` for
/// any other command or for a command with numbers attached, which the pass does not
/// rewrite.
fn path_points(d: &str) -> Option<Vec<(char, f64, f64)>> {
    let mut tokens = d.split_whitespace();
    let mut points = Vec::new();
    while let Some(command) = tokens.next() {
        let mut chars = command.chars();
        let cmd = chars.next()?;
        if chars.next().is_some() {
            return None;
        }
        let x: f64 = tokens.next()?.parse().ok()?;
        let y: f64 = tokens.next()?.parse().ok()?;
        points.push((cmd, x, y));
    }
    Some(points)
}

/// The path with its last point's x replaced; every other number keeps its value.
fn rewrite_path(points: &[(char, f64, f64)], last_x: f64) -> String {
    let mut out = String::new();
    for (index, (command, x, y)) in points.iter().enumerate() {
        if index > 0 {
            out.push(' ');
        }
        let x = if index + 1 == points.len() {
            last_x
        } else {
            *x
        };
        let _ = write!(out, "{command} {x:.2} {y:.2}");
    }
    out
}

/// The change the gap after `children[index]` needs.
fn gap_after(children: &[Node], index: usize) -> Option<Gap> {
    // An operator needs an operand on both sides, so the first child of a row - a
    // prefix sign such as the `-` of `-1 + x` - never takes a margin.
    if index == 0 {
        return None;
    }
    let next = children.get(index + 1)?;
    let node = &children[index];
    if let Some((gap, target)) = product_gap(node, next) {
        return (gap > target + POSITION_STEP).then_some(Gap {
            before: 0.0,
            after: target - gap,
        });
    }
    token_margin(node, next).map(|margin| Gap {
        before: margin,
        after: margin,
    })
}

/// The gap the layout left after a product's separator, and the thin space it should
/// be. The target is a ratio of the cell the separator occupies, not of the gap it was
/// drawn with, so re-running the pass over its own output changes nothing.
fn product_gap(node: &Node, next: &Node) -> Option<(f64, f64)> {
    let text = sole_text(node)?;
    let chars = text.content.chars().count();
    if chars == 0 || !text.content.chars().all(|c| c == ' ') {
        return None;
    }
    let gap = position(next)?.0 - position(node)?.0;
    let target = chars as f64 * cell(text)? * THIN_SPACE_RATIO;
    (gap > 0.0).then_some((gap, target))
}

/// The margin a relation token needs on each side, or `None` when the token is not one
/// the pass knows or when the layout already gave it a margin of its own.
fn token_margin(node: &Node, next: &Node) -> Option<f64> {
    let text = sole_text(node)?;
    let token = decode(&text.content);
    let tier = relation_tier(&token)?;
    let cell = cell(text)?;
    let advance = cell * token.chars().count() as f64;
    let gap = position(next)?.0 - (position(node)?.0 + advance);
    // The tokens `operator_space` lists are drawn with their margin already. This pass
    // only supplies the ones it does not, and only where the layout left them flush.
    if gap.abs() > POSITION_STEP {
        return None;
    }
    Some(cell * tier)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn svg_of(statement: &str) -> String {
        let result = woxi::interpret_with_stdout(statement).expect("evaluate");
        result.output_svg.expect("typeset output")
    }

    fn width_of(svg: &str) -> f64 {
        let (attrs, ..) = parse(svg).expect("parse");
        attrs.number("width").expect("width")
    }

    fn respaced(statement: &str) -> String {
        respace_svg(&svg_of(statement))
    }

    /// The attribute the pass always adds, for comparing what the spacing did.
    fn layout_size() -> String {
        format!(" data-woxi-font-size=\"{LAYOUT_FONT_SIZE}\"")
    }

    /// Whether the pass found no gap to change, which is the common case.
    fn unchanged(statement: &str) -> bool {
        let svg = svg_of(statement);
        respace_svg(&svg).replace(&layout_size(), "") == svg
    }

    fn attribute(svg: &str, key: &str) -> Option<String> {
        let (attrs, ..) = parse(svg).expect("parse");
        attrs.get(key).map(str::to_string)
    }

    /// Absolute x and text of every text run, in document order.
    fn runs(svg: &str) -> Vec<(f64, String)> {
        let (_, _, nodes) = parse(svg).expect("parse");
        fn walk(nodes: &[Node], x: f64, out: &mut Vec<(f64, String)>) {
            for node in nodes {
                match node {
                    Node::Group(group) => {
                        walk(
                            &group.children,
                            x + group.position().unwrap_or((0.0, 0.0)).0,
                            out,
                        );
                    }
                    Node::Text(text) => out.push((x, decode(&text.content).into_owned())),
                    _ => {}
                }
            }
        }
        let mut out = Vec::new();
        walk(&nodes, 0.0, &mut out);
        out
    }

    /// The x of the last point of the first radical path, i.e. the end of its vinculum.
    fn radical_end(svg: &str) -> f64 {
        fn walk(nodes: &[Node]) -> Option<f64> {
            for node in nodes {
                match node {
                    Node::Leaf(leaf) if leaf.name == "path" => {
                        let points = path_points(leaf.attrs.get("d")?)?;
                        if points.len() == 5
                            && points[3].0 == 'L'
                            && points[4].0 == 'L'
                            && (points[3].2 - points[4].2).abs() < 0.05
                        {
                            return Some(points[4].1);
                        }
                    }
                    Node::Group(group) => {
                        if let Some(x) = walk(&group.children) {
                            return Some(x);
                        }
                    }
                    _ => {}
                }
            }
            None
        }
        let (_, _, nodes) = parse(svg).expect("parse");
        walk(&nodes).expect("radical path")
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 0.15
    }

    /// One cell of the layout's grid at the font size it lays text out at.
    fn cell() -> f64 {
        LAYOUT_FONT_SIZE * MONO_ADVANCE
    }

    /// The margin a token of the given tier gets, in layout pixels.
    fn margin(tier: f64) -> f64 {
        tier * cell()
    }

    /// How a fraction came out: the bar, the rows and the padding between them.
    struct Measured {
        bar: f64,
        numerator: f64,
        numerator_x: f64,
        denominator: f64,
        denominator_x: f64,
        padding: f64,
    }

    fn measure_fraction(svg: &str) -> Measured {
        fractions(svg).remove(0)
    }

    /// Every fraction in the document, outermost first.
    fn fractions(svg: &str) -> Vec<Measured> {
        fn walk<'a>(children: &'a [Node], out: &mut Vec<Fraction<'a>>) {
            if let Some(fraction) = Fraction::measure(children) {
                out.push(fraction);
            }
            for child in children {
                if let Node::Group(group) = child {
                    walk(&group.children, out);
                }
            }
        }
        let (_, _, nodes) = parse(svg).expect("parse");
        let mut found = Vec::new();
        walk(&nodes, &mut found);
        found
            .into_iter()
            .map(|fraction| Measured {
                bar: fraction.bar_width,
                numerator: fraction.numerator_width,
                numerator_x: fraction.numerator_at.0,
                denominator: fraction.denominator_width,
                denominator_x: fraction.denominator_at.0,
                padding: fraction.padding,
            })
            .collect()
    }

    #[test]
    fn the_cell_matches_the_advance_the_layout_reserves() {
        // Two one-character atoms: the layout placed the second one cell after the
        // first, so the constant this module measures tokens with is the layout's own.
        let runs = runs(&svg_of("f[x, y]"));
        assert!(close(runs[1].0 - runs[0].0, cell()), "{runs:?}");
    }

    #[test]
    fn the_thin_space_is_the_ratio_the_layout_uses() {
        // The traditional formatter writes a U+2009 between factors, and the layout draws
        // it as two runs of one box string, the second one thin gap after the first. The
        // ratio a product's gap is shrunk to is therefore the layout's own.
        let svg = svg_of("TraditionalForm[a b]");
        let expected = format!("x=\"{:.2}\"", THIN_SPACE_RATIO * cell());
        assert!(svg.contains(&expected), "{svg}");
    }

    #[test]
    fn a_rule_gets_the_margin_of_a_rule() {
        let after = respaced("x -> 1");
        let runs = runs(&after);
        assert_eq!(runs.len(), 3, "{runs:?}");
        assert!(close(runs[1].0, cell() + margin(RULE_MARGIN)), "{runs:?}");
        assert!(
            close(runs[2].0, 2.0 * cell() + 2.0 * margin(RULE_MARGIN)),
            "{runs:?}"
        );
        // 17.7 + two 5.31 margins + the last cell, rounded up.
        assert_eq!(width_of(&after), 38.0);
    }

    #[test]
    fn a_delayed_rule_gets_the_same_margin() {
        let runs = runs(&respaced("x :> 1"));
        assert_eq!(runs.len(), 3, "{runs:?}");
        assert!(close(runs[1].0, cell() + margin(RULE_MARGIN)), "{runs:?}");
        assert!(close(runs[1].0 - runs[0].0, cell() + margin(RULE_MARGIN)));
    }

    #[test]
    fn every_equality_spelling_gets_a_margin() {
        for (statement, token) in [
            ("x == 1", 2.0),
            ("x != 1", 2.0),
            ("x <= 1", 2.0),
            ("Hold[a === b]", 3.0),
            ("Hold[a =!= b]", 3.0),
            ("Hold[a <> b]", 2.0),
            ("Hold[a += 1]", 2.0),
            ("Hold[a -= 1]", 2.0),
            ("Hold[a *= 1]", 2.0),
            ("Hold[a /= 1]", 2.0),
            ("Hold[a ^= 1]", 2.0),
            ("Hold[a := 1]", 2.0),
        ] {
            let runs = runs(&respaced(statement));
            let operator = runs
                .iter()
                .position(|(_, text)| relation_tier(text).is_some())
                .unwrap_or_else(|| panic!("{statement}: no operator in {runs:?}"));
            // Measured from the operand before it, so a row nested in a call reads the
            // same as a bare one.
            let origin = runs[operator - 1].0;
            let (x, _) = runs[operator];
            let (next, _) = runs[operator + 1];
            assert!(
                close(x - origin, cell() + margin(EQUALITY_MARGIN)),
                "{statement}: {runs:?}"
            );
            assert!(
                close(
                    next - origin,
                    cell() + margin(EQUALITY_MARGIN) + token * cell() + margin(EQUALITY_MARGIN)
                ),
                "{statement}: {runs:?}"
            );
        }
    }

    #[test]
    fn logical_operators_get_their_own_margins() {
        // `&&`/`||` are the `∧`/`∨` tier. `|` is `Alternatives`, whose glyph the table
        // calls `VerticalSeparator` and spaces at 0.2.
        for (statement, tier) in [
            ("Hold[a && b]", LOGICAL_MARGIN),
            ("Hold[a || b]", LOGICAL_MARGIN),
            ("Hold[a | b]", ALTERNATIVES_MARGIN),
        ] {
            let runs = runs(&respaced(statement));
            let operator = runs
                .iter()
                .position(|(_, text)| relation_tier(text).is_some())
                .unwrap_or_else(|| panic!("{statement}: no operator in {runs:?}"));
            let origin = runs[operator - 1].0;
            let (x, text) = &runs[operator];
            assert!(
                close(*x - origin, cell() + margin(tier)),
                "{statement}: {runs:?}"
            );
            let width = text.chars().count() as f64 * cell();
            assert!(
                close(runs[operator + 1].0 - x, width + margin(tier)),
                "{statement}: {runs:?}"
            );
        }
    }

    #[test]
    fn a_token_the_table_does_not_list_gets_no_margin() {
        for token in ["′", "′′", "!", "^", "@", "~", "//", "[["] {
            assert!(relation_tier(token).is_none(), "{token}");
        }
        // The prime of a derivative advances less than a cell, so a margin computed
        // from the cell would be wrong there. No tier means no margin.
        assert!(unchanged("Hold[f'[x]]"));
    }

    #[test]
    fn a_product_gap_becomes_a_thin_space() {
        let before = svg_of("45 x^8 y^2");
        let after = respace_svg(&before);
        let runs = runs(&after);
        let space = runs
            .iter()
            .position(|(_, text)| text.chars().all(|c| c == ' '))
            .expect("space run");
        // The space run stays where the layout put it. The factor after it moves.
        assert!(
            close(runs[space + 1].0 - runs[space].0, THIN_SPACE_RATIO * cell()),
            "{runs:?}"
        );
        assert!(width_of(&after) < width_of(&before));
    }

    #[test]
    fn the_layout_size_is_recorded_for_the_client() {
        // A `Style[..., 24]` run is larger than the size the layout was asked for. The
        // attribute keeps the root size so the client does not infer it from the runs,
        // and a second pass replaces it rather than adding another.
        let svg = respaced("Style[x, 24] + y");
        assert!(svg.contains("font-size=\"24.0\""), "{svg}");
        assert_eq!(
            attribute(&svg, "data-woxi-font-size").as_deref(),
            Some("14")
        );
        let again = respace_svg(&svg);
        assert_eq!(again, svg);
        assert_eq!(again.matches("data-woxi-font-size").count(), 1, "{again}");
    }

    #[test]
    fn a_layout_the_pass_does_not_model_is_left_alone() {
        // A question panel sets its own font size on the root and draws its rows
        // itself.
        let panel = concat!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\" height=\"20\"",
            " viewBox=\"0 0 100 20\" font-size=\"14\">",
            "<text x=\"1\" y=\"10\">hi</text></svg>"
        );
        assert!(respace_document(panel).is_none());
        assert_eq!(respace_svg(panel), panel);
    }

    #[test]
    fn whitespace_between_elements_is_tolerated() {
        let spaced = "<svg width=\"20\" height=\"20\"><g>\n  <g transform=\"translate(0.0,0.0)\"><text x=\"0\" y=\"11.2\" font-size=\"14.0\">x</text></g>\n</g></svg>";
        let respaced = respace_document(spaced).expect("parse");
        assert!(!respaced.contains('\n'), "{respaced}");
        assert!(respaced.ends_with("</svg>"));
    }

    #[test]
    fn text_between_elements_is_refused() {
        let text = "<svg width=\"20\" height=\"20\"><g>junk</g></svg>";
        assert!(respace_document(text).is_none());
        assert_eq!(respace_svg(text), text);
    }

    #[test]
    fn the_layouts_own_operators_are_left_alone() {
        for statement in ["x + 1", "x - 1", "x < 1", "x = 1", "Hold[x > 0]"] {
            assert!(unchanged(statement), "{statement}");
        }
    }

    #[test]
    fn a_fraction_is_recentered_around_its_new_bar() {
        let before = measure_fraction(&svg_of("(3 x)/2"));
        let after = measure_fraction(&respaced("(3 x)/2"));
        assert!(after.bar < before.bar, "{} vs {}", after.bar, before.bar);
        // Each row is centered in the bar again, and the bar is the wider row plus the
        // padding the layout adds.
        assert!(close(
            after.numerator_x,
            (after.bar - after.numerator) / 2.0
        ));
        assert!(close(
            after.denominator_x,
            (after.bar - after.denominator) / 2.0
        ));
        assert!(close(
            after.bar,
            after.numerator.max(after.denominator) + after.padding
        ));
        // The padding is the layout's, read from the document, not a number of ours.
        assert!(close(after.padding, before.padding));
    }

    #[test]
    fn a_product_inside_a_fraction_keeps_the_bar_around_both_rows() {
        let before = measure_fraction(&svg_of("Hold[1/(2 x)]"));
        let after = measure_fraction(&respaced("Hold[1/(2 x)]"));
        assert!(after.denominator < before.denominator);
        assert!(close(
            after.bar,
            after.numerator.max(after.denominator) + after.padding
        ));
        assert!(close(
            after.numerator_x,
            (after.bar - after.numerator) / 2.0
        ));
        assert!(close(
            after.denominator_x,
            (after.bar - after.denominator) / 2.0
        ));
    }

    #[test]
    fn nested_fractions_keep_their_own_bars() {
        for statement in ["Hold[(1/2)/(3/4)]", "Hold[(x/2)/(y/3)]"] {
            let before = fractions(&svg_of(statement));
            let after = fractions(&respaced(statement));
            assert_eq!(before.len(), 2, "{statement}: outer and inner");
            assert_eq!(after.len(), 2, "{statement}");
            // The inner fraction is the outer denominator, so its shrink carries up.
            assert!(after[1].bar < before[1].bar, "{statement}");
            assert!(after[0].bar < before[0].bar, "{statement}");
            for (index, fraction) in after.iter().enumerate() {
                assert!(
                    close(
                        fraction.bar,
                        fraction.numerator.max(fraction.denominator) + fraction.padding
                    ),
                    "{statement}: fraction {index} {}",
                    fraction.bar
                );
            }
        }
    }

    #[test]
    fn a_radical_shortens_its_vinculum_with_its_content() {
        let before = svg_of("Hold[Sqrt[2 x]]");
        let after = respace_svg(&before);
        let runs = runs(&after);
        let space = runs
            .iter()
            .position(|(_, text)| text.chars().all(|c| c == ' '))
            .expect("space run");
        assert!(
            close(runs[space + 1].0 - runs[space].0, THIN_SPACE_RATIO * cell()),
            "{runs:?}"
        );
        assert!(radical_end(&after) < radical_end(&before));
        assert!(width_of(&after) < width_of(&before));
    }

    #[test]
    fn a_radical_in_a_row_moves_what_follows_it() {
        let before = svg_of("Hold[Sqrt[2 x] + y z]");
        let after = respace_svg(&before);
        let before_runs = runs(&before);
        let after_runs = runs(&after);
        let plus_before = before_runs
            .iter()
            .position(|(_, text)| text == "+")
            .expect("plus");
        let plus_after = after_runs
            .iter()
            .position(|(_, text)| text == "+")
            .expect("plus");
        // The radical's content shrinks, so the `+` moves left by exactly that much. The
        // product after it shrinks independently.
        assert!(
            close(
                after_runs[plus_after].0 - before_runs[plus_before].0,
                radical_end(&after) - radical_end(&before)
            ),
            "{after_runs:?}"
        );
        // Both products are thin now, not only the one outside the radical.
        let spaces: Vec<usize> = after_runs
            .iter()
            .enumerate()
            .filter(|(_, (_, text))| text.chars().all(|c| c == ' '))
            .map(|(index, _)| index)
            .collect();
        assert_eq!(spaces.len(), 2, "{after_runs:?}");
        for space in spaces {
            assert!(
                close(
                    after_runs[space + 1].0 - after_runs[space].0,
                    THIN_SPACE_RATIO * cell()
                ),
                "{after_runs:?}"
            );
        }
    }

    #[test]
    fn a_single_atom_radical_is_unchanged() {
        // Nothing inside it moves, so the path is not rewritten.
        assert!(unchanged("Hold[Sqrt[x]]"));
    }

    #[test]
    fn a_fraction_with_a_radical_is_recentered() {
        let before = measure_fraction(&svg_of("Hold[Sqrt[2 x]/3]"));
        let after = measure_fraction(&respaced("Hold[Sqrt[2 x]/3]"));
        assert!(after.bar < before.bar);
        assert!(close(
            after.numerator_x,
            (after.bar - after.numerator) / 2.0
        ));
        assert!(close(
            after.denominator_x,
            (after.bar - after.denominator) / 2.0
        ));
        assert!(close(
            after.bar,
            after.numerator.max(after.denominator) + after.padding
        ));
    }

    #[test]
    fn a_row_with_a_bare_text_is_left_alone() {
        // A child without a `translate()` cannot be shifted, so the pass must not move
        // its siblings around it.
        let svg = "<svg width=\"26\" height=\"15\"><g><text x=\"0\" y=\"11.2\" font-size=\"14.0\">a</text><g transform=\"translate(8.8,0.0)\"><text x=\"0\" y=\"11.2\" font-size=\"14.0\"> </text></g><g transform=\"translate(17.7,0.0)\"><text x=\"0\" y=\"11.2\" font-size=\"14.0\">b</text></g></g></svg>";
        let respaced = respace_document(svg).expect("parse");
        assert_eq!(respaced.replace(&layout_size(), ""), svg);
    }

    #[test]
    fn traditional_form_keeps_its_own_spacing() {
        assert!(unchanged("TraditionalForm[45 x^8 y^2]"));
        assert!(unchanged("TraditionalForm[x -> 1]"));
        // Its box formatter writes the delayed rule as the private-use codepoint the
        // operator table does not list, so that one is still spaced (at the rule tier).
        let before = svg_of("TraditionalForm[x :> 1]");
        let after = respace_svg(&before);
        assert_ne!(after, before);
        let runs = runs(&after);
        assert!(close(runs[1].0 - runs[0].0, cell() + margin(RULE_MARGIN)));
    }

    #[test]
    fn brackets_are_not_operators() {
        for statement in [
            "Hold[a[[1]]]",
            "Hold[f[x][y]]",
            "Hold[f[x, y]]",
            "{1, 2, 3}",
        ] {
            assert!(unchanged(statement), "{statement}");
        }
    }

    #[test]
    fn only_the_rule_inside_an_association_is_spaced() {
        let before = svg_of("Hold[<|a -> 1|>]");
        let after = respace_svg(&before);
        let before_runs = runs(&before);
        let after_runs = runs(&after);
        // The association brackets stay put. Everything from the rule's margin on
        // moves right by it, so the arrow is where the shift starts.
        assert!(close(before_runs[2].0, after_runs[2].0), "{after_runs:?}");
        let first_moved = before_runs
            .iter()
            .zip(&after_runs)
            .position(|((x, _), (y, _))| !close(*x, *y))
            .expect("something moved");
        assert_eq!(after_runs[first_moved].1, "→", "{after_runs:?}");
        assert!(close(
            after_runs[first_moved].0 - before_runs[first_moved].0,
            margin(RULE_MARGIN)
        ));
    }

    #[test]
    fn lists_and_calls_are_untouched() {
        for statement in [
            "{1, 2, 3}",
            "f[x, y]",
            "N[Pi, 30]",
            "12345678901234",
            "{{1, 2}, {3, 4}}",
        ] {
            assert!(unchanged(statement), "{statement}");
        }
    }

    #[test]
    fn terms_keep_the_layouts_margins_between_them() {
        let before = svg_of("Expand[(x + y)^3]");
        let after = respace_svg(&before);
        assert!(width_of(&after) < width_of(&before));
        let runs = runs(&after);
        for (index, (x, text)) in runs.iter().enumerate() {
            if text != "+" {
                continue;
            }
            let (next, _) = runs[index + 1];
            assert!(
                close(next - (x + cell()), margin(EQUALITY_MARGIN)),
                "{runs:?}"
            );
        }
    }

    #[test]
    fn the_pass_is_idempotent() {
        for statement in [
            "x -> 1",
            "x == 1",
            "45 x^8 y^2",
            "a b c",
            "Expand[(x + y)^10]",
            "{x -> 1, y -> 2}",
            "(3 x)/2",
            "Hold[1/(2 x)]",
            "Hold[(1/2)/(3/4)]",
            "Hold[(x/2)/(y/3)]",
            "Hold[1/(1 + 1/x)]",
            "Hold[a | b]",
            "Hold[Sqrt[2 x]]",
            "Hold[Sqrt[2 x] + y z]",
            "Hold[Sqrt[2 x]/3]",
            "Hold[Sqrt[1/(2 x)]]",
            "Hold[Sqrt[a -> b]]",
            "Hold[a && b]",
            "Hold[a || b]",
            "Style[x, 24] + y",
            "TraditionalForm[x :> 1]",
        ] {
            let once = respaced(statement);
            let twice = respace_svg(&once);
            assert_eq!(once, twice, "{statement}");
        }
    }

    #[test]
    fn every_supported_output_parses() {
        // A document the parser refuses is silently left unspaced, so the shapes the
        // layout can produce are pinned here.
        for statement in [
            "x -> 1",
            "x == 1",
            "x + 1",
            "45 x^8 y^2",
            "1/2",
            "(3 x)/2",
            "1/2 + x^2",
            "Pi^2/6",
            "Sqrt[x^2 + y^2]",
            "Expand[(x + y)^10]",
            "{1, 2, 3}",
            "{x -> 1, y -> 2}",
            "{{1, 2}, {3, 4}}",
            "f[x, y]",
            "Sin[x]",
            "N[Pi, 30]",
            "12345678901234",
            "1.23456789123`*^8",
            "1/3.0",
            "Hold[Sqrt[2 x]]",
            "Hold[1/(2 x)]",
            "Hold[(1/2)/(3/4)]",
            "Hold[a[[1]]]",
            "Hold[<|a -> 1|>]",
            "Hold[Piecewise[{{x, x > 0}}, -x]]",
            "Hold[Grid[{{a, b}, {c, d}}]]",
            "Hold[Framed[a + b]]",
            "Hold[Style[a + b, Bold]]",
            "Hold[Hyperlink[{\"w\", \"https://x\"}]]",
            "Hold[Subscript[a, b] == c]",
            "Hold[(# + 1) &]",
            "TraditionalForm[x -> 1]",
            "TraditionalForm[(3 x)/2]",
            "TraditionalForm[45 x^8 y^2]",
            "Integrate[Exp[-x^2], {x, -Infinity, Infinity}]",
            "Sum[1/n^2, {n, 1, Infinity}]",
        ] {
            let svg = svg_of(statement);
            assert!(respace_document(&svg).is_some(), "{statement}");
            assert!(respace_svg(&svg).ends_with("</svg>"), "{statement}");
        }
    }

    #[test]
    fn an_unknown_document_is_left_alone() {
        for text in [
            "",
            "<svg",
            "<svg width=\"10\" height=\"10\">",
            "<svg width=\"10\" height=\"10\"><g></svg>",
            "<svg width=\"ten\" height=\"10\"></svg>",
            "<svg width=\"10\" height=\"10\"></svg>trailing",
        ] {
            assert!(respace_document(text).is_none(), "{text}");
            assert_eq!(respace_svg(text), text, "{text}");
        }
    }

    #[test]
    fn an_unchanged_document_only_gains_the_layout_size() {
        // Parsing and re-rendering has to be invisible apart from the attribute the
        // client reads, which pins the attribute order, the quoting and the number
        // formatting.
        for statement in ["x + 1", "{1, 2, 3}", "N[Pi, 30]", "1/2", "Style[x, 24]"] {
            let svg = svg_of(statement);
            let markup = respace_document(&svg).expect("parse");
            assert_eq!(markup.replace(&layout_size(), ""), svg, "{statement}");
        }
    }
}
