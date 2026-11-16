//! Completion: the symbol table, Woxi's frequency prior, the tiered matcher and the
//! ranked candidates.

use crate::assist::inspect::options_of;
use crate::json::{json_escape, json_field_number, json_field_text, json_string_array};
use std::cell::RefCell;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::rc::Rc;
use std::sync::LazyLock;

/// Upper bound on a completion reply, whatever the request asks for.
pub(crate) const MAX_MATCHES: usize = 200;

/// The reply size when a request does not name a limit.
const DEFAULT_MATCHES: usize = 24;

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

/// The first hundred names share a band so that length still decides among them;
/// after that one band per thousand is fine-grained enough for the bar.
const BAND_HEAD: u32 = 100;
const BAND_WIDTH: u32 = 1_000;

/// A coarse frequency band of a name, or `None` when the registry does not rank it
/// (user symbols, package contexts). The first hundred names share a band so that
/// among them length still decides, which is what puts `Plot` before `Power` for `P`.
pub(crate) fn rank_band(name: &str) -> Option<u32> {
    let rank = RANKS.get(name)?;
    Some(if *rank < BAND_HEAD {
        0
    } else {
        1 + rank / BAND_WIDTH
    })
}

/// Names past this band are offered only when the query is specific (see
/// [`is_specific`]) or when the notebook already uses them: about a third of the
/// registry, the tail that would otherwise crowd the bar while typing three letters.
pub(crate) const RARE_BAND: u32 = 4;

/// A name the registry does not rank this long is presumed rare: nobody types
/// `VectorFieldPlots`ListVectorFieldPlot` in full on a phone.
pub(crate) const LONG_NAME: usize = 20;

/// A typed fragment this long is specific on its own: it names a word, not a letter.
pub(crate) const SPECIFIC_LEN: usize = 4;

/// An abbreviation has to cover at least this many words before it can stand in for a
/// four-character query.
const MIN_SPECIFIC_WORDS: usize = 2;

/// Every symbol the interpreter knows, with whether Woxi implements it. `all_builtin_symbol_names`
/// is the complete registry (including a name with no description or effect level), and
/// `is_known_wolfram_function` is Woxi's own "known but not implemented" flag.
pub(crate) static SYMBOLS: LazyLock<Vec<(&'static str, bool)>> = LazyLock::new(|| {
    let mut table: Vec<(&'static str, bool)> =
        woxi::evaluator::functions::all_builtin_symbol_names()
            .into_iter()
            .map(|name| {
                (
                    name,
                    !woxi::evaluator::functions::is_known_wolfram_function(name),
                )
            })
            .collect();
    table.sort_unstable();
    table
});

pub(crate) fn symbol_table() -> &'static [(&'static str, bool)] {
    SYMBOLS.as_slice()
}

/// Every option symbol the registry declares, generated from `Options[f]` over the
/// functions that take options (see `engine/data/README.md`). It answers "is this name an
/// option rather than a call", which decides between `Axes` and `Axes[]` on a chip. The
/// options of one call still come from `Options[head]` at run time.
pub(crate) static OPTION_SYMBOLS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    include_str!("../../data/option_symbols.txt")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect()
});

pub(crate) fn is_option_symbol(name: &str) -> bool {
    OPTION_SYMBOLS.contains(name)
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
/// cursor is a byte offset; callers convert the UTF-16 cursor position first.
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
/// caret may sit inside the name rather than after it. The cursor is a byte offset.
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

// The matching tiers, lower first. The numbers are used only for ordering. The names
// keep the model explicit.
const TIER_EXACT: u8 = 0;
const TIER_PREFIX: u8 = 1;
const TIER_INITIALS: u8 = 2;
const TIER_WORD: u8 = 3;
const TIER_ABBREVIATION: u8 = 4;
const TIER_SUBSTRING: u8 = 5;

/// A one-letter fuzzy query matches half the language; two is the minimum that says
/// something about a word.
const MIN_FUZZY_LEN: usize = 2;

/// How well `name` answers `prefix`. Lower tiers come first: exact name, prefix,
/// CamelCase initials, substring at a word start, abbreviation of whole words, and the
/// weak mid-word substring. The caller trims the weak tier when the sharper tiers
/// already have answers.
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
        return None;
    }
    let wanted = prefix.to_ascii_lowercase();
    let candidate = name.to_ascii_lowercase();
    if candidate == wanted {
        return Some(Quality {
            tier: TIER_EXACT,
            score: 0,
            words: 0,
        });
    }
    if candidate.starts_with(&wanted) {
        return Some(Quality {
            tier: TIER_PREFIX,
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
                tier: TIER_INITIALS,
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
                    tier: TIER_WORD,
                    score: -i32::try_from(start).unwrap_or(0),
                    words: 1,
                });
            }
            let substring = Quality {
                tier: TIER_SUBSTRING,
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
                    tier: TIER_ABBREVIATION,
                    score: abbreviation_score(span),
                    words,
                });
            }
            return Some(substring);
        }
    }
    // Fuzzy matching for one letter would list half the language.
    if wanted.chars().count() < MIN_FUZZY_LEN {
        return None;
    }
    let chars: Vec<char> = name.chars().collect();
    // The segments come from the query as typed: a capital starts a word of the name.
    let query: Vec<char> = prefix.chars().collect();
    let (span, words) = abbreviation_span(&query, &chars)?;
    Some(Quality {
        tier: TIER_ABBREVIATION,
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
    implemented: bool,
    session: bool,
    tier: u8,
    /// Higher is better. Only meaningful within a tier.
    score: i32,
    /// A package-qualified name (`Context`Symbol`) or a system variable (`$Name`):
    /// real symbols, but rarely what a phone user is typing, so they sort last.
    quirk: bool,
    /// The frequency band of [`rank_band`]. `None` when the registry does not rank it.
    band: Option<u32>,
    /// Named somewhere in the notebook, which lifts a rare name to the front.
    used: bool,
    /// 2 for an option of the call the caret is in, 1 for one that call already names,
    /// 0 otherwise. Only meaningful in an options context; a tie-break inside the tier.
    option_rank: u8,
}

/// The order the bar and the sheet show: what the user typed, then how often the name
/// shows up in Wolfram work, then the cheaper tie-breakers.
pub(crate) fn order(a: &Candidate, b: &Candidate) -> std::cmp::Ordering {
    a.tier
        .cmp(&b.tier)
        // In a call's options region, the call's own options are what the user is
        // looking for. The tier still comes first, so this cannot lift a weaker match
        // over a better one. The options already in the call come after the missing ones.
        .then_with(|| b.option_rank.cmp(&a.option_rank))
        // Package-qualified names and system variables are real, but they are not what
        // a phone user is typing: they go after the plain names of a tier.
        .then_with(|| a.quirk.cmp(&b.quirk))
        // The notebook's own vocabulary beats any prior.
        .then_with(|| b.session.cmp(&a.session))
        .then_with(|| b.used.cmp(&a.used))
        .then_with(|| a.band.unwrap_or(u32::MAX).cmp(&b.band.unwrap_or(u32::MAX)))
        .then_with(|| b.score.cmp(&a.score))
        // A shorter name is easier to read and to type. Frequency still comes first
        // (`Integrate` before `Integer` for `Int`), but within the same band and match
        // quality the short name wins.
        .then_with(|| a.name.chars().count().cmp(&b.name.chars().count()))
        .then_with(|| b.implemented.cmp(&a.implemented))
        .then_with(|| a.name.len().cmp(&b.name.len()))
        .then_with(|| a.name.cmp(&b.name))
}

/// Whether a short query is specific enough to name a rare symbol: four characters,
/// an exact name, or an abbreviation that covers every word (`RngFlt` is specific,
/// `Rng` is not, even though both are three words' worth of letters).
pub(crate) fn is_specific(prefix: &str, quality: &Quality, name: &str) -> bool {
    if prefix.chars().count() >= SPECIFIC_LEN || quality.tier == TIER_EXACT {
        return true;
    }
    if quality.words < MIN_SPECIFIC_WORDS {
        return false;
    }
    let chars: Vec<char> = name.chars().collect();
    quality.words >= word_starts(&chars).len()
}

// Symbols the user has already written in this notebook. The engine is the only place
// that sees every entry, so the frontend sends all of them with a completion request.
// `USED_KEY` keeps a hash of the notebook so an unchanged one is not tokenized again.
thread_local! {
    pub(crate) static USED_SYMBOLS: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
    // A hash of the notebook text, not the text itself: enough to skip the tokenizer for
    // an unchanged notebook without keeping a second copy of every entry in the engine.
    static USED_KEY: RefCell<Option<u64>> = const { RefCell::new(None) };
}

pub(crate) fn is_builtin_name(name: &str) -> bool {
    symbol_table()
        .binary_search_by(|(known, _)| (*known).cmp(name))
        .is_ok()
}

fn usage_names(code: &str, session: &HashSet<String>) -> Vec<String> {
    if code.is_empty() {
        return Vec::new();
    }
    let tokens = woxi::lsp::analysis::tokenize(code);
    let mut names = Vec::new();
    for token in &tokens {
        if token.kind != woxi::lsp::analysis::TokenKind::Symbol {
            continue;
        }
        let name = token.text(code);
        if is_builtin_name(name) || session.contains(name) {
            names.push(name.to_string());
        }
    }
    names
}

/// The names defined in the current interpreter session. They are part of the notebook's
/// vocabulary even when the definition happened in an earlier entry; including them lets
/// a user-defined symbol receive the same "already used" boost as a builtin.
fn session_names() -> HashSet<String> {
    woxi::get_defined_names().into_iter().collect()
}

/// A stable key for the notebook's text. `DefaultHasher` has fixed keys, so it is
/// deterministic within the process; the hash only has to distinguish successive edits.
fn usage_key(codes: &[String]) -> u64 {
    let mut hasher = DefaultHasher::new();
    codes.hash(&mut hasher);
    hasher.finish()
}

/// Adds the names in one entry to the remembered vocabulary. This is the test helper for
/// callers that only have one entry; requests use [`sync_usage`].
#[cfg(test)]
pub(crate) fn remember_usage(code: &str) {
    let session = session_names();
    let names = usage_names(code, &session);
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

/// Recomputes the used-name set from the notebook's entries. Names removed from the text
/// stop being "used" instead of staying in the set for the rest of the session.
fn sync_usage(codes: &[String]) {
    let key = usage_key(codes);
    if USED_KEY.with(|cached| *cached.borrow() == Some(key)) {
        return;
    }
    let mut names = Vec::new();
    let session = session_names();
    for code in codes {
        names.extend(usage_names(code, &session));
    }
    USED_SYMBOLS.with(|used| {
        let mut used = used.borrow_mut();
        used.clear();
        for name in names {
            used.insert(name);
        }
    });
    USED_KEY.with(|cached| *cached.borrow_mut() = Some(key));
}

/// Recomputes the used-name set from the notebook's entries. Names removed from the text
/// stop being "used" instead of staying in the set for the rest of the session. The
/// frontend sends every entry; a request without the array does not describe a notebook
/// (a unit test, or a caller that only set one prefix), so it leaves the remembered
/// vocabulary alone.
pub(crate) fn remember_notebook_usage(json: &str) {
    let codes = json_string_array(json, "notebook_codes");
    if !codes.is_empty() {
        sync_usage(&codes);
    }
}

pub(crate) fn was_used(name: &str) -> bool {
    USED_SYMBOLS.with(|used| used.borrow().contains(name))
}

/// Drops the notebook's remembered vocabulary when the session is reset. The symbols the
/// new notebook uses will be remembered again as it is typed.
pub(crate) fn clear_usage() {
    USED_SYMBOLS.with(|used| used.borrow_mut().clear());
    USED_KEY.with(|cached| *cached.borrow_mut() = None);
    clear_option_cache();
}

// The option names a head declares, cached for built-in heads: `Options[f]` is Woxi's
// own declaration, and the probe is the history-neutral one `inspect_request` uses. The
// cache is cleared after evaluation, since `Options[f] = ...` can change the answer.
// A user-defined head is probed each time because it is not a stable table entry.
thread_local! {
    static OPTION_NAMES: RefCell<HashMap<String, Rc<HashSet<String>>>> =
        RefCell::new(HashMap::new());
}

fn option_names(head: &str) -> Rc<HashSet<String>> {
    let builtin = is_builtin_name(head);
    if builtin {
        if let Some(names) = OPTION_NAMES.with(|cache| cache.borrow().get(head).cloned()) {
            return names;
        }
    }
    let names: HashSet<String> = options_of(head).into_iter().map(|(name, _)| name).collect();
    let names = Rc::new(names);
    if builtin {
        OPTION_NAMES.with(|cache| {
            cache
                .borrow_mut()
                .insert(head.to_string(), Rc::clone(&names));
        });
    }
    names
}

/// Drops the cached `Options[f]` names. An evaluation can redefine `Options[f]`, so the
/// evaluation path calls this after each entry; `clear_usage` also calls it on reset.
pub(crate) fn clear_option_cache() {
    OPTION_NAMES.with(|cache| cache.borrow_mut().clear());
}

/// What the caret's context adds to the ranking: the call whose options are being typed,
/// and the options that call already names. The frontend sends the head and the used
/// names; the engine probes `Options[f]` itself (cached for builtins), so the ranking and
/// the `callOption` flag do not depend on how much of the call's options the client has
/// loaded.
///
/// The boost is a tie-break inside the matching tier (see [`order`]): a better match
/// still wins, which is what keeps the options from outranking the name the user is
/// actually typing. An option the call already names ranks below the options it does
/// not name yet, since repeating one is legal but rarely intended.
pub(crate) struct OptionsContext {
    names: Rc<HashSet<String>>,
    used: HashSet<String>,
}

impl OptionsContext {
    pub(crate) fn new(head: &str, used: &[String]) -> Option<Self> {
        if !is_symbol_name(head) {
            return None;
        }
        let names = option_names(head);
        if names.is_empty() {
            return None;
        }
        Some(Self {
            names,
            used: used.iter().cloned().collect(),
        })
    }

    /// 2 for an option of the call, 1 when the call already names it, 0 for anything
    /// else.
    fn rank(&self, name: &str) -> u8 {
        if !self.names.contains(name) {
            return 0;
        }
        if self.used.contains(name) {
            1
        } else {
            2
        }
    }
}

/// The weakest tier (a substring in the middle of a word) is only offered when the
/// sharper tiers leave fewer than this many candidates. Typing a prefix that already has
/// answers never grows a mid-word tail.
pub(crate) const WEAK_MIN_SHARP: usize = 3;

/// How many of the weakest matches (a substring in the middle of a word) are kept, so
/// the list stays short even for a two-letter fragment.
pub(crate) const MAX_WEAK: usize = 20;

/// Ranked suggestions for the prefix before `cursor`, plus the span the frontend
/// should replace when one is accepted.
///
/// Two lists are built in one pass: the sharp matches (exact, prefix, initials, word
/// substring, whole-word abbreviation) and the weak mid-word substrings. The weak ones
/// are appended only when the sharp ones are scarce, so typing `Plo` shows `Plot...`
/// while `Rng` or `pts` still finds `PlotRange` and `PlotPoints`.
pub(crate) fn candidates(
    code: &str,
    cursor: usize,
    limit: usize,
    options: Option<&OptionsContext>,
) -> (usize, usize, usize, Vec<Candidate>) {
    let (start, prefix) = identifier_before(code, cursor);
    let mut sharp: Vec<Candidate> = Vec::new();
    let mut weak: Vec<Candidate> = Vec::new();

    let mut push = |name: String, implemented: bool, session: bool, quality: Quality| {
        let quirk = name.contains('`') || name.starts_with('$');
        let band = rank_band(&name);
        let used = was_used(&name);
        let option_rank = options.map_or(0, |context| context.rank(&name));
        let rare = band.is_some_and(|band| band >= RARE_BAND)
            || (band.is_none() && name.chars().count() > LONG_NAME);
        // Low-frequency names are matched only when the query is specific, the
        // notebook already uses them, or the call is asking for exactly this option.
        // A session symbol is the user's own vocabulary (and is often long), so it must
        // not be hidden by a registry-tail rule. That is what keeps three typed letters
        // from listing the tail of the registry without hiding a user's definitions.
        if rare && !session && !used && option_rank == 0 && !is_specific(prefix, &quality, &name) {
            return;
        }
        let row = Candidate {
            name,
            implemented,
            session,
            tier: quality.tier,
            score: quality.score,
            quirk,
            band,
            used,
            option_rank,
        };
        if quality.tier >= TIER_SUBSTRING {
            if weak.len() < MAX_WEAK {
                weak.push(row);
            }
        } else {
            sharp.push(row);
        }
    };

    for name in woxi::get_defined_names() {
        let Some(quality) = match_quality(prefix, &name) else {
            continue;
        };
        push(name, true, true, quality);
    }

    for (name, implemented) in symbol_table() {
        let Some(quality) = match_quality(prefix, name) else {
            continue;
        };
        push(name.to_string(), *implemented, false, quality);
    }

    sharp.sort_by(order);
    let mut rows = sharp;
    if rows.len() < WEAK_MIN_SHARP {
        weak.sort_by(order);
        rows.append(&mut weak);
    }
    let total = rows.len();
    rows.truncate(limit);
    (start, cursor, total, rows)
}

/// The caret position of a request, converted from JavaScript's UTF-16 code units
/// to a byte offset (the engine works on UTF-8). A caret inside a surrogate pair
/// lands before that character.
pub(crate) fn cursor_of(json: &str, code: &str) -> usize {
    let raw =
        json_field_number(json, "cursor_pos").unwrap_or_else(|| code.encode_utf16().count() as f64);
    utf16_to_byte(code, raw.max(0.0) as usize)
}

/// Converts a JavaScript string offset (UTF-16 code units) to a UTF-8 byte offset,
/// clamped to the string. A position inside a surrogate pair maps to the start of
/// that character.
pub(crate) fn utf16_to_byte(code: &str, units: usize) -> usize {
    let mut used = 0;
    for (index, ch) in code.char_indices() {
        if used >= units {
            return index;
        }
        used += ch.len_utf16();
        if used > units {
            return index;
        }
    }
    code.len()
}

/// Converts a UTF-8 byte offset to a JavaScript string offset (UTF-16 code units).
pub(crate) fn byte_to_utf16(code: &str, byte: usize) -> usize {
    let mut byte = byte.min(code.len());
    while byte > 0 && !code.is_char_boundary(byte) {
        byte -= 1;
    }
    code[..byte].chars().map(char::len_utf16).sum()
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
    // The notebook, not just this entry, decides which names are "used" by the ranking.
    // The frontend sends every entry. The engine only re-tokenizes when they changed.
    remember_notebook_usage(json);
    let cursor = cursor_of(json, &code);
    let limit = json_field_number(json, "limit")
        .map(|value| (value.max(1.0) as usize).min(MAX_MATCHES))
        .unwrap_or(DEFAULT_MATCHES);
    // The frontend's caret context: the call whose options are being typed and the
    // options it already names. Absent outside an options region (the common case).
    let context_head = json_field_text(json, "context_head").unwrap_or_default();
    let context_used = json_string_array(json, "context_used");
    let options = OptionsContext::new(&context_head, &context_used);
    let (start, end, total, rows) = candidates(&code, cursor, limit, options.as_ref());
    // Jupyter's `complete_reply` carries the replacement span. The bar replaces the whole
    // identifier itself (the rest of the name is not part of this span), but the fields
    // stay because the envelope is kept Jupyter-compatible.
    let cursor_start = byte_to_utf16(&code, start);
    let cursor_end = byte_to_utf16(&code, end);

    let mut matches = Vec::with_capacity(rows.len());
    let mut types = Vec::with_capacity(rows.len());
    let mut extra = Vec::with_capacity(rows.len());
    for row in &rows {
        matches.push(format!("\"{}\"", json_escape(&row.name)));
        // Description and category are only needed for the rows that survived the
        // limit. Looking them up while matching would call into Woxi's documentation
        // table for every candidate of every keystroke.
        let (category, description) = if row.session {
            ("", String::new())
        } else {
            let (category, _doc) = category_of(&row.name);
            let description = woxi::evaluator::functions::get_builtin_function_info(&row.name)
                .map(|info| info.description.to_string())
                .unwrap_or_default();
            (category, description)
        };
        // `text` is part of Jupyter's `_jupyter_types_experimental` item shape. The bar
        // reads `type`/`docstring` and takes the names from `matches`.
        types.push(format!(
            "{{\"text\":\"{}\",\"type\":\"{}\",\"docstring\":\"{}\"}}",
            json_escape(&row.name),
            if row.session { "variable" } else { "function" },
            json_escape(&description)
        ));
        let arity_json = match woxi::evaluator::dispatch::arg_count::get_arg_count_range(&row.name)
        {
            Some((min, max)) if max == usize::MAX => format!("[{min},null]"),
            Some((min, max)) => format!("[{min},{max}]"),
            None => "null".to_string(),
        };
        extra.push(format!(
            "{{\"status\":\"{}\",\"category\":\"{}\",\"arity\":{},\"option\":{},\"callOption\":{}}}",
            status_name(&row.name),
            json_escape(category),
            arity_json,
            if is_option_symbol(&row.name) { "true" } else { "false" },
            if row.option_rank > 0 { "true" } else { "false" }
        ));
    }

    format!(
        "{{\"matches\":[{}],\"cursor_start\":{},\"cursor_end\":{},\"metadata\":{{\"_jupyter_types_experimental\":[{}],\"_woxi\":[{}],\"total\":{}}}}}",
        matches.join(","),
        cursor_start,
        cursor_end,
        types.join(","),
        extra.join(","),
        total
    )
}
