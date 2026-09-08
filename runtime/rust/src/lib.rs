//! `mal_rust` — the Maligator runtime's Rust FFI shim. One staticlib for all the
//! runtime's Rust-backed primitives: ICU4X (Intl) below, regress (RegExp) in
//! `regexp`, and later temporal_rs (Temporal). It is a single crate because two
//! Rust staticlibs cannot link into one binary (duplicate std panic-runtime
//! symbols); each domain gets its own C header (mal_i18n.h, mal_regexp.h).
//!
//! Design contract (per domain):
//!   * The C runtime owns ALL JavaScript-spec glue: option-bag parsing, ToXxx
//!     coercions, and the ECMA-402 / Date / RegExp abstract operations.
//!   * This crate exposes only flat, pure primitives over the C ABI.
//!   * i18n strings cross as UTF-8 via length-probe-then-fill; regexp patterns/
//!     subjects cross as UTF-16 (see src/regexp.rs).

#![deny(unsafe_op_in_unsafe_fn)]

mod ffi;
mod number_format;

// temporal_rs's official C ABI. Keeping it in this crate preserves the one-
// staticlib rule while exporting the generated `temporal_rs_*` symbols to C.
#[cfg(feature = "temporal")]
extern crate temporal_capi;

// The RegExp FFI (regress engine). Gated behind the `regexp` Cargo feature
// (engine.regexp) so a non-regex build drops the engine + its Unicode tables. See
// src/regexp.rs.
#[cfg(feature = "regexp")]
pub mod regexp;

// The WHATWG URL FFI (ada-url crate). Both the web and Node surfaces select the
// `url` feature; a build with neither drops the C++ parser and its runtime link.
#[cfg(feature = "url")]
pub mod url;

// Portable decompression primitives for node:zlib. This module owns codec state
// only; it never retains input/output pointers supplied by the C caller.
#[cfg(feature = "node-zlib")]
pub mod zlib;

#[cfg(feature = "node-tls")]
pub mod tls;

// Argon2 derivation primitives for node:crypto. Pure computation over borrowed
// byte slices: no retained pointers, no shared state, no message strings across
// the ABI. See src/argon2.rs + include/mal_argon2.h.
#[cfg(feature = "node-argon2")]
pub mod argon2;

/// ABI version. Bump on any breaking change to the C header so the C side can
/// assert the linked archive matches `mal_i18n.h`.
/// v2: added `mal_i18n_collator_free` / `mal_i18n_plural_rules_free` (gc_todo.md D2).
/// v3: `mal_i18n_number_format` gained min/max significant-digit parameters.
/// v4: `mal_i18n_number_format` gained a sign_display parameter.
/// v5: NumberFormat / DateTimeFormat gained persistent formatter handles.
pub const MAL_I18N_ABI_VERSION: u32 = 5;

/// Returns the ABI version baked into this archive.
#[no_mangle]
pub extern "C" fn mal_i18n_abi_version() -> u32 {
    MAL_I18N_ABI_VERSION
}

// The Intl (ICU4X) surface. Gated behind the `intl` Cargo feature so an
// `engine.intl: false` build compiles the ICU crates away entirely — dropping the
// ~9 MB of baked CLDR data. tz (jiff) stays unconditional; regexp is gated by
// `regexp` and URL by `url` (above). The
// `#[no_mangle]` symbols export from inside this module regardless of Rust
// visibility, so the C side links them exactly as before when the feature is on.
#[cfg(feature = "intl")]
mod intl {
use crate::ffi::{nullable_slice, nullable_u16_slice, write_utf8};

/// Parse a BCP-47 tag from a UTF-8 buffer into an ICU4X Locale.
fn parse_locale(tag_ptr: *const u8, tag_len: usize) -> Option<icu_locale::Locale> {
    let bytes = unsafe { core::slice::from_raw_parts(tag_ptr, tag_len) };
    core::str::from_utf8(bytes).ok().and_then(|text| text.parse::<icu_locale::Locale>().ok())
}

// Cheap to construct over baked compiled_data (zero-copy refs to static data),
// and LocaleExpander is not Sync, so we build one per call rather than caching.
fn locale_expander() -> icu_locale::LocaleExpander {
    icu_locale::LocaleExpander::new_extended()
}

/// Parse + canonicalize a BCP-47 locale tag into `out`; returns the full length,
/// or -1 if the tag is structurally invalid (RangeError on the C side).
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_canonicalize_locale(tag_ptr: *const u8, tag_len: usize, out: *mut u8, out_cap: i32) -> i32 {
    match parse_locale(tag_ptr, tag_len) {
        Some(mut locale) => {
            icu_locale::LocaleCanonicalizer::new_extended().canonicalize(&mut locale);
            unsafe { write_utf8(&locale.to_string(), out, out_cap) }
        },
        None => -1,
    }
}

/// Add likely subtags (Intl.Locale.prototype.maximize) and write the result.
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_locale_maximize(tag_ptr: *const u8, tag_len: usize, out: *mut u8, out_cap: i32) -> i32 {
    let Some(mut locale) = parse_locale(tag_ptr, tag_len) else {
        return -1;
    };
    locale_expander().maximize(&mut locale.id);
    unsafe { write_utf8(&locale.to_string(), out, out_cap) }
}

/// Remove likely subtags (Intl.Locale.prototype.minimize) and write the result.
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_locale_minimize(tag_ptr: *const u8, tag_len: usize, out: *mut u8, out_cap: i32) -> i32 {
    let Some(mut locale) = parse_locale(tag_ptr, tag_len) else {
        return -1;
    };
    locale_expander().minimize(&mut locale.id);
    unsafe { write_utf8(&locale.to_string(), out, out_cap) }
}

/// Locale subtag selector for mal_i18n_locale_field.
pub const MAL_LOCALE_FIELD_BASE_NAME: i32 = 0;
pub const MAL_LOCALE_FIELD_LANGUAGE: i32 = 1;
pub const MAL_LOCALE_FIELD_SCRIPT: i32 = 2;
pub const MAL_LOCALE_FIELD_REGION: i32 = 3;
// Unicode extension keyword values (calendar/collation/hourCycle/caseFirst/
// numeric/numberingSystem).
pub const MAL_LOCALE_FIELD_CALENDAR: i32 = 4;
pub const MAL_LOCALE_FIELD_COLLATION: i32 = 5;
pub const MAL_LOCALE_FIELD_HOUR_CYCLE: i32 = 6;
pub const MAL_LOCALE_FIELD_CASE_FIRST: i32 = 7;
pub const MAL_LOCALE_FIELD_NUMERIC: i32 = 8;
pub const MAL_LOCALE_FIELD_NUMBERING_SYSTEM: i32 = 9;

/// Extract a subtag or Unicode-extension keyword (the Intl.Locale getters).
/// Writes the value (UTF-8, empty when absent) into `out`; returns -1 for an
/// invalid tag or unknown field.
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_locale_field(tag_ptr: *const u8, tag_len: usize, field: i32, out: *mut u8, out_cap: i32) -> i32 {
    use icu_locale::extensions::unicode::key;
    let Some(locale) = parse_locale(tag_ptr, tag_len) else {
        return -1;
    };
    let keyword = |k| locale.extensions.unicode.keywords.get(&k).map(|v| v.to_string()).unwrap_or_default();
    let value = match field {
        MAL_LOCALE_FIELD_BASE_NAME => locale.id.to_string(),
        MAL_LOCALE_FIELD_LANGUAGE => locale.id.language.to_string(),
        MAL_LOCALE_FIELD_SCRIPT => locale.id.script.map(|s| s.to_string()).unwrap_or_default(),
        MAL_LOCALE_FIELD_REGION => locale.id.region.map(|r| r.to_string()).unwrap_or_default(),
        MAL_LOCALE_FIELD_CALENDAR => keyword(key!("ca")),
        MAL_LOCALE_FIELD_COLLATION => keyword(key!("co")),
        MAL_LOCALE_FIELD_HOUR_CYCLE => keyword(key!("hc")),
        MAL_LOCALE_FIELD_CASE_FIRST => keyword(key!("kf")),
        // kn canonicalizes to an empty value; present (and not "false") means true.
        MAL_LOCALE_FIELD_NUMERIC => match locale.extensions.unicode.keywords.get(&key!("kn")) {
            Some(value) if value.to_string() == "false" => "false".to_string(),
            Some(_) => "true".to_string(),
            None => String::new(),
        },
        MAL_LOCALE_FIELD_NUMBERING_SYSTEM => keyword(key!("nu")),
        _ => return -1,
    };
    unsafe { write_utf8(&value, out, out_cap) }
}

// ---------------------------------------------------------------------------
// Intl.Collator — an opaque, leaked ICU4X Collator + a UTF-16 compare entry.
// ---------------------------------------------------------------------------

#[cfg(feature = "intl-collator")]
fn compare_utf16_with_collator(
    collator: &icu_collator::CollatorBorrowed<'static>,
    a_ptr: *const u16,
    a_len: usize,
    b_ptr: *const u16,
    b_len: usize,
) -> i32 {
    // ICU accepts the VM's UTF-16 view directly and compares each unpaired
    // surrogate as U+FFFD, matching the previous lossy conversion without its
    // two temporary Rust String allocations.
    let a = unsafe { nullable_u16_slice(a_ptr, a_len) };
    let b = unsafe { nullable_u16_slice(b_ptr, b_len) };
    match collator.compare_utf16(a, b) {
        core::cmp::Ordering::Less => -1,
        core::cmp::Ordering::Equal => 0,
        core::cmp::Ordering::Greater => 1,
    }
}

#[cfg(feature = "intl-collator")]
fn new_default_collator() -> Option<icu_collator::CollatorBorrowed<'static>> {
    use icu_collator::options::{CollatorOptions, Strength};
    use icu_collator::preferences::{CollationCaseFirst, CollationNumericOrdering};
    use icu_collator::{Collator, CollatorPreferences};

    let locale = "en-US".parse::<icu_locale::Locale>().ok()?;
    let mut prefs = CollatorPreferences::from(&locale);
    prefs.case_first = Some(CollationCaseFirst::False);
    prefs.numeric_ordering = Some(CollationNumericOrdering::False);
    let mut options = CollatorOptions::default();
    options.strength = Some(Strength::Tertiary);
    Collator::try_new(prefs, options).ok()
}

#[cfg(feature = "intl-collator")]
thread_local! {
    /// String#localeCompare with omitted locales/options uses this exact immutable
    /// default plan. ICU4X's borrowed collator is not Sync, while each VM mutator
    /// stays on one thread, so TLS avoids both synchronization and per-call setup.
    static DEFAULT_COLLATOR: std::cell::OnceCell<Option<icu_collator::CollatorBorrowed<'static>>> =
        const { std::cell::OnceCell::new() };
}

/// Build a Collator for `locale` with ECMA-402-mapped options. Returns an opaque
/// (leaked) pointer, or null on failure. strength: 0 primary, 1 secondary, 2
/// tertiary; case_first: 0 off, 1 upper, 2 lower.
#[cfg(feature = "intl-collator")]
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_collator_new(
    locale_ptr: *const u8,
    locale_len: usize,
    strength: i32,
    case_level: i32,
    numeric: i32,
    case_first: i32,
) -> *mut core::ffi::c_void {
    let Some(locale) = parse_locale(locale_ptr, locale_len) else {
        return core::ptr::null_mut();
    };
    match new_collator(locale, strength, case_level, numeric, case_first) {
        Some(collator) => Box::into_raw(Box::new(collator)) as *mut core::ffi::c_void,
        None => core::ptr::null_mut(),
    }
}

#[cfg(feature = "intl-collator")]
fn new_collator(locale: icu_locale::Locale, strength: i32, case_level: i32, numeric: i32, case_first: i32) -> Option<icu_collator::CollatorBorrowed<'static>> {
    use icu_collator::options::{CaseLevel, CollatorOptions, Strength};
    use icu_collator::preferences::{CollationCaseFirst, CollationNumericOrdering};
    use icu_collator::{Collator, CollatorPreferences};

    // case-first and numeric are locale preferences in ICU4X 2.x, not options.
    let mut prefs = CollatorPreferences::from(&locale);
    prefs.case_first = Some(match case_first {
        1 => CollationCaseFirst::Upper,
        2 => CollationCaseFirst::Lower,
        _ => CollationCaseFirst::False,
    });
    prefs.numeric_ordering = Some(if numeric != 0 {
        CollationNumericOrdering::True
    } else {
        CollationNumericOrdering::False
    });

    let mut options = CollatorOptions::default();
    options.strength = Some(match strength {
        0 => Strength::Primary,
        1 => Strength::Secondary,
        _ => Strength::Tertiary,
    });
    if case_level != 0 {
        options.case_level = Some(CaseLevel::On);
    }

    Collator::try_new(prefs, options).ok()
}

#[cfg(feature = "intl-collator")]
type CachedCollation = (Vec<u8>, i32, icu_collator::CollatorBorrowed<'static>);

#[cfg(feature = "intl-collator")]
thread_local! {
    // Borrowed ICU plans are not Sync; bounded TLS owns no VM or JavaScript references.
    static PREPARED_COLLATORS: std::cell::RefCell<std::collections::VecDeque<CachedCollation>> =
        const { std::cell::RefCell::new(std::collections::VecDeque::new()) };
}

#[cfg(feature = "intl-collator")]
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_prepared_collator_compare_utf16(
    locale_ptr: *const u8, locale_len: usize, options: i32,
    a_ptr: *const u16, a_len: usize, b_ptr: *const u16, b_len: usize,
    cache_hit: *mut u8,
) -> i32 {
    if !cache_hit.is_null() { unsafe { *cache_hit = 0; } }
    if locale_len > 128 || options < 0 || options >= 48 || options & 3 == 3 ||
        (options & 4 != 0 && options & 3 != 0) { return 2; }
    let key = unsafe { nullable_slice(locale_ptr, locale_len) };
    PREPARED_COLLATORS.with(|slot| {
        let mut cache = slot.borrow_mut();
        if let Some(index) = cache.iter().position(|(locale, flags, _)| locale == key && *flags == options) {
            let entry = cache.remove(index).unwrap();
            let result = compare_utf16_with_collator(&entry.2, a_ptr, a_len, b_ptr, b_len);
            cache.push_back(entry);
            if !cache_hit.is_null() { unsafe { *cache_hit = 1; } }
            return result;
        }
        let Some(mut locale) = parse_locale(locale_ptr, locale_len) else { return 2; };
        icu_locale::LocaleCanonicalizer::new_extended().canonicalize(&mut locale);
        // Match the C constructor's canonical tag capacity before preparing its plan.
        if locale.to_string().len() >= 160 { return 2; }
        let Some(collator) = new_collator(locale, options & 3, (options >> 2) & 1, (options >> 3) & 1, options >> 4) else { return 2; };
        let result = compare_utf16_with_collator(&collator, a_ptr, a_len, b_ptr, b_len);
        if cache.len() == 16 { cache.pop_front(); }
        cache.push_back((key.to_vec(), options, collator));
        result
    })
}

#[cfg(all(test, feature = "intl-collator"))]
mod collation_tests {
    use super::*;

    #[test]
    fn prepared_collation_preserves_options_and_bounds_cache_retention() {
        PREPARED_COLLATORS.with(|slot| slot.borrow_mut().clear());
        let locale = b"en-US";
        let a = [0x0032, 0x00e4];
        let b = [0x0031, 0x0030, 0x0061];
        for flags in 0..48 {
            if flags & 3 == 3 || (flags & 4 != 0 && flags & 3 != 0) { continue; }
            let mut hit = 255;
            unsafe {
                let fresh = mal_i18n_collator_new(locale.as_ptr(), locale.len(), flags & 3, (flags >> 2) & 1, (flags >> 3) & 1, flags >> 4);
                assert!(!fresh.is_null());
                let expected = mal_i18n_collator_compare_utf16(fresh, a.as_ptr(), a.len(), b.as_ptr(), b.len());
                mal_i18n_collator_free(fresh);
                assert_eq!(mal_i18n_prepared_collator_compare_utf16(locale.as_ptr(), locale.len(), flags, a.as_ptr(), a.len(), b.as_ptr(), b.len(), &mut hit), expected);
                assert_eq!(hit, 0);
                assert_eq!(mal_i18n_prepared_collator_compare_utf16(locale.as_ptr(), locale.len(), flags, a.as_ptr(), a.len(), b.as_ptr(), b.len(), &mut hit), expected);
                assert_eq!(hit, 1);
            }
            PREPARED_COLLATORS.with(|slot| assert!(slot.borrow().len() <= 16));
        }
        let mut hit = 255;
        unsafe { mal_i18n_prepared_collator_compare_utf16(locale.as_ptr(), locale.len(), 0, a.as_ptr(), a.len(), b.as_ptr(), b.len(), &mut hit); }
        assert_eq!(hit, 0);
    }
}

/// Compare two UTF-16 strings with a collator handle: -1 / 0 / 1.
#[cfg(feature = "intl-collator")]
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_collator_compare_utf16(
    handle: *mut core::ffi::c_void,
    a_ptr: *const u16,
    a_len: usize,
    b_ptr: *const u16,
    b_len: usize,
) -> i32 {
    let collator = unsafe { &*(handle as *const icu_collator::CollatorBorrowed<'static>) };
    compare_utf16_with_collator(collator, a_ptr, a_len, b_ptr, b_len)
}

/// Compare with the thread-local default en-US Collator. Returns 2 only if the
/// baked default plan could not be constructed; ordinary results are -1 / 0 / 1.
#[cfg(feature = "intl-collator")]
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_default_collator_compare_utf16(
    a_ptr: *const u16,
    a_len: usize,
    b_ptr: *const u16,
    b_len: usize,
) -> i32 {
    DEFAULT_COLLATOR.with(|slot| match slot.get_or_init(new_default_collator) {
        Some(collator) => compare_utf16_with_collator(collator, a_ptr, a_len, b_ptr, b_len),
        None => 2,
    })
}

/// Free a collator handle from `mal_i18n_collator_new`. Null-tolerant (idempotent
/// GC finalizer). Must box-drop the exact `CollatorBorrowed<'static>` that
/// `mal_i18n_collator_new` leaked.
#[cfg(feature = "intl-collator")]
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_collator_free(handle: *mut core::ffi::c_void) {
    if handle.is_null() {
        return;
    }
    drop(unsafe { Box::from_raw(handle as *mut icu_collator::CollatorBorrowed<'static>) });
}

// ---------------------------------------------------------------------------
// Intl.PluralRules
// ---------------------------------------------------------------------------

/// Build a PluralRules for `locale` (ordinal != 0 selects ordinal rules).
#[cfg(feature = "intl-plural-rules")]
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_plural_rules_new(locale_ptr: *const u8, locale_len: usize, ordinal: i32) -> *mut core::ffi::c_void {
    use icu_plurals::{PluralRuleType, PluralRules};
    let Some(locale) = parse_locale(locale_ptr, locale_len) else {
        return core::ptr::null_mut();
    };
    let prefs = (&locale).into();
    let rule_type = if ordinal != 0 { PluralRuleType::Ordinal } else { PluralRuleType::Cardinal };
    match PluralRules::try_new(prefs, rule_type.into()) {
        Ok(rules) => Box::into_raw(Box::new(rules)) as *mut core::ffi::c_void,
        Err(_) => core::ptr::null_mut(),
    }
}

/// Select the plural category for `number`: 0 zero, 1 one, 2 two, 3 few, 4 many, 5 other.
#[cfg(feature = "intl-plural-rules")]
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_plural_category(handle: *mut core::ffi::c_void, number: f64) -> i32 {
    use icu_plurals::PluralCategory;
    let rules = unsafe { &*(handle as *const icu_plurals::PluralRules) };
    // TODO #12: derive operands from the formatted number (min/max fraction
    // digits) instead of the integer value, so fractional categories are exact.
    match rules.category_for(number as i128) {
        PluralCategory::Zero => 0,
        PluralCategory::One => 1,
        PluralCategory::Two => 2,
        PluralCategory::Few => 3,
        PluralCategory::Many => 4,
        PluralCategory::Other => 5,
    }
}

/// Free a plural-rules handle from `mal_i18n_plural_rules_new`. Null-tolerant.
#[cfg(feature = "intl-plural-rules")]
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_plural_rules_free(handle: *mut core::ffi::c_void) {
    if handle.is_null() {
        return;
    }
    drop(unsafe { Box::from_raw(handle as *mut icu_plurals::PluralRules) });
}

// ---------------------------------------------------------------------------
// Intl.NumberFormat — decimal + percent (style currency/unit/compact are TODO).
// ---------------------------------------------------------------------------

/// Rounds `decimal` at `position` using ECMA-402's default rounding mode,
/// halfExpand (round to nearest, ties away from zero). The icu_decimal re-export
/// does not expose fixed_decimal's rounding-mode enum, so dispatch by hand.
#[cfg(feature = "intl-number-format")]
fn round_half_expand(decimal: &mut icu_decimal::input::Decimal, position: i16) {
    if decimal.digit_at(position - 1) >= 5 {
        decimal.expand(position);
    } else {
        decimal.trunc(position);
    }
}

/// Maps the C-side sign_display code to `icu_decimal::input::SignDisplay`: 0
/// auto, 1 never, 2 always, 3 exceptZero, 4 negative (mirrors ECMA-402's
/// signDisplay values and fixed_decimal's SignDisplay variant order).
#[cfg(feature = "intl-number-format")]
fn sign_display_from_code(code: i32) -> icu_decimal::input::SignDisplay {
    use icu_decimal::input::SignDisplay;
    match code {
        1 => SignDisplay::Never,
        2 => SignDisplay::Always,
        3 => SignDisplay::ExceptZero,
        4 => SignDisplay::Negative,
        _ => SignDisplay::Auto,
    }
}

#[cfg(feature = "intl-number-format")]
std::thread_local! {
    static DEFAULT_EN_US_NUMBER_FORMATTER: std::cell::OnceCell<icu_decimal::DecimalFormatter> =
        const { std::cell::OnceCell::new() };
}

#[cfg(feature = "intl-number-format")]
fn default_en_us_number_formatter() -> Option<icu_decimal::DecimalFormatter> {
    use icu_decimal::options::{DecimalFormatterOptions, GroupingStrategy};
    use icu_decimal::DecimalFormatter;

    let locale = "en-US".parse::<icu_locale::Locale>().ok()?;
    let mut options = DecimalFormatterOptions::default();
    options.grouping_strategy = Some(GroupingStrategy::Auto);
    DecimalFormatter::try_new((&locale).into(), options).ok()
}

/// The option-free Number.prototype.toLocaleString plan: en-US decimal style,
/// grouping on, 1 integer digit, and 0..3 fraction digits. Keeping this narrow
/// makes the cached formatter independent of observable locale/options parsing.
#[cfg(feature = "intl-number-format")]
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_number_format_default_en_us(
    number: f64,
    out: *mut u8,
    out_cap: i32,
) -> i32 {
    use icu_decimal::input::Decimal;
    use icu_decimal::input::SignDisplay;

    if !number.is_finite() {
        return -1;
    }
    let rendered = format!("{}", number);
    let mut decimal = match Decimal::try_from_str(&rendered) {
        Ok(decimal) => decimal,
        Err(_) => return -1,
    };
    round_half_expand(&mut decimal, -3);
    decimal.pad_end(0);
    decimal.apply_sign_display(SignDisplay::Auto);

    DEFAULT_EN_US_NUMBER_FORMATTER.with(|cache| {
        if cache.get().is_none() {
            let Some(formatter) = default_en_us_number_formatter() else {
                return -1;
            };
            let _ = cache.set(formatter);
        }
        let Some(formatter) = cache.get() else {
            return -1;
        };
        let text = formatter.format_to_string(&decimal);
        unsafe { write_utf8(&text, out, out_cap) }
    })
}

#[cfg(feature = "intl-number-format")]
struct MalNumberFormatter {
    formatter: icu_decimal::DecimalFormatter,
    percent: bool,
    min_integer: i32,
    min_fraction: i32,
    max_fraction: i32,
    min_significant: i32,
    max_significant: i32,
    sign_display: i32,
}

/// Build the immutable ICU formatter and resolved numeric plan once per
/// Intl.NumberFormat instance. JavaScript option access remains entirely on the
/// C side and is complete before this pure native constructor is called.
#[cfg(feature = "intl-number-format")]
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_number_formatter_new(
    locale_ptr: *const u8,
    locale_len: usize,
    percent: i32,
    min_integer: i32,
    min_fraction: i32,
    max_fraction: i32,
    min_significant: i32,
    max_significant: i32,
    grouping: i32,
    sign_display: i32,
) -> *mut core::ffi::c_void {
    use icu_decimal::options::{DecimalFormatterOptions, GroupingStrategy};
    use icu_decimal::DecimalFormatter;

    let Some(locale) = parse_locale(locale_ptr, locale_len) else {
        return core::ptr::null_mut();
    };
    let mut options = DecimalFormatterOptions::default();
    options.grouping_strategy = Some(if grouping != 0 { GroupingStrategy::Auto } else { GroupingStrategy::Never });
    let Ok(formatter) = DecimalFormatter::try_new((&locale).into(), options) else {
        return core::ptr::null_mut();
    };
    Box::into_raw(Box::new(MalNumberFormatter {
        formatter,
        percent: percent != 0,
        min_integer,
        min_fraction,
        max_fraction,
        min_significant,
        max_significant,
        sign_display,
    })) as *mut core::ffi::c_void
}

/// Format with a persistent Intl.NumberFormat plan. The handle owns both the
/// ICU locale/grouping formatter and the already-resolved digit options, so this
/// hot path performs no locale parsing, formatter construction, or JS property
/// lookup. Non-finite values remain C-side because their ECMA-402 sign handling
/// does not enter ICU's fixed-decimal pipeline.
#[cfg(feature = "intl-number-format")]
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_number_formatter_format(
    handle: *mut core::ffi::c_void,
    number: f64,
    out: *mut u8,
    out_cap: i32,
) -> i32 {
    use icu_decimal::input::Decimal;

    let Some(plan) = (unsafe { (handle as *const MalNumberFormatter).as_ref() }) else {
        return -1;
    };
    if !number.is_finite() {
        return -1;
    }
    let value = if plan.percent { number * 100.0 } else { number };

    // Rust's Display for f64 is the shortest round-trip decimal (never
    // scientific), which Decimal parses; rounding follows.
    let rendered = format!("{}", value);
    let mut decimal = match Decimal::try_from_str(&rendered) {
        Ok(d) => d,
        Err(_) => return -1,
    };
    if plan.max_significant > 0 {
        // Significant-digit rounding: keep max_significant digits starting at the
        // most significant one, then pad the tail out to min_significant.
        if !decimal.is_zero() {
            let msd = decimal.nonzero_magnitude_start();
            round_half_expand(&mut decimal, msd - (plan.max_significant as i16) + 1);
        }
        // Drop rounding's trailing zeros, then pad back up to min_significant.
        decimal.trim_end();
        let msd = decimal.nonzero_magnitude_start();
        decimal.pad_end(msd - (plan.min_significant as i16) + 1);
    } else {
        // maximumFractionDigits: round at 10^-max_fraction; minimumFractionDigits:
        // pad the fraction to 10^-min_fraction.
        round_half_expand(&mut decimal, -(plan.max_fraction as i16));
        decimal.pad_end(-(plan.min_fraction as i16));
    }
    // minimumIntegerDigits: pad the integer part out to 10^(min_integer-1).
    if plan.min_integer > 1 {
        decimal.pad_start((plan.min_integer - 1) as i16);
    }
    // Applied after rounding so a value that rounds to zero (or -0) is judged
    // by its final displayed magnitude, per ECMA-402 FormatNumericToString.
    decimal.apply_sign_display(sign_display_from_code(plan.sign_display));

    let mut text = plan.formatter.format_to_string(&decimal);
    if plan.percent {
        text.push('%');
    }
    unsafe { write_utf8(&text, out, out_cap) }
}

/// Free a number-formatter handle. Null-tolerant for GC finalization.
#[cfg(feature = "intl-number-format")]
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_number_formatter_free(handle: *mut core::ffi::c_void) {
    if handle.is_null() {
        return;
    }
    drop(unsafe { Box::from_raw(handle as *mut MalNumberFormatter) });
}

// ---------------------------------------------------------------------------
// Intl.DateTimeFormat — dateStyle / timeStyle over icu_datetime fieldsets.
// The C side passes pre-resolved civil components (local wall clock).
// ---------------------------------------------------------------------------

#[cfg(feature = "intl-date-time-format")]
std::thread_local! {
    static DEFAULT_EN_US_DATE_TIME_FORMATTER: std::cell::OnceCell<
        Option<icu_datetime::DateTimeFormatter<icu_datetime::fieldsets::YMDT>>,
    > = const { std::cell::OnceCell::new() };
    static DEFAULT_EN_US_DATE_FORMATTER: std::cell::OnceCell<
        Option<icu_datetime::DateTimeFormatter<icu_datetime::fieldsets::YMD>>,
    > = const { std::cell::OnceCell::new() };
    static DEFAULT_EN_US_TIME_FORMATTER: std::cell::OnceCell<
        Option<icu_datetime::DateTimeFormatter<icu_datetime::fieldsets::T>>,
    > = const { std::cell::OnceCell::new() };
}

#[cfg(feature = "intl-date-time-format")]
enum MalDateTimeFormatter {
    DateTime(icu_datetime::DateTimeFormatter<icu_datetime::fieldsets::YMDT>),
    Date(icu_datetime::DateTimeFormatter<icu_datetime::fieldsets::YMD>),
    Time(icu_datetime::DateTimeFormatter<icu_datetime::fieldsets::T>),
}

/// Build the immutable ICU formatter once per Intl.DateTimeFormat instance.
#[cfg(feature = "intl-date-time-format")]
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_datetime_formatter_new(
    locale_ptr: *const u8,
    locale_len: usize,
    date_style: i32,
    time_style: i32,
) -> *mut core::ffi::c_void {
    use icu_datetime::fieldsets;
    use icu_datetime::options::{Length, TimePrecision};
    use icu_datetime::DateTimeFormatter;

    let Some(locale) = parse_locale(locale_ptr, locale_len) else {
        return core::ptr::null_mut();
    };
    let to_length = |style: i32| match style {
        0 | 1 => Length::Long,
        3 => Length::Short,
        _ => Length::Medium,
    };
    let ymd = |style: i32| fieldsets::YMD::medium().with_length(to_length(style));
    let t = |style: i32| fieldsets::T::medium().with_length(to_length(style));

    let formatter = if date_style >= 0 && time_style >= 0 {
        let fields = ymd(date_style).with_time(TimePrecision::Second);
        match DateTimeFormatter::try_new((&locale).into(), fields) {
            Ok(formatter) => MalDateTimeFormatter::DateTime(formatter),
            Err(_) => return core::ptr::null_mut(),
        }
    } else if date_style >= 0 {
        match DateTimeFormatter::try_new((&locale).into(), ymd(date_style)) {
            Ok(formatter) => MalDateTimeFormatter::Date(formatter),
            Err(_) => return core::ptr::null_mut(),
        }
    } else if time_style >= 0 {
        match DateTimeFormatter::try_new((&locale).into(), t(time_style)) {
            Ok(formatter) => MalDateTimeFormatter::Time(formatter),
            Err(_) => return core::ptr::null_mut(),
        }
    } else {
        match DateTimeFormatter::try_new((&locale).into(), ymd(2)) {
            Ok(formatter) => MalDateTimeFormatter::Date(formatter),
            Err(_) => return core::ptr::null_mut(),
        }
    };
    Box::into_raw(Box::new(formatter)) as *mut core::ffi::c_void
}

/// Format civil components with a persistent Intl.DateTimeFormat plan.
#[cfg(feature = "intl-date-time-format")]
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_datetime_formatter_format(
    handle: *mut core::ffi::c_void,
    year: i32,
    month: i32,
    day: i32,
    hour: i32,
    minute: i32,
    second: i32,
    out: *mut u8,
    out_cap: i32,
) -> i32 {
    let Some(formatter) = (unsafe { (handle as *const MalDateTimeFormatter).as_ref() }) else {
        return -1;
    };
    let Ok(date) = icu_calendar::Date::try_new_iso(year, month as u8, day as u8) else {
        return -1;
    };
    let Ok(time) = icu_time::Time::try_new(hour as u8, minute as u8, second as u8, 0) else {
        return -1;
    };
    let input = icu_time::DateTime { date, time };
    let text = match formatter {
        MalDateTimeFormatter::DateTime(formatter) => formatter.format(&input).to_string(),
        MalDateTimeFormatter::Date(formatter) => formatter.format(&input).to_string(),
        MalDateTimeFormatter::Time(formatter) => formatter.format(&input).to_string(),
    };
    unsafe { write_utf8(&text, out, out_cap) }
}

/// Free a date-time formatter handle. Null-tolerant for GC finalization.
#[cfg(feature = "intl-date-time-format")]
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_datetime_formatter_free(handle: *mut core::ffi::c_void) {
    if handle.is_null() {
        return;
    }
    drop(unsafe { Box::from_raw(handle as *mut MalDateTimeFormatter) });
}

/// Format civil date/time components for `locale`. date_style / time_style:
/// -1 none, 0 full, 1 long, 2 medium, 3 short. Writes UTF-8 into `out`; returns
/// the full length, or -1 on failure.
#[cfg(feature = "intl-date-time-format")]
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_datetime_format(
    locale_ptr: *const u8,
    locale_len: usize,
    year: i32,
    month: i32,
    day: i32,
    hour: i32,
    minute: i32,
    second: i32,
    date_style: i32,
    time_style: i32,
    out: *mut u8,
    out_cap: i32,
) -> i32 {
    use icu_datetime::fieldsets;
    use icu_datetime::options::{Length, TimePrecision};
    use icu_datetime::DateTimeFormatter;

    let Ok(date) = icu_calendar::Date::try_new_iso(year, month as u8, day as u8) else {
        return -1;
    };
    let Ok(time) = icu_time::Time::try_new(hour as u8, minute as u8, second as u8, 0) else {
        return -1;
    };
    let input = icu_time::DateTime { date, time };

    let to_length = |style: i32| match style {
        0 | 1 => Length::Long, // "full" maps to the closest available, "long"
        3 => Length::Short,
        _ => Length::Medium,
    };
    let ymd = |style: i32| fieldsets::YMD::medium().with_length(to_length(style));
    let t = |style: i32| fieldsets::T::medium().with_length(to_length(style));

    let default_text = if unsafe { nullable_slice(locale_ptr, locale_len) } == b"en-US" {
        match (date_style, time_style) {
            (2, 2) => DEFAULT_EN_US_DATE_TIME_FORMATTER.with(|cache| {
                cache
                    .get_or_init(|| {
                        let locale = "en-US".parse::<icu_locale::Locale>().ok()?;
                        DateTimeFormatter::try_new(
                            (&locale).into(),
                            ymd(2).with_time(TimePrecision::Second),
                        )
                        .ok()
                    })
                    .as_ref()
                    .map(|formatter| formatter.format(&input).to_string())
            }),
            (2, -1) => DEFAULT_EN_US_DATE_FORMATTER.with(|cache| {
                cache
                    .get_or_init(|| {
                        let locale = "en-US".parse::<icu_locale::Locale>().ok()?;
                        DateTimeFormatter::try_new((&locale).into(), ymd(2)).ok()
                    })
                    .as_ref()
                    .map(|formatter| formatter.format(&input).to_string())
            }),
            (-1, 2) => DEFAULT_EN_US_TIME_FORMATTER.with(|cache| {
                cache
                    .get_or_init(|| {
                        let locale = "en-US".parse::<icu_locale::Locale>().ok()?;
                        DateTimeFormatter::try_new((&locale).into(), t(2)).ok()
                    })
                    .as_ref()
                    .map(|formatter| formatter.format(&input).to_string())
            }),
            _ => None,
        }
    } else {
        None
    };
    if let Some(text) = default_text {
        return unsafe { write_utf8(&text, out, out_cap) };
    }

    let Some(locale) = parse_locale(locale_ptr, locale_len) else {
        return -1;
    };

    let text = if date_style >= 0 && time_style >= 0 {
        // time length follows the date length in this fieldset model.
        let fs = ymd(date_style).with_time(TimePrecision::Second);
        match DateTimeFormatter::try_new((&locale).into(), fs) {
            Ok(f) => f.format(&input).to_string(),
            Err(_) => return -1,
        }
    } else if date_style >= 0 {
        match DateTimeFormatter::try_new((&locale).into(), ymd(date_style)) {
            Ok(f) => f.format(&input).to_string(),
            Err(_) => return -1,
        }
    } else if time_style >= 0 {
        match DateTimeFormatter::try_new((&locale).into(), t(time_style)) {
            Ok(f) => f.format(&input).to_string(),
            Err(_) => return -1,
        }
    } else {
        match DateTimeFormatter::try_new((&locale).into(), ymd(2)) {
            Ok(f) => f.format(&input).to_string(),
            Err(_) => return -1,
        }
    };
    unsafe { write_utf8(&text, out, out_cap) }
}

// ---------------------------------------------------------------------------
// Intl.ListFormat — icu_list::ListFormatter (and/or/unit, wide/short/narrow).
// ---------------------------------------------------------------------------

/// A borrowed UTF-16 string, matching the C-side `MalU16Str`. Used to pass a JS
/// String array across the ABI without a UTF-8 round-trip in C.
#[repr(C)]
pub struct MalU16Str {
    pub ptr: *const u16,
    pub len: usize,
}

/// Format a list of strings for `locale`. list_type: 0 conjunction(and), 1
/// disjunction(or), 2 unit; length: 0 long, 1 short, 2 narrow. Writes UTF-8 into
/// `out`; returns the full length, or -1 on failure.
#[cfg(feature = "intl-list-format")]
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_list_format(
    locale_ptr: *const u8,
    locale_len: usize,
    list_type: i32,
    length: i32,
    items: *const MalU16Str,
    items_count: usize,
    out: *mut u8,
    out_cap: i32,
) -> i32 {
    use icu_list::options::{ListFormatterOptions, ListLength};
    use icu_list::ListFormatter;

    let Some(locale) = parse_locale(locale_ptr, locale_len) else {
        return -1;
    };
    let prefs = (&locale).into();
    let options = ListFormatterOptions::default().with_length(match length {
        1 => ListLength::Short,
        2 => ListLength::Narrow,
        _ => ListLength::Wide,
    });
    let formatter = match list_type {
        1 => ListFormatter::try_new_or(prefs, options),
        2 => ListFormatter::try_new_unit(prefs, options),
        _ => ListFormatter::try_new_and(prefs, options),
    };
    let Ok(formatter) = formatter else {
        return -1;
    };
    let slice = unsafe { nullable_slice(items, items_count) };
    let strings: Vec<String> = slice
        .iter()
        .map(|s| {
            // List formatting is scalar-value based: lone surrogates become
            // U+FFFD when each item is converted to a Rust String.
            let u = unsafe { nullable_u16_slice(s.ptr, s.len) };
            String::from_utf16_lossy(u)
        })
        .collect();
    let text = formatter.format_to_string(strings.iter());
    unsafe { write_utf8(&text, out, out_cap) }
}

// ---------------------------------------------------------------------------
// Intl.Segmenter — icu_segmenter (grapheme / word / sentence).
// ---------------------------------------------------------------------------

/// Segment `text` (UTF-16) at the given granularity (0 grapheme, 1 word, 2
/// sentence). Writes the segment boundary positions as UTF-16 indices into
/// `bounds_out` (including 0 and the end, so segment count = returned-1), and a
/// per-segment isWordLike flag (0/1) into `wordlike_out` (meaningful only for
/// word granularity). `cap` is the capacity of `bounds_out` in i32 elements.
/// Returns the number of boundaries written.
#[cfg(feature = "intl-segmenter")]
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_segment(
    granularity: i32,
    text_ptr: *const u16,
    text_len: usize,
    bounds_out: *mut i32,
    wordlike_out: *mut u8,
    cap: i32,
) -> i32 {
    use icu_segmenter::options::{SentenceBreakInvariantOptions, WordBreakInvariantOptions};
    use icu_segmenter::{GraphemeClusterSegmenter, SentenceSegmenter, WordSegmenter};

    // ICU segmentation consumes scalar values, so malformed UTF-16 is lossy.
    let u = unsafe { nullable_u16_slice(text_ptr, text_len) };
    let s = String::from_utf16_lossy(u);

    // Map each UTF-8 byte offset (on a char boundary) to a UTF-16 index in `s`.
    let mut byte_to_utf16: std::collections::HashMap<usize, i32> = std::collections::HashMap::new();
    let mut utf16: i32 = 0;
    for (b, c) in s.char_indices() {
        byte_to_utf16.insert(b, utf16);
        utf16 += c.len_utf16() as i32;
    }
    byte_to_utf16.insert(s.len(), utf16);

    let map = |b: usize| -> i32 { *byte_to_utf16.get(&b).unwrap_or(&0) };

    let mut bounds: Vec<i32> = Vec::new();
    let mut word_like: Vec<u8> = Vec::new();

    if granularity == 1 {
        let segmenter = WordSegmenter::new_auto(WordBreakInvariantOptions::default());
        let mut it = segmenter.segment_str(&s);
        let mut prev = it.next();
        if let Some(p) = prev {
            bounds.push(map(p));
        }
        while let Some(b) = it.next() {
            bounds.push(map(b));
            word_like.push(if it.is_word_like() { 1 } else { 0 });
            prev = Some(b);
        }
        let _ = prev;
    } else if granularity == 2 {
        let segmenter = SentenceSegmenter::new(SentenceBreakInvariantOptions::default());
        for b in segmenter.segment_str(&s) {
            bounds.push(map(b));
        }
    } else {
        let segmenter = GraphemeClusterSegmenter::new();
        for b in segmenter.segment_str(&s) {
            bounds.push(map(b));
        }
    }

    let n = bounds.len().min(cap.max(0) as usize);
    if !bounds_out.is_null() {
        for (i, v) in bounds.iter().take(n).enumerate() {
            unsafe { *bounds_out.add(i) = *v };
        }
    }
    if !wordlike_out.is_null() {
        for (i, v) in word_like.iter().take(n.saturating_sub(1)).enumerate() {
            unsafe { *wordlike_out.add(i) = *v };
        }
    }
    bounds.len() as i32
}

// ---------------------------------------------------------------------------
// Intl.DisplayNames — icu_experimental::displaynames (region/script/language).
// ---------------------------------------------------------------------------

/// Display name for a code. kind: 0 region, 1 script, 2 language. style: 0 long,
/// 1 short, 2 narrow. Writes UTF-8 into `out`; returns the length, -1 when there
/// is no name (C decides Fallback), or -2 when the code is structurally invalid.
#[cfg(feature = "intl-display-names")]
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_display_name(
    locale_ptr: *const u8,
    locale_len: usize,
    kind: i32,
    style: i32,
    code_ptr: *const u8,
    code_len: usize,
    out: *mut u8,
    out_cap: i32,
) -> i32 {
    use icu_experimental::displaynames::multi::{
        LanguageDisplayNames, RegionDisplayNames, ScriptDisplayNames,
    };
    use icu_experimental::displaynames::{DisplayNamesOptions, Style};
    use icu_locale::subtags::{Language, Region, Script};

    let Some(locale) = parse_locale(locale_ptr, locale_len) else {
        return -1;
    };
    let code_bytes = unsafe { core::slice::from_raw_parts(code_ptr, code_len) };
    let Ok(code) = core::str::from_utf8(code_bytes) else {
        return -2;
    };
    let prefs = (&locale).into();
    let mut options = DisplayNamesOptions::default();
    options.style = Some(match style {
        1 => Style::Short,
        2 => Style::Narrow,
        _ => Style::Long,
    });

    let name: Option<String> = match kind {
        0 => {
            let Ok(region) = code.parse::<Region>() else {
                return -2;
            };
            RegionDisplayNames::try_new(prefs, options)
                .ok()
                .and_then(|d| d.of(region).map(|s| s.to_string()))
        }
        1 => {
            let Ok(script) = code.parse::<Script>() else {
                return -2;
            };
            ScriptDisplayNames::try_new(prefs, options)
                .ok()
                .and_then(|d| d.of(script).map(|s| s.to_string()))
        }
        2 => {
            let Ok(language) = code.parse::<Language>() else {
                return -2;
            };
            LanguageDisplayNames::try_new(prefs, options)
                .ok()
                .and_then(|d| d.of(language).map(|s| s.to_string()))
        }
        _ => return -1,
    };
    match name {
        Some(text) => unsafe { write_utf8(&text, out, out_cap) },
        None => -1,
    }
}

// ---------------------------------------------------------------------------
// Intl.RelativeTimeFormat — icu_experimental::relativetime.
// ---------------------------------------------------------------------------

/// Format `value` of `unit` relative to now. length: 0 long, 1 short, 2 narrow.
/// unit: 0 second, 1 minute, 2 hour, 3 day, 4 week, 5 month, 6 quarter, 7 year.
/// numeric_auto != 0 selects Numeric::Auto ("yesterday"), else Always ("1 day
/// ago"). Writes UTF-8 into `out`; returns the length, or -1 on failure.
#[cfg(feature = "intl-relative-time-format")]
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_relative_time(
    locale_ptr: *const u8,
    locale_len: usize,
    length: i32,
    unit: i32,
    numeric_auto: i32,
    value: f64,
    out: *mut u8,
    out_cap: i32,
) -> i32 {
    use icu_decimal::input::Decimal;
    use icu_experimental::relativetime::options::Numeric;
    use icu_experimental::relativetime::{RelativeTimeFormatter, RelativeTimeFormatterOptions};
    use writeable::Writeable;

    let Some(locale) = parse_locale(locale_ptr, locale_len) else {
        return -1;
    };
    let prefs = (&locale).into();
    let mut options = RelativeTimeFormatterOptions::default();
    options.numeric = if numeric_auto != 0 { Numeric::Auto } else { Numeric::Always };

    let formatter = match (length, unit) {
        (0, 0) => RelativeTimeFormatter::try_new_long_second(prefs, options),
        (0, 1) => RelativeTimeFormatter::try_new_long_minute(prefs, options),
        (0, 2) => RelativeTimeFormatter::try_new_long_hour(prefs, options),
        (0, 3) => RelativeTimeFormatter::try_new_long_day(prefs, options),
        (0, 4) => RelativeTimeFormatter::try_new_long_week(prefs, options),
        (0, 5) => RelativeTimeFormatter::try_new_long_month(prefs, options),
        (0, 6) => RelativeTimeFormatter::try_new_long_quarter(prefs, options),
        (0, 7) => RelativeTimeFormatter::try_new_long_year(prefs, options),
        (1, 0) => RelativeTimeFormatter::try_new_short_second(prefs, options),
        (1, 1) => RelativeTimeFormatter::try_new_short_minute(prefs, options),
        (1, 2) => RelativeTimeFormatter::try_new_short_hour(prefs, options),
        (1, 3) => RelativeTimeFormatter::try_new_short_day(prefs, options),
        (1, 4) => RelativeTimeFormatter::try_new_short_week(prefs, options),
        (1, 5) => RelativeTimeFormatter::try_new_short_month(prefs, options),
        (1, 6) => RelativeTimeFormatter::try_new_short_quarter(prefs, options),
        (1, 7) => RelativeTimeFormatter::try_new_short_year(prefs, options),
        (2, 0) => RelativeTimeFormatter::try_new_narrow_second(prefs, options),
        (2, 1) => RelativeTimeFormatter::try_new_narrow_minute(prefs, options),
        (2, 2) => RelativeTimeFormatter::try_new_narrow_hour(prefs, options),
        (2, 3) => RelativeTimeFormatter::try_new_narrow_day(prefs, options),
        (2, 4) => RelativeTimeFormatter::try_new_narrow_week(prefs, options),
        (2, 5) => RelativeTimeFormatter::try_new_narrow_month(prefs, options),
        (2, 6) => RelativeTimeFormatter::try_new_narrow_quarter(prefs, options),
        (2, 7) => RelativeTimeFormatter::try_new_narrow_year(prefs, options),
        _ => return -1,
    };
    let Ok(formatter) = formatter else {
        return -1;
    };
    let rendered = format!("{}", value);
    let Ok(decimal) = Decimal::try_from_str(&rendered) else {
        return -1;
    };
    let text = formatter.format(decimal).write_to_string().into_owned();
    unsafe { write_utf8(&text, out, out_cap) }
}

// ---------------------------------------------------------------------------
// Intl.DurationFormat — icu_experimental::duration.
// ---------------------------------------------------------------------------

/// Format a duration for `locale`. base_style: 0 long, 1 short, 2 narrow, 3
/// digital. fractional_digits: -1 for "show all", else a fixed count.
/// sign_negative != 0 marks the whole duration negative. `units` is 10 u64s in
/// the order years, months, weeks, days, hours, minutes, seconds, milliseconds,
/// microseconds, nanoseconds. Writes UTF-8 into `out`; returns the length, or -1.
#[cfg(feature = "intl-duration-format")]
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_duration_format(
    locale_ptr: *const u8,
    locale_len: usize,
    base_style: i32,
    fractional_digits: i32,
    sign_negative: i32,
    units: *const u64,
    out: *mut u8,
    out_cap: i32,
) -> i32 {
    use icu_experimental::duration::options::{BaseStyle, DurationFormatterOptions, FractionalDigits};
    use icu_experimental::duration::{Duration, DurationFormatter, DurationSign, ValidatedDurationFormatterOptions};
    use writeable::Writeable;

    let Some(locale) = parse_locale(locale_ptr, locale_len) else {
        return -1;
    };
    let u = unsafe { core::slice::from_raw_parts(units, 10) };
    let duration = Duration {
        sign: if sign_negative != 0 { DurationSign::Negative } else { DurationSign::Positive },
        years: u[0],
        months: u[1],
        weeks: u[2],
        days: u[3],
        hours: u[4],
        minutes: u[5],
        seconds: u[6],
        milliseconds: u[7],
        microseconds: u[8],
        nanoseconds: u[9],
    };
    let mut options = DurationFormatterOptions::default();
    options.base = match base_style {
        1 => BaseStyle::Short,
        2 => BaseStyle::Narrow,
        3 => BaseStyle::Digital,
        _ => BaseStyle::Long,
    };
    if fractional_digits >= 0 {
        options.fractional_digits = FractionalDigits::Fixed(fractional_digits as u8);
    }
    let Ok(validated) = ValidatedDurationFormatterOptions::validate(options) else {
        return -1;
    };
    let Ok(formatter) = DurationFormatter::try_new((&locale).into(), validated) else {
        return -1;
    };
    let text = formatter.format(&duration).write_to_string().into_owned();
    unsafe { write_utf8(&text, out, out_cap) }
}
} // mod intl

/// Status codes returned by fallible FFI entry points. The C side maps these to
/// the appropriate JS exception (e.g. `Range` -> RangeError). Mirrors the enum in
/// mal_i18n.h; kept at crate root (not in `mod intl`) as the FFI return-code
/// contract, independent of the `intl` feature.
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MalI18nStatus {
    Ok = 0,
    /// A value was outside the spec-permitted range (-> RangeError).
    Range = 1,
    /// A locale / option / argument was structurally invalid (-> RangeError).
    Invalid = 2,
    /// An internal i18n-library error with no direct JS mapping (-> RangeError).
    Internal = 3,
    /// The caller-provided output buffer was too small; retry with the
    /// `needed` length reported via the out-pointer (probe-then-fill).
    BufferTooSmall = 4,
}

/// Spike-only smoke entry point: confirms argument marshaling across the ABI.
/// Removed once a real primitive exists.
#[no_mangle]
pub extern "C" fn mal_i18n_spike_roundtrip(x: u32) -> u32 {
    x.wrapping_mul(2).wrapping_add(1)
}

// ---------------------------------------------------------------------------
// Timezone — Date's LocalTZA. Backed by jiff's bundled tzdb so offsets are
// deterministic and historically/future correct, while the chosen zone is the
// host's (TZ env, then the /etc/localtime symlink). Cached once per process.
// ---------------------------------------------------------------------------

fn system_time_zone() -> &'static jiff::tz::TimeZone {
    static TZ: std::sync::OnceLock<jiff::tz::TimeZone> = std::sync::OnceLock::new();
    TZ.get_or_init(jiff::tz::TimeZone::system)
}

/// Project an ECMAScript Date instant into Jiff's supported span. Gregorian
/// calendars repeat every 400 years, including the weekday of each date, so
/// this preserves recurring TZif/POSIX rules outside Jiff's year range.
const DATE_GREGORIAN_CYCLE_MS: i64 = 146_097 * 86_400_000;

fn date_offset_timestamp(epoch_ms: i64) -> jiff::Timestamp {
    if let Ok(timestamp) = jiff::Timestamp::from_millisecond(epoch_ms) {
        return timestamp;
    }

    const GREGORIAN_CYCLE_MS: i128 = DATE_GREGORIAN_CYCLE_MS as i128;
    let epoch_ms = epoch_ms as i128;
    let boundary_ms = if epoch_ms < 0 {
        jiff::Timestamp::MIN.as_millisecond() as i128
    } else {
        jiff::Timestamp::MAX.as_millisecond() as i128
    };
    let distance = (epoch_ms - boundary_ms).abs();
    let cycles = (distance + GREGORIAN_CYCLE_MS - 1) / GREGORIAN_CYCLE_MS;
    let mapped_ms = if epoch_ms < boundary_ms {
        epoch_ms + cycles * GREGORIAN_CYCLE_MS
    } else {
        epoch_ms - cycles * GREGORIAN_CYCLE_MS
    };
    jiff::Timestamp::from_millisecond(mapped_ms as i64)
        .expect("400-year projection must fit Jiff's timestamp range")
}

/// Offset east-of-UTC, in milliseconds, of the system zone at the UTC instant
/// `epoch_ms` across the full ECMAScript Date range.
fn offset_ms_at(tz: &jiff::tz::TimeZone, epoch_ms: i64) -> i64 {
    tz.to_offset(date_offset_timestamp(epoch_ms)).seconds() as i64 * 1000
}

thread_local! {
    /// Date getter/render loops commonly project the same [[DateValue]] several
    /// times. The system zone is process-immutable after `system_time_zone()` is
    /// initialized, so an exact instant cache avoids repeating Jiff's transition
    /// lookup without broadening the result across a DST boundary.
    static DATE_OFFSET_CACHE: std::cell::Cell<(i64, i64)> =
        const { std::cell::Cell::new((i64::MIN, 0)) };
}

fn cached_offset_ms_at(tz: &jiff::tz::TimeZone, epoch_ms: i64) -> i64 {
    // i64::MIN is the empty-key sentinel. It is outside ECMAScript's Date range,
    // but keep the flat FFI helper correct for that input by bypassing the cache.
    if epoch_ms == i64::MIN {
        return offset_ms_at(tz, epoch_ms);
    }
    DATE_OFFSET_CACHE.with(|cache| {
        let (cached_epoch_ms, cached_offset_ms) = cache.get();
        if cached_epoch_ms == epoch_ms {
            return cached_offset_ms;
        }
        let offset_ms = offset_ms_at(tz, epoch_ms);
        cache.set((epoch_ms, offset_ms));
        offset_ms
    })
}

/// LocalTZA(epoch_ms): the system zone's offset (ms east of UTC) at that UTC
/// instant. The C side computes LocalTime(t) = t + this.
#[no_mangle]
pub extern "C" fn mal_i18n_local_offset_ms(epoch_ms: i64) -> i64 {
    cached_offset_ms_at(system_time_zone(), epoch_ms)
}

fn compatible_offset_ms_from_local(
    tz: &jiff::tz::TimeZone,
    projected: jiff::Timestamp,
) -> i64 {
    use jiff::tz::AmbiguousOffset;

    let local = jiff::tz::Offset::UTC.to_datetime(projected);
    let offset = match tz.to_ambiguous_timestamp(local).offset() {
        AmbiguousOffset::Unambiguous { offset } => offset,
        AmbiguousOffset::Gap { before, .. } => before,
        AmbiguousOffset::Fold { before, .. } => before,
    };
    offset.seconds() as i64 * 1000
}

fn utc_from_local_ms_at(tz: &jiff::tz::TimeZone, local_ms: i64) -> i64 {
    let projected = date_offset_timestamp(local_ms);
    let offset_ms = compatible_offset_ms_from_local(tz, projected);
    // ECMAScript Date's local intermediates are at most one day beyond TimeClip
    // and cannot overflow. Keep the flat FFI total for arbitrary i64 callers too.
    local_ms.saturating_sub(offset_ms)
}

/// UTC(local_ms): map a local wall-clock (expressed as ms-since-epoch as if it
/// were UTC) back to the UTC instant. Jiff's Compatible disambiguation selects
/// the earlier instant in a fold and advances by the gap for a nonexistent time.
#[no_mangle]
pub extern "C" fn mal_i18n_utc_from_local_ms(local_ms: i64) -> i64 {
    utc_from_local_ms_at(system_time_zone(), local_ms)
}

/// Write the system zone's IANA name (e.g. "Europe/Amsterdam", "UTC") into `buf`
/// as UTF-8, up to `cap` bytes. Returns the full byte length (probe with cap=0).
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_local_tz_name(buf: *mut u8, cap: i32) -> i32 {
    let name = system_time_zone().iana_name().unwrap_or("UTC");
    unsafe { ffi::write_utf8(name, buf, cap) }
}

#[cfg(test)]
mod date_timezone_tests {
    use super::{offset_ms_at, utc_from_local_ms_at};

    fn utc_ms(dt: jiff::civil::DateTime) -> i64 {
        jiff::tz::TimeZone::UTC
            .to_timestamp(dt)
            .unwrap()
            .as_millisecond()
    }

    #[test]
    fn named_zone_offsets_cover_ecmascript_date_extremes() {
        let tz = jiff::tz::TimeZone::get("Europe/Amsterdam").unwrap();

        assert_ne!(offset_ms_at(&tz, -8_640_000_000_000_000), 0);
        assert_ne!(offset_ms_at(&tz, 8_640_000_000_000_000), 0);
    }

    #[test]
    fn local_to_utc_uses_compatible_dst_disambiguation() {
        use jiff::civil::date;

        let tz = jiff::tz::TimeZone::get("Europe/Amsterdam").unwrap();

        let fold = utc_ms(date(2024, 10, 27).at(2, 30, 0, 0));
        let fold_expected = utc_ms(date(2024, 10, 27).at(0, 30, 0, 0));
        assert_eq!(utc_from_local_ms_at(&tz, fold), fold_expected);

        let gap = utc_ms(date(2024, 3, 31).at(2, 30, 0, 0));
        let gap_expected = utc_ms(date(2024, 3, 31).at(1, 30, 0, 0));
        assert_eq!(utc_from_local_ms_at(&tz, gap), gap_expected);
    }
}
