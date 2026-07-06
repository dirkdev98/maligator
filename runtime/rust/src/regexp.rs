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

use regress::{Flags, Match, Regex};

/// ABI version, mirrored by MAL_REGEXP_ABI_VERSION in mal_regexp.h.
/// v2: added `mal_regexp_free` (GC finalization, gc_todo.md D2).
pub const MAL_REGEXP_ABI_VERSION: u32 = 2;

// Flag bits, mirrored by MAL_REGEXP_FLAG_* in mal_regexp.h. g/y/d are
// engine-external and deliberately absent.
const FLAG_IGNORE_CASE: u32 = 1 << 0; // i
const FLAG_MULTILINE: u32 = 1 << 1; // m
const FLAG_DOT_ALL: u32 = 1 << 2; // s
const FLAG_UNICODE: u32 = 1 << 3; // u
const FLAG_UNICODE_SETS: u32 = 1 << 4; // v

/// A compiled pattern plus its most recent match. The C runtime drives one exec
/// at a time on a single thread and fully consumes each result (captures + named
/// groups) before issuing the next exec, so caching `last` here is sound and
/// lets named groups be queried after a match without re-running it. A `Match`
/// owns all of its data (it does not borrow the subject), so it is safe to
/// retain past the exec call.
struct CompiledPattern {
    re: Regex,
    /// `u`/`v` patterns match over code points; everything else over code units.
    unicode_mode: bool,
    last: Option<Match>,
}

/// Returns the ABI version baked into this archive.
#[no_mangle]
pub extern "C" fn mal_regexp_abi_version() -> u32 {
    MAL_REGEXP_ABI_VERSION
}

/// Build a `&[u16]` from a (ptr, len), tolerating a null ptr when len is 0
/// (`from_raw_parts` is UB on null even for an empty slice).
unsafe fn slice_u16<'a>(ptr: *const u16, len: usize) -> &'a [u16] {
    if len == 0 {
        &[]
    } else {
        unsafe { core::slice::from_raw_parts(ptr, len) }
    }
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

/// Compile a pattern (UTF-16) with the given flag bitmask. Returns an opaque,
/// leaked handle (a boxed `CompiledPattern`), or NULL if the pattern is invalid
/// — the C side maps NULL to a SyntaxError. Freed by the C side via mal_regexp_free.
#[no_mangle]
pub unsafe extern "C" fn mal_regexp_compile(
    pattern: *const u16,
    pattern_len: usize,
    flags: u32,
) -> *mut core::ffi::c_void {
    let units = unsafe { slice_u16(pattern, pattern_len) };

    let mut f = Flags::default();
    f.icase = flags & FLAG_IGNORE_CASE != 0;
    f.multiline = flags & FLAG_MULTILINE != 0;
    f.dot_all = flags & FLAG_DOT_ALL != 0;
    f.unicode = flags & FLAG_UNICODE != 0;
    f.unicode_sets = flags & FLAG_UNICODE_SETS != 0;
    let unicode_mode = f.unicode || f.unicode_sets;

    let codepoints = utf16_to_codepoints(units);
    match Regex::from_unicode(codepoints.into_iter(), f) {
        Ok(re) => {
            let boxed = Box::new(CompiledPattern {
                re,
                unicode_mode,
                last: None,
            });
            Box::into_raw(boxed) as *mut core::ffi::c_void
        }
        Err(_) => core::ptr::null_mut(),
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

/// Execute against `subject` (UTF-16) starting at code-unit index `start`.
/// Returns the group count (>= 1) on a match, 0 on no match, -1 on error.
#[no_mangle]
pub unsafe extern "C" fn mal_regexp_exec(
    handle: *mut core::ffi::c_void,
    subject: *const u16,
    subject_len: usize,
    start: usize,
    caps_out: *mut i32,
    caps_cap: i32,
) -> i32 {
    if handle.is_null() {
        return -1;
    }
    let cp = unsafe { &mut *(handle as *mut CompiledPattern) };

    if start > subject_len {
        cp.last = None;
        return 0;
    }
    let subj = unsafe { slice_u16(subject, subject_len) };

    let found = if cp.unicode_mode {
        cp.re.find_from_utf16(subj, start).next()
    } else {
        cp.re.find_from_ucs2(subj, start).next()
    };

    match found {
        Some(m) => {
            let n = write_captures(&m, caps_out, caps_cap);
            cp.last = Some(m);
            n
        }
        None => {
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

    let bytes = name.as_bytes();
    if !name_out.is_null() && name_cap > 0 {
        let n = bytes.len().min(name_cap as usize);
        unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), name_out, n) };
    }
    bytes.len() as i32
}
