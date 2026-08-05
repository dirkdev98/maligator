//! RegExp match primitives over the `regress` ECMAScript engine.
//!
//! This module lives in the `mal_i18n` crate rather than a crate of its own
//! because two Rust `staticlib`s cannot be linked into one binary — each bundles
//! its own copy of the std panic runtime, producing duplicate symbols
//! (`rust_eh_personality`, `EMPTY_PANIC`). So the runtime's Rust FFI lives in a
//! single staticlib; this module is the regexp half. C ABI is `mal_regexp.h`.
//!
//! Design contract (same as the i18n half): the C runtime owns ALL JS-spec glue
//! (flag parsing, lastIndex, global/sticky iteration, result-array shaping, the
//! Symbol.* protocol, `$`-substitution, the `d`-flag indices array). This module
//! exposes only flat match primitives. Patterns and subjects cross as UTF-16
//! (`*const u16` + len), matching MalString; offsets are u16 code-unit indices.
//!
//! Encoding: a `u`/`v` pattern matches over code points (`find_from_utf16`,
//! combining surrogate pairs); everything else over code units
//! (`find_from_ucs2`). Positions are code-unit indices in both. g/y/d never
//! reach here — the C side drives them.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::sync::Arc;

use regress::{Flags, Match, Regex};

use crate::ffi::{nullable_u16_slice, write_utf8};

/// ABI version, mirrored by MAL_REGEXP_ABI_VERSION in mal_regexp.h.
/// v2: added `mal_regexp_free` (GC finalization, gc_todo.md D2).
/// v3: added immutable-subject identity and execution-path reporting.
/// v4: added conservative allocation-free literal/class execution plans.
pub const MAL_REGEXP_ABI_VERSION: u32 = 4;

const EXEC_ASCII: u32 = 1 << 0;
const EXEC_CACHE_HIT: u32 = 1 << 1;
const EXEC_CACHE_FILL: u32 = 1 << 2;
const EXEC_NON_ASCII: u32 = 1 << 3;
const EXEC_FAST: u32 = 1 << 4;

// Flag bits, mirrored by MAL_REGEXP_FLAG_* in mal_regexp.h. g/y/d are
// engine-external and deliberately absent.
const FLAG_IGNORE_CASE: u32 = 1 << 0; // i
const FLAG_MULTILINE: u32 = 1 << 1; // m
const FLAG_DOT_ALL: u32 = 1 << 2; // s
const FLAG_UNICODE: u32 = 1 << 3; // u
const FLAG_UNICODE_SETS: u32 = 1 << 4; // v
const COMPILE_FLAGS: u32 =
    FLAG_IGNORE_CASE | FLAG_MULTILINE | FLAG_DOT_ALL | FLAG_UNICODE | FLAG_UNICODE_SETS;

const PATTERN_CACHE_CAPACITY: usize = 24;
const ASCII_SUBJECT_CACHE_MAX_BYTES: usize = 64 * 1024;
const FAST_CAPTURE_CAPACITY: usize = 31;
const FAST_CAPTURE_SLOTS: usize = (FAST_CAPTURE_CAPACITY + 1) * 2;

#[derive(Debug)]
enum FastToken {
    Literal(Box<[u16]>),
    ClassPlus {
        first: u16,
        last: u16,
        capture: Option<usize>,
    },
}

#[derive(Debug)]
struct FastPattern {
    anchored_start: bool,
    tokens: Box<[FastToken]>,
    capture_count: usize,
}

struct FastMatch {
    start: usize,
    end: usize,
    captures: [Option<(usize, usize)>; FAST_CAPTURE_CAPACITY],
}

impl FastPattern {
    fn literal_matches_at(literal: &[u16], subject: &[u16], position: usize) -> bool {
        if position + literal.len() > subject.len() {
            return false;
        }
        if literal.len() > 16 {
            return subject[position..position + literal.len()] == *literal;
        }
        literal
            .iter()
            .enumerate()
            .all(|(offset, expected)| subject[position + offset] == *expected)
    }

    fn token_starts_at(token: &FastToken, subject: &[u16], position: usize) -> bool {
        match token {
            FastToken::Literal(literal) => subject
                .get(position)
                .is_some_and(|unit| *unit == literal[0]),
            FastToken::ClassPlus { first, last, .. } => subject
                .get(position)
                .is_some_and(|unit| (*first..=*last).contains(unit)),
        }
    }

    fn next_candidate(&self, subject: &[u16], from: usize) -> Option<usize> {
        let first_token = self.tokens.first()?;
        (from..subject.len())
            .find(|position| Self::token_starts_at(first_token, subject, *position))
    }

    fn match_at(&self, subject: &[u16], start: usize) -> Option<FastMatch> {
        let mut position = start;
        let mut captures = [None; FAST_CAPTURE_CAPACITY];
        for token in self.tokens.iter() {
            match token {
                FastToken::Literal(literal) => {
                    if !Self::literal_matches_at(literal, subject, position) {
                        return None;
                    }
                    position += literal.len();
                }
                FastToken::ClassPlus {
                    first,
                    last,
                    capture,
                } => {
                    let capture_start = position;
                    while subject
                        .get(position)
                        .is_some_and(|unit| (*first..=*last).contains(unit))
                    {
                        position += 1;
                    }
                    if position == capture_start {
                        return None;
                    }
                    if let Some(index) = capture {
                        captures[*index] = Some((capture_start, position));
                    }
                }
            }
        }
        Some(FastMatch {
            start,
            end: position,
            captures,
        })
    }

    fn find(&self, subject: &[u16], start: usize) -> Option<FastMatch> {
        if self.anchored_start {
            return (start == 0).then(|| self.match_at(subject, 0)).flatten();
        }

        let mut candidate = start;
        while candidate < subject.len() {
            candidate = self.next_candidate(subject, candidate)?;
            if let Some(found) = self.match_at(subject, candidate) {
                return Some(found);
            }
            candidate += 1;
        }
        None
    }
}

fn is_regexp_meta(unit: u16) -> bool {
    matches!(
        unit,
        0x2e | 0x5e
            | 0x24
            | 0x2a
            | 0x2b
            | 0x3f
            | 0x7b
            | 0x7d
            | 0x5b
            | 0x5d
            | 0x28
            | 0x29
            | 0x7c
            | 0x5c
    )
}

fn compile_fast_pattern(units: &[u16], flags: u32) -> Option<FastPattern> {
    if units.is_empty() || flags & COMPILE_FLAGS != 0 || units.iter().any(|unit| *unit > 0x7f) {
        return None;
    }

    let mut position = 0;
    let anchored_start = units.first() == Some(&(b'^' as u16));
    if anchored_start {
        position += 1;
    }
    let mut tokens = Vec::new();
    let mut literal = Vec::new();
    let mut capture_count = 0;

    while position < units.len() {
        let capture = units[position] == b'(' as u16;
        let class_start = position + usize::from(capture);
        if class_start < units.len() && units[class_start] == b'[' as u16 {
            let class_length = if capture { 8 } else { 6 };
            if position + class_length > units.len()
                || units[class_start + 2] != b'-' as u16
                || units[class_start + 4] != b']' as u16
                || units[class_start + 5] != b'+' as u16
                || (capture && units[class_start + 6] != b')' as u16)
            {
                return None;
            }
            let first = units[class_start + 1];
            let last = units[class_start + 3];
            // Keep the structural recognizer deliberately narrow: punctuation
            // can introduce negation, escapes, or other class grammar that is
            // not equivalent to a raw inclusive code-unit range.
            if first > last
                || !(first as u8).is_ascii_alphanumeric()
                || !(last as u8).is_ascii_alphanumeric()
            {
                return None;
            }
            if !literal.is_empty() {
                tokens.push(FastToken::Literal(core::mem::take(&mut literal).into()));
            }
            let capture_index = if capture {
                if capture_count == FAST_CAPTURE_CAPACITY {
                    return None;
                }
                let index = capture_count;
                capture_count += 1;
                Some(index)
            } else {
                None
            };
            tokens.push(FastToken::ClassPlus {
                first,
                last,
                capture: capture_index,
            });
            position += class_length;
            continue;
        }

        if is_regexp_meta(units[position]) {
            return None;
        }
        literal.push(units[position]);
        position += 1;
    }

    if !literal.is_empty() {
        tokens.push(FastToken::Literal(literal.into()));
    }
    if position != units.len() || tokens.is_empty() {
        return None;
    }

    // The fast executor consumes a class greedily without backtracking. Retain
    // only plans where the following literal begins outside that class, making
    // the greedy result equivalent to the general engine.
    for pair in tokens.windows(2) {
        let FastToken::ClassPlus { first, last, .. } = &pair[0] else {
            continue;
        };
        let FastToken::Literal(literal) = &pair[1] else {
            return None;
        };
        if (*first..=*last).contains(&literal[0]) {
            return None;
        }
    }

    Some(FastPattern {
        anchored_start,
        tokens: tokens.into(),
        capture_count,
    })
}

#[derive(PartialEq, Eq)]
struct PatternCacheKey {
    pattern: Box<[u16]>,
    compile_flags: u32,
}

struct PatternCacheEntry {
    key: PatternCacheKey,
    re: Arc<Regex>,
}

thread_local! {
    /// RegExp construction is thread-confined by the runtime, so a small local
    /// cache avoids synchronization while bounding retained patterns.
    static PATTERN_CACHE: RefCell<VecDeque<PatternCacheEntry>> =
        const { RefCell::new(VecDeque::new()) };
}

/// A compiled pattern plus its most recent match. The C runtime drives one exec
/// at a time on a single thread and fully consumes each result (captures + named
/// groups) before issuing the next exec, so caching `last` here is sound and
/// lets named groups be queried after a match without re-running it. A `Match`
/// owns all of its data (it does not borrow the subject), so it is safe to
/// retain past the exec call.
struct CompiledPattern {
    re: Arc<Regex>,
    fast: Option<FastPattern>,
    /// `u`/`v` patterns match over code points; everything else over code units.
    unicode_mode: bool,
    /// The ASCII backend can use regress's anchored and literal-prefix searchers.
    /// Ignore-case stays on UTF-16 because that backend documents only ASCII
    /// folding, while ECMAScript may require Unicode-aware canonicalization.
    ascii_eligible: bool,
    subject_cache: Option<SubjectCache>,
    last: Option<Match>,
    fast_last_groups: i32,
    fast_last_captures: [i32; FAST_CAPTURE_SLOTS],
}

struct SubjectCache {
    heap_identity: u64,
    heap_epoch: u32,
    string_identity: usize,
    /// Defer the O(n) ASCII classification until the same immutable subject is
    /// executed a second time. One-shot exec/search calls stay zero-copy UTF-16.
    classified: bool,
    /// None is a negative cache entry for a non-ASCII or deliberately uncached
    /// oversized subject.
    ascii: Option<String>,
}

/// Returns the ABI version baked into this archive.
#[no_mangle]
pub extern "C" fn mal_regexp_abi_version() -> u32 {
    MAL_REGEXP_ABI_VERSION
}

/// Decode UTF-16 code units into Unicode code points, combining valid surrogate
/// pairs and passing lone surrogates through as their raw scalar value. Mirrors
/// how `Regex::with_flags` feeds `pattern.chars()` to the parser.
fn utf16_to_codepoints(units: &[u16]) -> Vec<u32> {
    let mut out = Vec::with_capacity(units.len());
    let mut i = 0;
    while i < units.len() {
        let u = units[i];
        if (0xD800..=0xDBFF).contains(&u)
            && i + 1 < units.len()
            && (0xDC00..=0xDFFF).contains(&units[i + 1])
        {
            let hi = u as u32;
            let lo = units[i + 1] as u32;
            out.push(0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00));
            i += 2;
        } else {
            out.push(u as u32);
            i += 1;
        }
    }
    out
}

fn regress_flags(bits: u32) -> Flags {
    let mut flags = Flags::default();
    flags.icase = bits & FLAG_IGNORE_CASE != 0;
    flags.multiline = bits & FLAG_MULTILINE != 0;
    flags.dot_all = bits & FLAG_DOT_ALL != 0;
    flags.unicode = bits & FLAG_UNICODE != 0;
    flags.unicode_sets = bits & FLAG_UNICODE_SETS != 0;
    flags
}

fn compile_pattern(units: &[u16], flags: u32) -> Option<(Arc<Regex>, bool)> {
    let semantic_flags = flags & COMPILE_FLAGS;
    let cached = PATTERN_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        let index = cache.iter().position(|entry| {
            entry.key.compile_flags == semantic_flags && entry.key.pattern.as_ref() == units
        })?;
        let entry = cache.remove(index)?;
        let re = Arc::clone(&entry.re);
        cache.push_front(entry);
        Some(re)
    });

    let flags = regress_flags(semantic_flags);
    let unicode_mode = flags.unicode || flags.unicode_sets;
    if let Some(re) = cached {
        return Some((re, unicode_mode));
    }

    let codepoints = utf16_to_codepoints(units);
    let re = Arc::new(Regex::from_unicode(codepoints.into_iter(), flags).ok()?);
    PATTERN_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        cache.push_front(PatternCacheEntry {
            key: PatternCacheKey {
                pattern: units.into(),
                compile_flags: semantic_flags,
            },
            re: Arc::clone(&re),
        });
        cache.truncate(PATTERN_CACHE_CAPACITY);
    });
    Some((re, unicode_mode))
}

/// Compile a pattern (UTF-16) with the given flag bitmask. Returns an opaque,
/// leaked handle (a boxed `CompiledPattern`), or NULL if the pattern is invalid
/// — the C side maps NULL to a SyntaxError. Freed by the C side via mal_regexp_free.
#[no_mangle]
pub unsafe extern "C" fn mal_regexp_compile(
    pattern: *const u16,
    pattern_len: usize,
    flags: u32,
) -> *mut core::ffi::c_void {
    // Keep raw code units here: compile_pattern deliberately preserves lone
    // surrogates as their numeric values instead of replacing them.
    let units = unsafe { nullable_u16_slice(pattern, pattern_len) };

    match compile_pattern(units, flags) {
        Some((re, unicode_mode)) => {
            let boxed = Box::new(CompiledPattern {
                re,
                fast: compile_fast_pattern(units, flags),
                unicode_mode,
                ascii_eligible: flags & FLAG_IGNORE_CASE == 0,
                subject_cache: None,
                last: None,
                fast_last_groups: 0,
                fast_last_captures: [-1; FAST_CAPTURE_SLOTS],
            });
            Box::into_raw(boxed) as *mut core::ffi::c_void
        }
        None => core::ptr::null_mut(),
    }
}

/// Free a compiled-pattern handle from `mal_regexp_compile`. Null-tolerant, so
/// the GC finalizer (which nulls the field after the call) is idempotent.
#[no_mangle]
pub unsafe extern "C" fn mal_regexp_free(handle: *mut core::ffi::c_void) {
    if handle.is_null() {
        return;
    }
    drop(unsafe { Box::from_raw(handle as *mut CompiledPattern) });
}

/// Write a match's group ranges into `out` as (start, end) i32 pairs (pair 0 is
/// the whole match; an unmatched group is (-1, -1)). At most `cap` slots are
/// written; the return is the full group count.
fn write_captures(m: &Match, out: *mut i32, cap: i32) -> i32 {
    let ngroups = m.captures.len() + 1;
    let cap = cap.max(0) as usize;

    let put = |pair: usize, range: &Option<core::ops::Range<usize>>| {
        let (s, e) = match range {
            Some(r) => (r.start as i32, r.end as i32),
            None => (-1, -1),
        };
        let base = pair * 2;
        if !out.is_null() {
            if base < cap {
                unsafe { *out.add(base) = s };
            }
            if base + 1 < cap {
                unsafe { *out.add(base + 1) = e };
            }
        }
    };

    put(0, &Some(m.range.clone()));
    for (i, capture) in m.captures.iter().enumerate() {
        put(i + 1, capture);
    }
    ngroups as i32
}

fn cache_fast_captures(
    pattern: &FastPattern,
    found: &FastMatch,
    cached: &mut [i32; FAST_CAPTURE_SLOTS],
) -> i32 {
    cached.fill(-1);
    cached[0] = found.start as i32;
    cached[1] = found.end as i32;
    for index in 0..pattern.capture_count {
        if let Some((start, end)) = found.captures[index] {
            cached[(index + 1) * 2] = start as i32;
            cached[(index + 1) * 2 + 1] = end as i32;
        }
    }
    (pattern.capture_count + 1) as i32
}

unsafe fn copy_cached_captures(
    cached: &[i32; FAST_CAPTURE_SLOTS],
    groups: i32,
    out: *mut i32,
    cap: i32,
) -> i32 {
    let slots = ((groups.max(0) as usize) * 2).min(cap.max(0) as usize);
    if !out.is_null() && slots > 0 {
        unsafe { core::ptr::copy_nonoverlapping(cached.as_ptr(), out, slots) };
    }
    groups
}

/// Execute against `subject` (UTF-16) starting at code-unit index `start`.
/// Returns the group count (>= 1) on a match, 0 on no match, -1 on error.
#[no_mangle]
pub unsafe extern "C" fn mal_regexp_exec(
    handle: *mut core::ffi::c_void,
    subject: *const u16,
    subject_len: usize,
    start: usize,
    subject_identity: *const core::ffi::c_void,
    heap_identity: u64,
    heap_epoch: u32,
    caps_out: *mut i32,
    caps_cap: i32,
    execution_flags_out: *mut u32,
) -> i32 {
    if !execution_flags_out.is_null() {
        unsafe { *execution_flags_out = 0 };
    }
    if handle.is_null() {
        return -1;
    }
    let cp = unsafe { &mut *(handle as *mut CompiledPattern) };

    if start > subject_len {
        cp.last = None;
        cp.fast_last_groups = 0;
        return 0;
    }
    // regress receives the original code units so non-Unicode mode can match
    // lone surrogates and Unicode mode can apply its own pair handling.
    let subj = unsafe { nullable_u16_slice(subject, subject_len) };

    if cp.fast.is_some() {
        let found = cp.fast.as_ref().and_then(|fast| fast.find(subj, start));
        cp.last = None;
        if !execution_flags_out.is_null() {
            unsafe { *execution_flags_out = EXEC_FAST };
        }
        return match found {
            Some(found) => {
                let groups = cache_fast_captures(
                    cp.fast.as_ref().expect("fast plan exists"),
                    &found,
                    &mut cp.fast_last_captures,
                );
                cp.fast_last_groups = groups;
                unsafe { copy_cached_captures(&cp.fast_last_captures, groups, caps_out, caps_cap) }
            }
            None => {
                cp.fast_last_groups = 0;
                0
            }
        };
    }

    let mut execution_flags = 0;
    let found = if cp.ascii_eligible {
        let string_identity = subject_identity as usize;
        let cache_hit = cp.subject_cache.as_ref().is_some_and(|cache| {
            cache.heap_identity == heap_identity
                && cache.heap_epoch == heap_epoch
                && cache.string_identity == string_identity
        });
        if !cache_hit {
            cp.subject_cache = Some(SubjectCache {
                heap_identity,
                heap_epoch,
                string_identity,
                classified: false,
                ascii: None,
            });
            execution_flags |= EXEC_CACHE_FILL;
            if cp.unicode_mode {
                cp.re.find_from_utf16(subj, start).next()
            } else {
                cp.re.find_from_ucs2(subj, start).next()
            }
        } else {
            let cache = cp.subject_cache.as_mut().expect("cache key matched");
            if !cache.classified {
                cache.ascii = if subj.len() <= ASCII_SUBJECT_CACHE_MAX_BYTES
                    && subj.iter().all(|unit| *unit <= 0x7f)
                {
                    let bytes = subj.iter().map(|unit| *unit as u8).collect::<Vec<_>>();
                    Some(unsafe { String::from_utf8_unchecked(bytes) })
                } else {
                    None
                };
                cache.classified = true;
                execution_flags |= EXEC_CACHE_FILL;
            } else {
                execution_flags |= EXEC_CACHE_HIT;
            }

            if let Some(ascii) = cache.ascii.as_ref() {
                execution_flags |= EXEC_ASCII;
                cp.re.find_from_ascii(ascii, start).next()
            } else {
                execution_flags |= EXEC_NON_ASCII;
                if cp.unicode_mode {
                    cp.re.find_from_utf16(subj, start).next()
                } else {
                    cp.re.find_from_ucs2(subj, start).next()
                }
            }
        }
    } else if cp.unicode_mode {
        cp.re.find_from_utf16(subj, start).next()
    } else {
        cp.re.find_from_ucs2(subj, start).next()
    };
    if !execution_flags_out.is_null() {
        unsafe { *execution_flags_out = execution_flags };
    }

    match found {
        Some(m) => {
            let n = write_captures(&m, caps_out, caps_cap);
            cp.fast_last_groups = 0;
            cp.last = Some(m);
            n
        }
        None => {
            cp.fast_last_groups = 0;
            cp.last = None;
            0
        }
    }
}

/// Copy the most recent successful match's capture pairs into caps_out without
/// re-matching. Returns the group count, or 0 if there is no retained match.
#[no_mangle]
pub unsafe extern "C" fn mal_regexp_copy_captures(
    handle: *mut core::ffi::c_void,
    caps_out: *mut i32,
    caps_cap: i32,
) -> i32 {
    if handle.is_null() {
        return -1;
    }
    let cp = unsafe { &*(handle as *const CompiledPattern) };
    if cp.fast_last_groups > 0 {
        return unsafe {
            copy_cached_captures(
                &cp.fast_last_captures,
                cp.fast_last_groups,
                caps_out,
                caps_cap,
            )
        };
    }
    match &cp.last {
        Some(m) => write_captures(m, caps_out, caps_cap),
        None => 0,
    }
}

/// Number of distinct named capture groups in the most recent match.
#[no_mangle]
pub unsafe extern "C" fn mal_regexp_named_group_count(handle: *mut core::ffi::c_void) -> i32 {
    if handle.is_null() {
        return 0;
    }
    let cp = unsafe { &*(handle as *const CompiledPattern) };
    cp.last
        .as_ref()
        .map(|m| m.named_groups().count() as i32)
        .unwrap_or(0)
}

/// The `index`-th named group of the most recent match: writes the name (UTF-8)
/// into name_out and returns the full byte length; writes the (start,end)
/// code-unit range into range_out[2] (-1,-1 if it did not participate). Returns
/// -1 if there is no retained match or the index is out of range.
#[no_mangle]
pub unsafe extern "C" fn mal_regexp_named_group(
    handle: *mut core::ffi::c_void,
    index: i32,
    name_out: *mut u8,
    name_cap: i32,
    range_out: *mut i32,
) -> i32 {
    if handle.is_null() || index < 0 {
        return -1;
    }
    let cp = unsafe { &*(handle as *const CompiledPattern) };
    let Some(m) = cp.last.as_ref() else {
        return -1;
    };
    let Some((name, range)) = m.named_groups().nth(index as usize) else {
        return -1;
    };

    if !range_out.is_null() {
        let (s, e) = match &range {
            Some(r) => (r.start as i32, r.end as i32),
            None => (-1, -1),
        };
        unsafe {
            *range_out = s;
            *range_out.add(1) = e;
        }
    }

    unsafe { write_utf8(name, name_out, name_cap) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(value: &str) -> Vec<u16> {
        value.encode_utf16().collect()
    }

    fn clear_cache() {
        PATTERN_CACHE.with(|cache| cache.borrow_mut().clear());
    }

    fn cache_len() -> usize {
        PATTERN_CACHE.with(|cache| cache.borrow().len())
    }

    unsafe fn handle(pattern: &[u16], flags: u32) -> *mut core::ffi::c_void {
        unsafe { mal_regexp_compile(pattern.as_ptr(), pattern.len(), flags) }
    }

    #[test]
    fn repeated_compilation_shares_only_the_regex() {
        clear_cache();
        let pattern = utf16("(a)(b)?");
        let first = unsafe { handle(&pattern, 0) };
        let second = unsafe { handle(&pattern, 0) };

        assert!(!first.is_null());
        assert!(!second.is_null());
        assert_ne!(first, second);
        let first_pattern = unsafe { &*(first as *const CompiledPattern) };
        let second_pattern = unsafe { &*(second as *const CompiledPattern) };
        assert!(Arc::ptr_eq(&first_pattern.re, &second_pattern.re));
        assert!(first_pattern.last.is_none());
        assert!(second_pattern.last.is_none());

        unsafe {
            mal_regexp_free(first);
            mal_regexp_free(second);
        }
    }

    #[test]
    fn shared_regex_handles_retain_independent_captures() {
        clear_cache();
        let pattern = utf16("(a)(b)?");
        let first = unsafe { handle(&pattern, 0) };
        let second = unsafe { handle(&pattern, 0) };
        let first_subject = utf16("ab");
        let second_subject = utf16("a");
        let mut first_caps = [-1; 6];
        let mut second_caps = [-1; 6];
        let mut first_flags = 0;
        let mut second_flags = 0;

        assert_eq!(
            unsafe {
                mal_regexp_exec(
                    first,
                    first_subject.as_ptr(),
                    first_subject.len(),
                    0,
                    first_subject.as_ptr().cast(),
                    1,
                    0,
                    first_caps.as_mut_ptr(),
                    first_caps.len() as i32,
                    &mut first_flags,
                )
            },
            3
        );
        assert_eq!(
            unsafe {
                mal_regexp_exec(
                    second,
                    second_subject.as_ptr(),
                    second_subject.len(),
                    0,
                    second_subject.as_ptr().cast(),
                    1,
                    0,
                    second_caps.as_mut_ptr(),
                    second_caps.len() as i32,
                    &mut second_flags,
                )
            },
            3
        );
        assert_eq!(first_caps, [0, 2, 0, 1, 1, 2]);
        assert_eq!(second_caps, [0, 1, 0, 1, -1, -1]);
        assert_eq!(first_flags, EXEC_CACHE_FILL);
        assert_eq!(second_flags, EXEC_CACHE_FILL);

        let mut retained = [-1; 6];
        assert_eq!(
            unsafe {
                mal_regexp_copy_captures(first, retained.as_mut_ptr(), retained.len() as i32)
            },
            3
        );
        assert_eq!(retained, first_caps);

        unsafe {
            mal_regexp_free(first);
            mal_regexp_free(second);
        }
    }

    #[test]
    fn repeated_immutable_subjects_use_ascii_after_one_utf16_probe() {
        clear_cache();
        let pattern = utf16("value=([0-9]{1,})");
        let subject = utf16("prefix value=42 suffix");
        let compiled = unsafe { handle(&pattern, 0) };
        let mut caps = [-1; 4];
        let mut flags = 0;

        for (expected_flags, epoch) in [
            (EXEC_CACHE_FILL, 7),
            (EXEC_ASCII | EXEC_CACHE_FILL, 7),
            (EXEC_ASCII | EXEC_CACHE_HIT, 7),
            (EXEC_CACHE_FILL, 8),
        ] {
            assert_eq!(
                unsafe {
                    mal_regexp_exec(
                        compiled,
                        subject.as_ptr(),
                        subject.len(),
                        0,
                        subject.as_ptr().cast(),
                        11,
                        epoch,
                        caps.as_mut_ptr(),
                        caps.len() as i32,
                        &mut flags,
                    )
                },
                2
            );
            assert_eq!(flags, expected_flags);
            assert_eq!(caps, [7, 15, 13, 15]);
        }

        unsafe { mal_regexp_free(compiled) };
    }

    #[test]
    fn fast_literal_and_class_plan_writes_captures_without_a_match_allocation() {
        clear_cache();
        let pattern = utf16("^level=([A-Z]+);user=([a-z]+)-([0-9]+);action=([a-z]+);");
        let subject = utf16("level=INFO;user=alpha-17;action=read;");
        let compiled = unsafe { handle(&pattern, 0) };
        let compiled_pattern = unsafe { &*(compiled as *const CompiledPattern) };
        assert!(compiled_pattern.fast.is_some());

        let mut captures = [-1; 10];
        let mut flags = 0;
        assert_eq!(
            unsafe {
                mal_regexp_exec(
                    compiled,
                    subject.as_ptr(),
                    subject.len(),
                    0,
                    subject.as_ptr().cast(),
                    1,
                    0,
                    captures.as_mut_ptr(),
                    captures.len() as i32,
                    &mut flags,
                )
            },
            5
        );
        assert_eq!(flags, EXEC_FAST);
        assert_eq!(captures, [0, 37, 6, 10, 16, 21, 22, 24, 32, 36]);

        let mut retained = [-1; 10];
        assert_eq!(
            unsafe {
                mal_regexp_copy_captures(compiled, retained.as_mut_ptr(), retained.len() as i32)
            },
            5
        );
        assert_eq!(retained, captures);
        unsafe { mal_regexp_free(compiled) };
    }

    #[test]
    fn fast_plan_is_conservative_about_flags_and_greedy_backtracking() {
        assert!(compile_fast_pattern(&utf16("value=([0-9]+)"), 0).is_some());
        assert!(compile_fast_pattern(&utf16("payload=[a-z]+"), 0).is_some());
        assert!(compile_fast_pattern(&utf16("value="), 0).is_some());
        assert!(compile_fast_pattern(&utf16("[a-z]+a"), 0).is_none());
        assert!(compile_fast_pattern(&utf16("[^-z]+"), 0).is_none());
        assert!(compile_fast_pattern(&utf16("value$"), 0).is_none());
        assert!(compile_fast_pattern(&utf16("value=([0-9]+)"), FLAG_IGNORE_CASE).is_none());
        assert!(compile_fast_pattern(&utf16("(?:value)"), 0).is_none());
    }

    #[test]
    fn repeated_non_ascii_subjects_remain_on_utf16_without_rescanning() {
        clear_cache();
        let pattern = utf16(".");
        let subject = utf16("é");
        let compiled = unsafe { handle(&pattern, 0) };
        let mut caps = [-1; 2];
        let mut flags = 0;

        for expected_flags in [
            EXEC_CACHE_FILL,
            EXEC_NON_ASCII | EXEC_CACHE_FILL,
            EXEC_NON_ASCII | EXEC_CACHE_HIT,
        ] {
            assert_eq!(
                unsafe {
                    mal_regexp_exec(
                        compiled,
                        subject.as_ptr(),
                        subject.len(),
                        0,
                        subject.as_ptr().cast(),
                        11,
                        7,
                        caps.as_mut_ptr(),
                        caps.len() as i32,
                        &mut flags,
                    )
                },
                1
            );
            assert_eq!(flags, expected_flags);
            assert_eq!(caps, [0, 1]);
        }

        unsafe { mal_regexp_free(compiled) };
    }

    #[test]
    fn compile_flags_are_part_of_the_cache_key() {
        clear_cache();
        let pattern = utf16("a");
        let (plain, _) = compile_pattern(&pattern, 0).unwrap();
        let (ignore_case, _) = compile_pattern(&pattern, FLAG_IGNORE_CASE).unwrap();

        assert!(!Arc::ptr_eq(&plain, &ignore_case));
        assert_eq!(cache_len(), 2);
        assert!(plain.find_from_ucs2(&utf16("A"), 0).next().is_none());
        assert!(ignore_case.find_from_ucs2(&utf16("A"), 0).next().is_some());
    }

    #[test]
    fn invalid_patterns_are_not_cached() {
        clear_cache();
        let pattern = utf16("(");

        assert!(compile_pattern(&pattern, 0).is_none());
        assert!(compile_pattern(&pattern, 0).is_none());
        assert_eq!(cache_len(), 0);
    }

    #[test]
    fn cache_is_bounded_and_evicts_the_least_recent_pattern() {
        clear_cache();
        let first_pattern = utf16("pattern-0");
        let (first, _) = compile_pattern(&first_pattern, 0).unwrap();

        for index in 1..=PATTERN_CACHE_CAPACITY {
            let pattern = utf16(&format!("pattern-{index}"));
            assert!(compile_pattern(&pattern, 0).is_some());
        }
        assert_eq!(cache_len(), PATTERN_CACHE_CAPACITY);

        let (recompiled, _) = compile_pattern(&first_pattern, 0).unwrap();
        assert!(!Arc::ptr_eq(&first, &recompiled));
        assert_eq!(cache_len(), PATTERN_CACHE_CAPACITY);
    }
}
