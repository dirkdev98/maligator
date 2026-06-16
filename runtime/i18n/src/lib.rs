//! `mal_i18n` — thin FFI shim over ICU4X (and later temporal_rs) for Maligator.
//!
//! Design contract:
//!   * The C runtime owns ALL JavaScript-spec glue: option-bag parsing, ToXxx
//!     coercions, and the ECMA-402 / Date abstract operations.
//!   * This crate exposes only flat, pure i18n primitives over the C ABI.
//!   * Strings cross the boundary as UTF-8 via a length-probe-then-fill
//!     protocol; fallible calls return a `MalI18nStatus` and write outputs
//!     through out-pointers.

#![deny(unsafe_op_in_unsafe_fn)]

/// ABI version. Bump on any breaking change to the C header so the C side can
/// assert the linked archive matches `mal_i18n.h`.
pub const MAL_I18N_ABI_VERSION: u32 = 1;

/// Returns the ABI version baked into this archive.
#[no_mangle]
pub extern "C" fn mal_i18n_abi_version() -> u32 {
    MAL_I18N_ABI_VERSION
}

/// Copy `s` (UTF-8) into the caller buffer `out` (at most `out_cap` bytes) and
/// return the full byte length, so the C side can probe with cap 0 then fill.
fn write_str(s: &str, out: *mut u8, out_cap: i32) -> i32 {
    let bytes = s.as_bytes();
    if !out.is_null() && out_cap > 0 {
        let n = bytes.len().min(out_cap as usize);
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, n) };
    }
    bytes.len() as i32
}

/// Parse a BCP-47 tag from a UTF-8 buffer into an ICU4X Locale.
fn parse_locale(tag_ptr: *const u8, tag_len: usize) -> Option<icu::locale::Locale> {
    let bytes = unsafe { core::slice::from_raw_parts(tag_ptr, tag_len) };
    core::str::from_utf8(bytes).ok().and_then(|text| text.parse::<icu::locale::Locale>().ok())
}

// Cheap to construct over baked compiled_data (zero-copy refs to static data),
// and LocaleExpander is not Sync, so we build one per call rather than caching.
fn locale_expander() -> icu::locale::LocaleExpander {
    icu::locale::LocaleExpander::new_extended()
}

/// Parse + canonicalize a BCP-47 locale tag into `out`; returns the full length,
/// or -1 if the tag is structurally invalid (RangeError on the C side).
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_canonicalize_locale(tag_ptr: *const u8, tag_len: usize, out: *mut u8, out_cap: i32) -> i32 {
    match parse_locale(tag_ptr, tag_len) {
        Some(locale) => write_str(&locale.to_string(), out, out_cap),
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
    write_str(&locale.to_string(), out, out_cap)
}

/// Remove likely subtags (Intl.Locale.prototype.minimize) and write the result.
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_locale_minimize(tag_ptr: *const u8, tag_len: usize, out: *mut u8, out_cap: i32) -> i32 {
    let Some(mut locale) = parse_locale(tag_ptr, tag_len) else {
        return -1;
    };
    locale_expander().minimize(&mut locale.id);
    write_str(&locale.to_string(), out, out_cap)
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
    use icu::locale::extensions::unicode::key;
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
    write_str(&value, out, out_cap)
}

// ---------------------------------------------------------------------------
// Intl.Collator — an opaque, leaked ICU4X Collator + a UTF-16 compare entry.
// ---------------------------------------------------------------------------

/// Build a Collator for `locale` with ECMA-402-mapped options. Returns an opaque
/// (leaked) pointer, or null on failure. strength: 0 primary, 1 secondary, 2
/// tertiary; case_first: 0 off, 1 upper, 2 lower.
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_collator_new(
    locale_ptr: *const u8,
    locale_len: usize,
    strength: i32,
    case_level: i32,
    numeric: i32,
    case_first: i32,
) -> *mut core::ffi::c_void {
    use icu::collator::options::{CaseLevel, CollatorOptions, Strength};
    use icu::collator::preferences::{CollationCaseFirst, CollationNumericOrdering};
    use icu::collator::{Collator, CollatorPreferences};

    let Some(locale) = parse_locale(locale_ptr, locale_len) else {
        return core::ptr::null_mut();
    };
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

    // try_new returns a CollatorBorrowed<'static> (it borrows the baked
    // compiled_data); box that exact type so the compare side derefs it correctly.
    match Collator::try_new(prefs, options) {
        Ok(collator) => Box::into_raw(Box::new(collator)) as *mut core::ffi::c_void,
        Err(_) => core::ptr::null_mut(),
    }
}

/// Compare two UTF-16 strings with a collator handle: -1 / 0 / 1.
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_collator_compare_utf16(
    handle: *mut core::ffi::c_void,
    a_ptr: *const u16,
    a_len: usize,
    b_ptr: *const u16,
    b_len: usize,
) -> i32 {
    let collator = unsafe { &*(handle as *const icu::collator::CollatorBorrowed<'static>) };
    let a = unsafe { core::slice::from_raw_parts(a_ptr, a_len) };
    let b = unsafe { core::slice::from_raw_parts(b_ptr, b_len) };
    let sa = String::from_utf16_lossy(a);
    let sb = String::from_utf16_lossy(b);
    match collator.compare(&sa, &sb) {
        core::cmp::Ordering::Less => -1,
        core::cmp::Ordering::Equal => 0,
        core::cmp::Ordering::Greater => 1,
    }
}

// ---------------------------------------------------------------------------
// Intl.PluralRules
// ---------------------------------------------------------------------------

/// Build a PluralRules for `locale` (ordinal != 0 selects ordinal rules).
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_plural_rules_new(locale_ptr: *const u8, locale_len: usize, ordinal: i32) -> *mut core::ffi::c_void {
    use icu::plurals::{PluralRuleType, PluralRules};
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
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_plural_category(handle: *mut core::ffi::c_void, number: f64) -> i32 {
    use icu::plurals::PluralCategory;
    let rules = unsafe { &*(handle as *const icu::plurals::PluralRules) };
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

// ---------------------------------------------------------------------------
// Intl.NumberFormat — decimal + percent (style currency/unit/compact are TODO).
// ---------------------------------------------------------------------------

/// Format `number` for `locale`. percent != 0 scales by 100 and appends '%'.
/// Honors min integer / min+max fraction digits and grouping. Writes UTF-8 into
/// `out`; returns the full length, or -1 on failure.
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_number_format(
    locale_ptr: *const u8,
    locale_len: usize,
    number: f64,
    percent: i32,
    min_integer: i32,
    min_fraction: i32,
    max_fraction: i32,
    grouping: i32,
    out: *mut u8,
    out_cap: i32,
) -> i32 {
    use icu::decimal::input::Decimal;
    use icu::decimal::options::{DecimalFormatterOptions, GroupingStrategy};
    use icu::decimal::DecimalFormatter;

    let Some(locale) = parse_locale(locale_ptr, locale_len) else {
        return -1;
    };
    let value = if percent != 0 { number * 100.0 } else { number };

    // Rust's Display for f64 is the shortest round-trip decimal (never
    // scientific), which Decimal parses; rounding to maxFractionDigits follows.
    let rendered = format!("{}", value);
    let mut decimal = match Decimal::try_from_str(&rendered) {
        Ok(d) => d,
        Err(_) => return -1,
    };
    // maximumFractionDigits: round at 10^-max_fraction; minimumFractionDigits:
    // pad the fraction to 10^-min_fraction; minimumIntegerDigits: pad the integer
    // part out to 10^(min_integer-1).
    decimal.round(-(max_fraction as i16));
    decimal.pad_end(-(min_fraction as i16));
    if min_integer > 1 {
        decimal.pad_start((min_integer - 1) as i16);
    }

    let mut options = DecimalFormatterOptions::default();
    options.grouping_strategy = Some(if grouping != 0 { GroupingStrategy::Auto } else { GroupingStrategy::Never });
    let formatter = match DecimalFormatter::try_new((&locale).into(), options) {
        Ok(f) => f,
        Err(_) => return -1,
    };
    let mut text = formatter.format_to_string(&decimal);
    if percent != 0 {
        text.push('%');
    }
    write_str(&text, out, out_cap)
}

// ---------------------------------------------------------------------------
// Intl.DateTimeFormat — dateStyle / timeStyle over icu_datetime fieldsets.
// The C side passes pre-resolved civil components (local wall clock).
// ---------------------------------------------------------------------------

/// Format civil date/time components for `locale`. date_style / time_style:
/// -1 none, 0 full, 1 long, 2 medium, 3 short. Writes UTF-8 into `out`; returns
/// the full length, or -1 on failure.
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
    use icu::datetime::fieldsets;
    use icu::datetime::options::{Length, TimePrecision};
    use icu::datetime::DateTimeFormatter;

    let Some(locale) = parse_locale(locale_ptr, locale_len) else {
        return -1;
    };
    let Ok(date) = icu::calendar::Date::try_new_iso(year, month as u8, day as u8) else {
        return -1;
    };
    let Ok(time) = icu::time::Time::try_new(hour as u8, minute as u8, second as u8, 0) else {
        return -1;
    };
    let input = icu::time::DateTime { date, time };

    let to_length = |style: i32| match style {
        0 | 1 => Length::Long, // "full" maps to the closest available, "long"
        3 => Length::Short,
        _ => Length::Medium,
    };
    let ymd = |style: i32| fieldsets::YMD::medium().with_length(to_length(style));
    let t = |style: i32| fieldsets::T::medium().with_length(to_length(style));

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
    write_str(&text, out, out_cap)
}

/// Status codes returned by fallible FFI entry points. The C side maps these to
/// the appropriate JS exception (e.g. `Range` -> RangeError).
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

/// Offset east-of-UTC, in milliseconds, of the system zone at the UTC instant
/// `epoch_ms`. Out-of-range instants (beyond jiff's supported span) report 0.
fn offset_ms_at(tz: &jiff::tz::TimeZone, epoch_ms: i64) -> i64 {
    match jiff::Timestamp::from_millisecond(epoch_ms) {
        Ok(ts) => tz.to_offset(ts).seconds() as i64 * 1000,
        Err(_) => 0,
    }
}

/// LocalTZA(epoch_ms): the system zone's offset (ms east of UTC) at that UTC
/// instant. The C side computes LocalTime(t) = t + this.
#[no_mangle]
pub extern "C" fn mal_i18n_local_offset_ms(epoch_ms: i64) -> i64 {
    offset_ms_at(system_time_zone(), epoch_ms)
}

/// UTC(local_ms): map a local wall-clock (expressed as ms-since-epoch as if it
/// were UTC) back to the UTC instant. A two-step offset refinement resolves the
/// DST gap/overlap ambiguity the way a single subtraction cannot.
#[no_mangle]
pub extern "C" fn mal_i18n_utc_from_local_ms(local_ms: i64) -> i64 {
    let tz = system_time_zone();
    let first = offset_ms_at(tz, local_ms);
    let second = offset_ms_at(tz, local_ms - first);
    local_ms - second
}

/// Write the system zone's IANA name (e.g. "Europe/Amsterdam", "UTC") into `buf`
/// as UTF-8, up to `cap` bytes. Returns the full byte length (probe with cap=0).
#[no_mangle]
pub unsafe extern "C" fn mal_i18n_local_tz_name(buf: *mut u8, cap: i32) -> i32 {
    let name = system_time_zone().iana_name().unwrap_or("UTC");
    let bytes = name.as_bytes();
    if !buf.is_null() && cap > 0 {
        let n = bytes.len().min(cap as usize);
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), buf, n) };
    }
    bytes.len() as i32
}
