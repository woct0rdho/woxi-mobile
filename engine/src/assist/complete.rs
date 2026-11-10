//! Completion: the symbol table, Woxi's frequency prior, the tiered matcher and the
//! ranked candidates.

use crate::json::{json_escape, json_field_number, json_field_text};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

/// Upper bound on a completion reply, whatever the request asks for.
pub(crate) const MAX_MATCHES: usize = 200;

/// Woxi's ordering of how fundamental each symbol is: `List` 1, `Rule` 2, `Times` 3,
/// ... `Plot` 21, `Sin` 22. It is the closest thing the registry has to a usage count,
/// and it is a better prior than name length: `PlotPoints` (193) is far likelier than
/// `PetersenGraph` (1620), which is exactly the `pts` case.
pub(crate) static RANKS: LazyLock<HashMap<&'static str, u32>> = LazyLock::new(|| {
    let mut table = HashMap::new();
    for line in include_str!("../../data/functions.csv").lines().skip(1) {
        // name,"description",status,effect_level,version,rank - the name is never
        // quoted and the rank is the last field, so the middle columns can be skipped.
        let Some((name, rest)) = line.split_once(',') else {
            continue;
        };
        let Some((_, rank)) = rest.rsplit_once(',') else {
            continue;
        };
        if let Ok(rank) = rank.trim().parse::<u32>() {
            table.insert(name, rank);
        }
    }
    table
});

/// A coarse frequency band of a name, or `None` when the registry does not rank it
/// (user symbols, package contexts). The first hundred names share a band so that
/// among them length still decides, which is what puts `Plot` before `Power` for `P`.
pub(crate) fn rank_band(name: &str) -> Option<u32> {
    let rank = RANKS.get(name)?;
    Some(if *rank < 100 { 0 } else { 1 + rank / 1000 })
}

/// Names past this band are offered only when the query is specific (see
/// [`is_specific`]) or when the document already uses them: about a third of the
/// registry, the tail that would otherwise crowd the bar while typing three letters.
pub(crate) const RARE_BAND: u32 = 4;

/// A name the registry does not rank this long is presumed rare: nobody types
/// `VectorFieldPlots`ListVectorFieldPlot` in full on a phone.
pub(crate) const LONG_NAME: usize = 20;

/// A typed fragment this long is specific on its own: it names a word, not a letter.
pub(crate) const SPECIFIC_LEN: usize = 4;

/// Every symbol the interpreter knows, with whether Woxi implements it. Built once
/// from the `functions.csv` embedded in the interpreter, so a rebuild of the engine
/// is the only thing that can change it. `is_known_wolfram_function` is the
/// interpreter's own answer for "this name exists in Wolfram Language but Woxi does
/// not run it yet", which is the flag the completion list needs.
pub(crate) static SYMBOLS: LazyLock<Vec<(&'static str, bool)>> = LazyLock::new(|| {
    let mut table: Vec<(&'static str, bool)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for name in woxi::evaluator::functions::get_builtin_function_names() {
        if seen.insert(name) {
            table.push((
                name,
                !woxi::evaluator::functions::is_known_wolfram_function(name),
            ));
        }
    }
    for name in woxi::evaluator::functions::known_wolfram_function_names() {
        if seen.insert(name) {
            table.push((name, false));
        }
    }
    table.sort_unstable();
    table
});

pub(crate) fn symbol_table() -> &'static [(&'static str, bool)] {
    SYMBOLS.as_slice()
}

/// Whether `name` is a plain symbol name: the `Options[...]` probe below builds code
/// from it, so anything that could carry an operator or a bracket is refused.
pub(crate) fn is_symbol_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '$' => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '$' || ch == '`')
}

pub(crate) fn is_identifier_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '$' || ch == '`'
}

/// The identifier that ends at `cursor`, with the byte offset it starts at. The
/// caret is clamped to a character boundary: the request comes from JavaScript,
/// whose string offsets are UTF-16 code units.
pub(crate) fn identifier_before(code: &str, cursor: usize) -> (usize, &str) {
    let mut end = cursor.min(code.len());
    while end > 0 && !code.is_char_boundary(end) {
        end -= 1;
    }
    let mut start = end;
    for (index, ch) in code[..end].char_indices().rev() {
        if !is_identifier_char(ch) {
            break;
        }
        start = index;
    }
    (start, &code[start..end])
}

/// The identifier the caret is in or next to. Used by `inspect_request`, where the
/// caret may sit inside the name rather than after it.
pub(crate) fn identifier_at_cursor(code: &str, cursor: usize) -> &str {
    let mut start = cursor.min(code.len());
    while start > 0 && !code.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = start;
    for (index, ch) in code[start..].char_indices() {
        if !is_identifier_char(ch) {
            break;
        }
        end = start + index + ch.len_utf8();
    }
    let tail = start;
    for (index, ch) in code[..tail].char_indices().rev() {
        if !is_identifier_char(ch) {
            break;
        }
        start = index;
    }
    &code[start..end]
}

/// Whether `needle` is a subsequence of `haystack` that starts at its first character.
/// A loose subsequence would make a two-letter prefix match hundreds of names (`lo`
/// would find `Plot`), which is noise on a bar that shows three of them.
/// Whether the character at `index` starts a word of a symbol name: the name's start,
/// a capital after a lower-case letter or a digit, a digit after a letter, or anything
/// after `$`. CamelCase names are the only word structure Wolfram names have.
pub(crate) fn is_word_start(chars: &[char], index: usize) -> bool {
    if index == 0 {
        return true;
    }
    let previous = chars[index - 1];
    let current = chars[index];
    if previous == '$' {
        return true;
    }
    if current.is_ascii_uppercase() && (previous.is_ascii_lowercase() || previous.is_ascii_digit())
    {
        return true;
    }
    current.is_ascii_digit() && previous.is_ascii_alphabetic()
}

/// The indices where a word starts in a symbol name (see [`is_word_start`]).
pub(crate) fn word_starts(chars: &[char]) -> Vec<usize> {
    (0..chars.len())
        .filter(|&index| is_word_start(chars, index))
        .collect()
}

/// Whether `segment` matches the word `name[word_start..word_end]`, and where its last
/// character landed. The segment has to start the word. Its remaining characters may
/// skip letters inside it, which is how `Rng` reads `Range`.
pub(crate) fn match_segment(
    segment: &[char],
    name: &[char],
    word_start: usize,
    word_end: usize,
) -> Option<usize> {
    let first = segment.first()?;
    if !name[word_start].eq_ignore_ascii_case(first) {
        return None;
    }
    let mut index = word_start + 1;
    let mut last = word_start;
    for wanted in &segment[1..] {
        let position = (index..word_end).find(|&i| name[i].eq_ignore_ascii_case(wanted))?;
        last = position;
        index = position + 1;
    }
    Some(last)
}

/// The span a fuzzy match covers and how many words it touches, or `None`.
///
/// A fuzzy match is an abbreviation of whole words: the query is split at its
/// capitals, and each piece has to match one word of the name, starting with that
/// word's first letter. `PP` is `PlotPoints`, `PltRng` is `PlotRange`, `Rng` is
/// `Range`, `PS` is `PlotStyle`. What it does not do is pick letters across word
/// middles (`pts` cannot reach `PlotPoints` through `PacletSite`-style skipping),
/// which is what keeps the list quiet.
pub(crate) fn abbreviation_span(query: &[char], name: &[char]) -> Option<(usize, usize)> {
    if query.is_empty() {
        return None;
    }
    let starts = word_starts(name);
    let mut segment_start = 0;
    let mut word_index = 0;
    let mut first_match = None;
    let mut last_match = 0;
    let mut words = 0;
    for index in 1..=query.len() {
        if index < query.len() && !query[index].is_ascii_uppercase() {
            continue;
        }
        let segment = &query[segment_start..index];
        let mut matched = None;
        for (position, &start) in starts.iter().enumerate().skip(word_index) {
            let end = starts.get(position + 1).copied().unwrap_or(name.len());
            if let Some(last) = match_segment(segment, name, start, end) {
                matched = Some((position + 1, start, last));
                break;
            }
        }
        let (next_word, start, last) = matched?;
        if first_match.is_none() {
            first_match = Some(start);
        }
        last_match = last;
        word_index = next_word;
        segment_start = index;
        words += 1;
    }
    Some((last_match - first_match? + 1, words))
}

/// The score of an abbreviation: a tighter match is a better one, so `PP` prefers
/// `PlotPoints` (initials five bytes apart) over `PrimePi` (six).
pub(crate) fn abbreviation_score(span: usize) -> i32 {
    -i32::try_from(span).unwrap_or(0)
}

/// A substring query shorter than this matches too many names to be useful: `pl`
/// appears inside every `...Plot` name.
pub(crate) const SUBSTRING_MIN_LEN: usize = 3;

/// How well `name` answers `prefix`. Lower tiers come first: exact name, prefix,
/// CamelCase initials, substring at a word start (`Range` -> `PlotRange`), substring
/// anywhere, and only then a fuzzy abbreviation, which the caller asks for when the
/// sharper tiers are empty.
pub(crate) struct Quality {
    tier: u8,
    /// Higher is better. Only meaningful within a tier.
    score: i32,
    /// How many words of the name the query touches. An abbreviation that covers
    /// every word of a long name is specific even when it is short (`RngFlt`), which
    /// is how rare names stay reachable.
    words: usize,
}

pub(crate) fn match_quality(prefix: &str, name: &str) -> Option<Quality> {
    if prefix.is_empty() {
        // Browsing: nothing is more relevant than anything else, the caller sorts by
        // status, frequency and name.
        return Some(Quality {
            tier: 9,
            score: 0,
            words: 0,
        });
    }
    let wanted = prefix.to_ascii_lowercase();
    let candidate = name.to_ascii_lowercase();
    if candidate == wanted {
        return Some(Quality {
            tier: 0,
            score: 0,
            words: 0,
        });
    }
    if candidate.starts_with(&wanted) {
        return Some(Quality {
            tier: 1,
            score: 0,
            words: 1,
        });
    }
    // CamelCase initials: `PP` is `PlotPoints`, `PS` is `PlotStyle`. The initials that
    // sit closest together win, so `PP` prefers `PlotPoints` over `PrimePi`.
    if prefix.chars().all(|ch| ch.is_ascii_uppercase()) {
        let initials: Vec<usize> = name
            .char_indices()
            .filter(|(_, ch)| ch.is_ascii_uppercase())
            .map(|(index, _)| index)
            .collect();
        if initials.len() >= prefix.chars().count()
            && initials
                .iter()
                .zip(prefix.chars())
                .all(|(&index, wanted)| name[index..].starts_with(wanted))
        {
            let first = initials[0];
            let last = initials[prefix.chars().count() - 1];
            return Some(Quality {
                tier: 2,
                score: -i32::try_from(last - first + 1).unwrap_or(0),
                words: prefix.chars().count(),
            });
        }
    }
    if wanted.chars().count() >= SUBSTRING_MIN_LEN {
        if let Some(offset) = candidate.find(&wanted) {
            let start = name[..offset].chars().count();
            let chars: Vec<char> = name.chars().collect();
            if is_word_start(&chars, start) {
                return Some(Quality {
                    tier: 3,
                    score: -i32::try_from(start).unwrap_or(0),
                    words: 1,
                });
            }
            let substring = Quality {
                tier: 5,
                score: -i32::try_from(start).unwrap_or(0),
                words: 1,
            };
            // A substring in the middle of a word is the weakest kind of match, but an
            // abbreviation of that word still counts: `pts` reaches `...Points` rather
            // than `Script...`, so try the words first and fall back to the substring.
            if let Some((span, words)) =
                abbreviation_span(&prefix.chars().collect::<Vec<char>>(), &chars)
            {
                return Some(Quality {
                    tier: 4,
                    score: abbreviation_score(span),
                    words,
                });
            }
            return Some(substring);
        }
    }
    // Fuzzy matching for one letter would list half the language.
    if wanted.chars().count() < 2 {
        return None;
    }
    let chars: Vec<char> = name.chars().collect();
    // The segments come from the query as typed: a capital starts a word of the name.
    let query: Vec<char> = prefix.chars().collect();
    let (span, words) = abbreviation_span(&query, &chars)?;
    Some(Quality {
        tier: 4,
        score: abbreviation_score(span),
        words,
    })
}

/// The documentation category of a symbol (`math`, `plotting`, ...), which is the
/// first path segment of its documentation URL.
pub(crate) fn category_of(name: &str) -> (&'static str, Option<&'static str>) {
    let Some(url) = woxi::evaluator::functions::get_doc_url(name) else {
        return ("", None);
    };
    let category = url
        .split_once("/docs/")
        .and_then(|(_, rest)| rest.split('/').next())
        .unwrap_or("");
    (category, Some(url))
}

/// One suggestion, with everything the bar and the sheet show about it.
pub(crate) struct Candidate {
    name: String,
    description: String,
    implemented: bool,
    session: bool,
    doc: Option<&'static str>,
    category: &'static str,
    tier: u8,
    /// Higher is better. Only meaningful within a tier.
    score: i32,
    /// A package-qualified name (`Context`Symbol`) or a system variable (`$Name`):
    /// real symbols, but rarely what a phone user is typing, so they sort last.
    quirk: bool,
    /// The frequency band of [`rank_band`]. `None` when the registry does not rank it.
    band: Option<u32>,
    /// Named somewhere in the document, which lifts a rare name to the front.
    used: bool,
}

/// The order the bar and the sheet show: what the user typed, then how often the name
/// shows up in Wolfram work, then the cheaper tie-breakers.
pub(crate) fn order(a: &Candidate, b: &Candidate) -> std::cmp::Ordering {
    a.tier
        .cmp(&b.tier)
        // Package-qualified names and system variables are real, but they are not what
        // a phone user is typing: they go after the plain names of a tier.
        .then_with(|| a.quirk.cmp(&b.quirk))
        // The document's own vocabulary beats any prior.
        .then_with(|| b.session.cmp(&a.session))
        .then_with(|| b.used.cmp(&a.used))
        .then_with(|| a.band.unwrap_or(u32::MAX).cmp(&b.band.unwrap_or(u32::MAX)))
        .then_with(|| b.score.cmp(&a.score))
        .then_with(|| b.implemented.cmp(&a.implemented))
        .then_with(|| a.name.len().cmp(&b.name.len()))
        .then_with(|| a.name.cmp(&b.name))
}

/// Whether a short query is specific enough to name a rare symbol: four characters,
/// an exact name, or an abbreviation that covers every word (`RngFlt` is specific,
/// `Rng` is not, even though both are three words' worth of letters).
pub(crate) fn is_specific(prefix: &str, quality: &Quality, name: &str) -> bool {
    if prefix.chars().count() >= SPECIFIC_LEN || quality.tier == 0 {
        return true;
    }
    if quality.words < 2 {
        return false;
    }
    let chars: Vec<char> = name.chars().collect();
    quality.words >= word_starts(&chars).len()
}

// Symbols the user has already written in this document. The engine is the only place
// that sees every entry, so it collects them from evaluated statements and from the
// typing-help requests, which carry the text around the caret.
thread_local! {
    pub(crate) static USED_SYMBOLS: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
}

pub(crate) fn is_builtin_name(name: &str) -> bool {
    symbol_table()
        .binary_search_by(|(known, _)| (*known).cmp(name))
        .is_ok()
}

pub(crate) fn remember_usage(code: &str) {
    if code.is_empty() {
        return;
    }
    let tokens = woxi::lsp::analysis::tokenize(code);
    let mut names = Vec::new();
    for token in &tokens {
        if token.kind != woxi::lsp::analysis::TokenKind::Symbol {
            continue;
        }
        let name = token.text(code);
        if is_builtin_name(name) {
            names.push(name.to_string());
        }
    }
    if names.is_empty() {
        return;
    }
    USED_SYMBOLS.with(|used| {
        let mut used = used.borrow_mut();
        for name in names {
            used.insert(name);
        }
    });
}

pub(crate) fn was_used(name: &str) -> bool {
    USED_SYMBOLS.with(|used| used.borrow().contains(name))
}

/// Fuzzy matches are only offered when the sharper tiers leave fewer than this many
/// candidates. Typing a prefix that already has answers never grows a fuzzy tail.
pub(crate) const FUZZY_MIN_SHARP: usize = 3;

/// How many of the weakest matches (a substring in the middle of a word) are kept, so
/// the list stays short even for a two-letter fragment.
pub(crate) const MAX_WEAK: usize = 20;

/// Ranked suggestions for the prefix before `cursor`, plus the span the frontend
/// should replace when one is accepted.
///
/// Two lists are built in one pass: the sharp matches (exact, prefix, substring) and
/// the fuzzy ones. Fuzzy matches are appended only when the sharp ones are scarce, so
/// typing `Plo` shows `Plot...` and nothing else, while `Rng` or `pts` still finds
/// `PlotRange` and `PlotPoints`.
pub(crate) fn candidates(
    code: &str,
    cursor: usize,
    limit: usize,
    category: &str,
) -> (usize, usize, usize, Vec<Candidate>) {
    let (start, prefix) = identifier_before(code, cursor);
    let mut sharp: Vec<Candidate> = Vec::new();
    let mut weak: Vec<Candidate> = Vec::new();

    let mut push = |name: String,
                    description: String,
                    implemented: bool,
                    session: bool,
                    doc: Option<&'static str>,
                    symbol_category: &'static str,
                    quality: Quality| {
        let quirk = name.contains('`') || name.starts_with('$');
        let band = rank_band(&name);
        let used = !session && was_used(&name);
        let rare = band.is_some_and(|band| band >= RARE_BAND)
            || (band.is_none() && name.chars().count() > LONG_NAME);
        // Low-frequency names are matched only when the query is specific or the
        // document already uses them. That is what keeps three typed letters from
        // listing the tail of the registry.
        if rare && !used && !is_specific(prefix, &quality, &name) {
            return;
        }
        let row = Candidate {
            name,
            description,
            implemented,
            session,
            doc,
            category: symbol_category,
            tier: quality.tier,
            score: quality.score,
            quirk,
            band,
            used,
        };
        if quality.tier >= 5 {
            if weak.len() < MAX_WEAK {
                weak.push(row);
            }
        } else {
            sharp.push(row);
        }
    };

    if category.is_empty() {
        for name in woxi::get_defined_names() {
            let Some(quality) = match_quality(prefix, &name) else {
                continue;
            };
            push(name, String::new(), true, true, None, "", quality);
        }
    }

    for (name, implemented) in symbol_table() {
        let Some(quality) = match_quality(prefix, name) else {
            continue;
        };
        let (symbol_category, doc) = category_of(name);
        if !category.is_empty() && symbol_category != category {
            continue;
        }
        let description = woxi::evaluator::functions::get_builtin_function_info(name)
            .map(|info| info.description.to_string())
            .unwrap_or_default();
        push(
            name.to_string(),
            description,
            *implemented,
            false,
            doc,
            symbol_category,
            quality,
        );
    }

    sharp.sort_by(order);
    let mut rows = sharp;
    if rows.len() < FUZZY_MIN_SHARP {
        weak.sort_by(order);
        rows.append(&mut weak);
    }
    let total = rows.len();
    rows.truncate(limit);
    (start, cursor, total, rows)
}

/// The caret position of a request, clamped to the code it points into.
pub(crate) fn cursor_of(json: &str, code: &str) -> usize {
    let raw = json_field_number(json, "cursor_pos").unwrap_or(code.len() as f64);
    let mut cursor = (raw.max(0.0) as usize).min(code.len());
    while cursor > 0 && !code.is_char_boundary(cursor) {
        cursor -= 1;
    }
    cursor
}

/// How much of a symbol Woxi implements. The four states matter to a user: "not
/// implemented yet" may arrive with a release, "not planned" never will.
pub(crate) fn status_name(name: &str) -> &'static str {
    use woxi::evaluator::functions::{implementation_status, ImplementationStatus};
    match implementation_status(name) {
        Some(ImplementationStatus::Implemented) => "implemented",
        Some(ImplementationStatus::Partial) => "partial",
        Some(ImplementationStatus::NotImplemented) => "not_implemented",
        Some(ImplementationStatus::NotPlanned) => "not_planned",
        None => "unknown",
    }
}

pub(crate) fn completion_content(json: &str) -> String {
    let code = json_field_text(json, "code").unwrap_or_default();
    // The entry is part of the document: a name written here counts as used, even if
    // the user has not run it yet.
    remember_usage(&code);
    let cursor = cursor_of(json, &code);
    let limit = json_field_number(json, "limit")
        .map(|value| (value.max(1.0) as usize).min(MAX_MATCHES))
        .unwrap_or(24);
    let category = json_field_text(json, "category").unwrap_or_default();
    let (start, end, total, rows) = candidates(&code, cursor, limit, &category);

    let mut matches = Vec::with_capacity(rows.len());
    let mut types = Vec::with_capacity(rows.len());
    let mut extra = Vec::with_capacity(rows.len());
    for row in &rows {
        matches.push(format!("\"{}\"", json_escape(&row.name)));
        types.push(format!(
            "{{\"text\":\"{}\",\"type\":\"{}\",\"docstring\":\"{}\"}}",
            json_escape(&row.name),
            if row.session { "variable" } else { "function" },
            json_escape(&row.description)
        ));
        extra.push(format!(
            "{{\"implemented\":{},\"status\":\"{}\",\"category\":\"{}\",\"doc\":\"{}\"}}",
            if row.implemented { 1 } else { 0 },
            status_name(&row.name),
            json_escape(row.category),
            json_escape(row.doc.unwrap_or(""))
        ));
    }

    format!(
        "{{\"matches\":[{}],\"cursor_start\":{},\"cursor_end\":{},\"metadata\":{{\"_jupyter_types_experimental\":[{}],\"_woxi\":[{}],\"total\":{}}}}}",
        matches.join(","),
        start,
        end,
        types.join(","),
        extra.join(","),
        total
    )
}
