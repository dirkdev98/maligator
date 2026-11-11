use crate::intl::parse_locale;
use crate::intl_decimal::{supports_digits, DecimalProvider};
use crate::intl_unit::{UnitFormat, UnitLocale, UnitSpec};
use core::fmt;
use fixed_decimal::{Decimal, RoundingIncrement, Sign, SignedRoundingMode, UnsignedRoundingMode};
use icu_decimal::provider::{DecimalDigitsV1, DecimalSymbolsV1};
use icu_provider::prelude::*;
use std::cell::RefCell;
use writeable::Writeable;

struct NumberProvider {
    decimal: DecimalProvider,
    symbols: RefCell<Option<DataPayload<DecimalSymbolsV1>>>,
}

impl DataProvider<DecimalSymbolsV1> for NumberProvider {
    fn load(&self, request: DataRequest) -> Result<DataResponse<DecimalSymbolsV1>, DataError> {
        let response = self.decimal.load(request)?;
        *self.symbols.borrow_mut() = Some(response.payload.clone());
        Ok(response)
    }
}
impl DataProvider<DecimalDigitsV1> for NumberProvider {
    fn load(&self, request: DataRequest) -> Result<DataResponse<DecimalDigitsV1>, DataError> {
        self.decimal.load(request)
    }
}

struct NumberUnit {
    identifier: String,
    width: i32,
    formatter: UnitFormat,
    plurals: icu_plurals::PluralRules,
}

struct NumberPlan {
    formatter: icu_decimal::DecimalFormatter,
    symbols: DataPayload<DecimalSymbolsV1>,
    locale: String,
    numbering: Box<DataMarkerAttributes>,
    style: i32,
    unit: Option<Box<NumberUnit>>,
    min_integer: i32,
    min_fraction: i32,
    max_fraction: i32,
    min_significant: i32,
    max_significant: i32,
    grouping: i32,
    sign_display: i32,
    rounding_mode: SignedRoundingMode,
    rounding_increment: RoundingIncrement,
    increment_shift: i16,
    priority: i32,
    strip_zero: bool,
}

impl NumberPlan {
    fn resolved(&self) -> MalI18nNumberResolved {
        MalI18nNumberResolved {
            locale: self.locale.as_ptr(),
            locale_len: self.locale.len(),
            numbering: self.numbering.as_str().as_ptr(),
            numbering_len: self.numbering.as_str().len(),
            heap_bytes: self.heap_bytes(),
            style: self.style,
            unit: self
                .unit
                .as_ref()
                .map_or(core::ptr::null(), |unit| unit.identifier.as_ptr()),
            unit_len: self.unit.as_ref().map_or(0, |unit| unit.identifier.len()),
            unit_display: self.unit.as_ref().map_or(1, |unit| unit.width),
            min_integer: self.min_integer,
            min_fraction: self.min_fraction,
            max_fraction: self.max_fraction,
            min_significant: self.min_significant,
            max_significant: self.max_significant,
            grouping: self.grouping,
            sign_display: self.sign_display,
            rounding_mode: match self.rounding_mode {
                SignedRoundingMode::Ceil => 1,
                SignedRoundingMode::Floor => 2,
                SignedRoundingMode::Unsigned(UnsignedRoundingMode::Expand) => 3,
                SignedRoundingMode::Unsigned(UnsignedRoundingMode::Trunc) => 4,
                SignedRoundingMode::HalfCeil => 5,
                SignedRoundingMode::HalfFloor => 6,
                SignedRoundingMode::Unsigned(UnsignedRoundingMode::HalfTrunc) => 7,
                SignedRoundingMode::Unsigned(UnsignedRoundingMode::HalfEven) => 8,
                _ => 0,
            },
            increment: match self.rounding_increment {
                RoundingIncrement::MultiplesOf1 => 1,
                RoundingIncrement::MultiplesOf2 => 2,
                RoundingIncrement::MultiplesOf5 => 5,
                RoundingIncrement::MultiplesOf25 => 25,
                _ => unreachable!(),
            } * 10i32.pow(self.increment_shift as u32),
            priority: self.priority,
            strip_zero: i32::from(self.strip_zero),
        }
    }

    fn heap_bytes(&self) -> usize {
        core::mem::size_of::<Self>()
            + self.locale.capacity()
            + self.numbering.as_str().len()
            + self.unit.as_ref().map_or(0, |unit| {
                core::mem::size_of::<NumberUnit>()
                    + unit.identifier.capacity()
                    + unit.formatter.heap_bytes()
            })
    }

    fn decimal(&self, text: &[u8]) -> Result<Decimal, i32> {
        let negative = text.first() == Some(&b'-');
        let unsigned = if matches!(text.first(), Some(b'-' | b'+')) {
            &text[1..]
        } else {
            text
        };
        let exp_at = unsigned
            .iter()
            .position(|&c| c == b'e' || c == b'E')
            .unwrap_or(unsigned.len());
        let coefficient = &unsigned[..exp_at];
        let exponent = if exp_at == unsigned.len() {
            0
        } else {
            let token = &unsigned[exp_at + 1..];
            let minus = token.first() == Some(&b'-');
            let digits = if matches!(token.first(), Some(b'-' | b'+')) {
                &token[1..]
            } else {
                token
            };
            let magnitude = digits.iter().fold(0i64, |value, digit| {
                value
                    .saturating_mul(10)
                    .saturating_add((digit - b'0') as i64)
            });
            if minus {
                -magnitude
            } else {
                magnitude
            }
        };
        let integer_digits = coefficient
            .iter()
            .position(|&c| c == b'.')
            .unwrap_or(coefficient.len());
        let first = coefficient.iter().position(|&c| c != b'0' && c != b'.');
        let Some(first) = first else {
            let mut zero = Decimal::from(0);
            if negative {
                zero.set_sign(Sign::Negative);
            }
            return Ok(zero);
        };
        let leading_digits = coefficient[..first].iter().filter(|&&c| c != b'.').count();
        let magnitude = (integer_digits as i64)
            .saturating_sub(leading_digits as i64)
            .saturating_sub(1)
            .saturating_add(exponent);
        let boundary = if magnitude == 308 || magnitude == -324 {
            core::str::from_utf8(text)
                .ok()
                .and_then(|value| value.parse::<f64>().ok())
        } else {
            None
        };
        if magnitude > 308 || boundary.is_some_and(|value| value.is_infinite()) {
            return Err(if negative { 5 } else { 4 });
        }
        if magnitude < -324 || boundary.is_some_and(|value| value == 0.0) {
            let mut zero = Decimal::from(0);
            if negative {
                zero.set_sign(Sign::Negative);
            }
            return Ok(zero);
        }
        let magnitude = magnitude + if self.style == 1 { 2 } else { 0 };
        let significant_position = magnitude - i64::from(self.max_significant) + 1;
        let fraction_position = -i64::from(self.max_fraction);
        let position = if self.priority != 0 {
            significant_position.min(fraction_position)
        } else if self.max_significant > 0 {
            significant_position
        } else {
            fraction_position
        };
        // Only standard-notation rounding consumes this representation. Two guard
        // positions and a sticky tail preserve grid equality and every midpoint,
        // even when a long significand is cancelled by its source exponent.
        let cut = magnitude.min(position - 2);
        let horizon = usize::try_from(magnitude - cut + 1).map_err(|_| -1)?;
        if horizon > 414 {
            return Err(-1);
        }
        let mut digits = [0u8; 415];
        let mut length = 0;
        let mut sticky = false;
        for &digit in &coefficient[first..] {
            if digit == b'.' {
                continue;
            }
            if length < horizon {
                digits[length] = digit;
                length += 1;
            } else {
                sticky |= digit != b'0';
            }
        }
        if sticky {
            digits[length] = b'1';
            length += 1;
        }
        let scale = i16::try_from(magnitude - length as i64 + 1).map_err(|_| -1)?;
        let mut decimal = Decimal::try_from_utf8(&digits[..length]).map_err(|_| -1)?;
        decimal.multiply_pow10(scale);
        if negative {
            decimal.set_sign(Sign::Negative);
        }
        Ok(decimal)
    }

    fn fraction(&self, value: &mut Decimal) {
        value.round_with_mode_and_increment(
            -(self.max_fraction as i16) + self.increment_shift,
            self.rounding_mode,
            self.rounding_increment,
        );
        value.absolute.pad_end(-(self.min_fraction as i16));
    }

    fn precision(&self, value: &mut Decimal) {
        value.round_with_mode(
            value.nonzero_magnitude_start() - self.max_significant as i16 + 1,
            self.rounding_mode,
        );
        value.absolute.trim_end();
        value
            .absolute
            .pad_end(value.nonzero_magnitude_start() - self.min_significant as i16 + 1);
    }

    fn round(&self, decimal: &mut Decimal) {
        if self.priority != 0 {
            let mut precision = decimal.clone();
            self.precision(&mut precision);
            self.fraction(decimal);
            let p = precision.nonzero_magnitude_start() - self.max_significant as i16 + 1;
            let f = -(self.max_fraction as i16);
            if (self.priority == 1 && p <= f) || (self.priority == 2 && p > f) {
                *decimal = precision;
            }
        } else if self.max_significant > 0 {
            self.precision(decimal);
        } else {
            self.fraction(decimal);
        }
        decimal.absolute.pad_start(self.min_integer as i16);
        if self.strip_zero && decimal.nonzero_magnitude_end() >= 0 {
            decimal.absolute.trim_end();
        }
        decimal.apply_sign_display(crate::intl::sign_display_from_code(self.sign_display));
    }
}

#[repr(C)]
pub struct MalI18nNumberResolved {
    locale: *const u8,
    locale_len: usize,
    numbering: *const u8,
    numbering_len: usize,
    heap_bytes: usize,
    style: i32,
    unit: *const u8,
    unit_len: usize,
    unit_display: i32,
    min_integer: i32,
    min_fraction: i32,
    max_fraction: i32,
    min_significant: i32,
    max_significant: i32,
    grouping: i32,
    sign_display: i32,
    rounding_mode: i32,
    increment: i32,
    priority: i32,
    strip_zero: i32,
}

#[no_mangle]
pub unsafe extern "C" fn mal_i18n_number_formatter_resolved(
    handle: *mut core::ffi::c_void,
    resolved: *mut MalI18nNumberResolved,
) {
    if let (Some(plan), Some(resolved)) =
        (unsafe { handle.cast::<NumberPlan>().as_ref() }, unsafe {
            resolved.as_mut()
        })
    {
        *resolved = plan.resolved();
    }
}

#[no_mangle]
pub unsafe extern "C" fn mal_i18n_number_formatter_new(
    locale_ptr: *const u8,
    locale_len: usize,
    numbering_ptr: *const u8,
    numbering_len: usize,
    style: i32,
    unit_ptr: *const u8,
    unit_len: usize,
    unit_display: i32,
    min_integer: i32,
    min_fraction: i32,
    max_fraction: i32,
    min_significant: i32,
    max_significant: i32,
    grouping: i32,
    sign_display: i32,
    rounding_mode: i32,
    mut increment: i32,
    priority: i32,
    strip_zero: i32,
    resolved: *mut MalI18nNumberResolved,
) -> *mut core::ffi::c_void {
    let Some(locale) = parse_locale(locale_ptr, locale_len) else {
        return core::ptr::null_mut();
    };
    let mut prefs = icu_decimal::DecimalFormatterPreferences::from(&locale);
    if numbering_len > 0 {
        let bytes = unsafe { crate::ffi::nullable_slice(numbering_ptr, numbering_len) };
        if let Ok(text) = core::str::from_utf8(bytes) {
            let text = text.to_ascii_lowercase();
            if supports_digits(&text) {
                if let Ok(value) = icu_locale::extensions::unicode::Value::try_from_str(&text) {
                    prefs.numbering_system = (&value).try_into().ok();
                }
            }
        }
    }
    let provider = NumberProvider {
        decimal: DecimalProvider::default(),
        symbols: RefCell::new(None),
    };
    let mut options = icu_decimal::options::DecimalFormatterOptions::default();
    use icu_decimal::options::GroupingStrategy;
    options.grouping_strategy = Some(match grouping {
        0 => GroupingStrategy::Never,
        2 => GroupingStrategy::Always,
        3 => GroupingStrategy::Min2,
        _ => GroupingStrategy::Auto,
    });
    let Ok(formatter) = icu_decimal::DecimalFormatter::try_new_unstable(&provider, prefs, options)
    else {
        return core::ptr::null_mut();
    };
    let Some(numbering) = provider.decimal.numbering_system.into_inner() else {
        return core::ptr::null_mut();
    };
    let Some(symbols) = provider.symbols.into_inner() else {
        return core::ptr::null_mut();
    };
    let mut resolved_locale = icu_locale::Locale::from(locale.id.clone());
    if let Some(requested) = locale
        .extensions
        .unicode
        .keywords
        .get(&icu_locale::extensions::unicode::key!("nu"))
    {
        if requested.to_string() == numbering.as_str() {
            resolved_locale.extensions.unicode.keywords.set(
                icu_locale::extensions::unicode::key!("nu"),
                requested.clone(),
            );
        }
    }
    let mode = match rounding_mode {
        1 => SignedRoundingMode::Ceil,
        2 => SignedRoundingMode::Floor,
        3 => SignedRoundingMode::Unsigned(UnsignedRoundingMode::Expand),
        4 => SignedRoundingMode::Unsigned(UnsignedRoundingMode::Trunc),
        5 => SignedRoundingMode::HalfCeil,
        6 => SignedRoundingMode::HalfFloor,
        7 => SignedRoundingMode::Unsigned(UnsignedRoundingMode::HalfTrunc),
        8 => SignedRoundingMode::Unsigned(UnsignedRoundingMode::HalfEven),
        _ => SignedRoundingMode::Unsigned(UnsignedRoundingMode::HalfExpand),
    };
    let mut increment_shift = 0;
    while increment > 1 && increment % 10 == 0 {
        increment /= 10;
        increment_shift += 1;
    }
    let rounding_increment = match increment {
        1 => RoundingIncrement::MultiplesOf1,
        2 => RoundingIncrement::MultiplesOf2,
        5 => RoundingIncrement::MultiplesOf5,
        25 => RoundingIncrement::MultiplesOf25,
        _ => return core::ptr::null_mut(),
    };
    let unit = if style == 3 {
        let bytes = unsafe { crate::ffi::nullable_slice(unit_ptr, unit_len) };
        let Ok(identifier) = core::str::from_utf8(bytes) else {
            return core::ptr::null_mut();
        };
        let Some(spec) = UnitSpec::parse(identifier) else {
            return core::ptr::null_mut();
        };
        if !(0..=2).contains(&unit_display) {
            return core::ptr::null_mut();
        }
        let data_locale = UnitLocale::new(&locale);
        let Ok(plural_locale) = data_locale.locale.parse::<icu_locale::Locale>() else {
            return core::ptr::null_mut();
        };
        let Ok(plurals) = icu_plurals::PluralRules::try_new_cardinal((&plural_locale).into())
        else {
            return core::ptr::null_mut();
        };
        Some(Box::new(NumberUnit {
            identifier: identifier.into(),
            width: unit_display,
            formatter: UnitFormat::new(data_locale, spec, unit_display as usize),
            plurals,
        }))
    } else {
        None
    };
    let plan = Box::new(NumberPlan {
        formatter,
        symbols,
        locale: resolved_locale.to_string(),
        numbering,
        style,
        unit,
        min_integer,
        min_fraction,
        max_fraction,
        min_significant,
        max_significant,
        grouping,
        sign_display,
        rounding_mode: mode,
        rounding_increment,
        increment_shift,
        priority,
        strip_zero: strip_zero != 0,
    });
    if !resolved.is_null() {
        unsafe {
            *resolved = plan.resolved();
        }
    }
    Box::into_raw(plan).cast()
}

use crate::intl_parts::{MalI18nFormattedPart, Sink};

fn radix_decimal(text: &[u8], radix: u32) -> Option<String> {
    let raw = text.get(2..)?;
    let digits = &raw[raw.iter().position(|&c| c != b'0').unwrap_or(raw.len())..];
    if digits.is_empty() {
        return Some("0".into());
    }
    let first = (digits[0] as char).to_digit(radix)?;
    let bits = (32 - first.leading_zeros()) as usize
        + (digits.len() - 1) * radix.trailing_zeros() as usize;
    if bits > 1024 {
        return None;
    }
    let mut limbs = vec![0u32];
    for &byte in digits {
        let mut carry = (byte as char).to_digit(radix)?;
        for limb in &mut limbs {
            let value = *limb as u64 * radix as u64 + carry as u64;
            *limb = (value % 1_000_000_000) as u32;
            carry = (value / 1_000_000_000) as u32;
        }
        if carry != 0 {
            limbs.push(carry);
        }
    }
    use fmt::Write;
    let mut result = limbs.pop()?.to_string();
    for limb in limbs.iter().rev() {
        let _ = write!(result, "{limb:09}");
    }
    Some(result)
}

#[no_mangle]
pub unsafe extern "C" fn mal_i18n_number_formatter_format(
    handle: *mut core::ffi::c_void,
    text: *const u8,
    length: usize,
    mut kind: i32,
    radix: u32,
    out: *mut u16,
    out_cap: usize,
    spans: *mut MalI18nFormattedPart,
    spans_cap: usize,
    spans_needed: *mut usize,
) -> i32 {
    if (out_cap != 0 && out.is_null())
        || (spans_cap != 0 && spans.is_null())
        || (kind == 1 && !matches!(radix, 2 | 8 | 16))
    {
        return -1;
    }
    let Some(plan) = (unsafe { handle.cast::<NumberPlan>().as_ref() }) else {
        return -1;
    };
    let mut token = unsafe { crate::ffi::nullable_slice(text, length) };
    let converted;
    if kind == 1 {
        match radix_decimal(token, radix) {
            Some(decimal) => {
                converted = decimal;
                token = converted.as_bytes();
                kind = 0;
            }
            None => {
                kind = 4;
            }
        }
    }
    let mut sink = Sink {
        out: if out_cap == 0 {
            &mut []
        } else {
            unsafe { core::slice::from_raw_parts_mut(out, out_cap) }
        },
        spans: if spans_cap == 0 {
            &mut []
        } else {
            unsafe { core::slice::from_raw_parts_mut(spans, spans_cap) }
        },
        track: !spans_needed.is_null(),
        written: 0,
        start: 0,
        count: 0,
        kind: 0,
        unit: -1,
    };
    let mut decimal = if kind < 3 {
        match plan.decimal(if kind == 2 { b"-0" } else { token }) {
            Ok(decimal) => Some(decimal),
            Err(special) if special >= 3 => {
                kind = special;
                None
            }
            Err(_) => return -1,
        }
    } else {
        None
    };
    if let Some(decimal) = &mut decimal {
        plan.round(decimal);
    }
    let numeric = |sink: &mut Sink<'_>| {
        if kind >= 3 {
            let mut value = Decimal::from(if kind == 5 { -1 } else { 1 });
            if kind == 3 {
                value = Decimal::from(0);
            }
            value.apply_sign_display(crate::intl::sign_display_from_code(plan.sign_display));
            let (prefix, suffix, sign_kind) = match value.sign {
                Sign::Negative => (
                    plan.symbols.get().strings.minus_sign_prefix(),
                    plan.symbols.get().strings.minus_sign_suffix(),
                    5,
                ),
                Sign::Positive => (
                    plan.symbols.get().strings.plus_sign_prefix(),
                    plan.symbols.get().strings.plus_sign_suffix(),
                    6,
                ),
                _ => ("", "", 0),
            };
            use fmt::Write;
            sink.tagged(sign_kind, |s| s.write_str(prefix))
                .and_then(|_| {
                    sink.tagged(if kind == 3 { 7 } else { 8 }, |s| {
                        s.write_str(if kind == 3 { "NaN" } else { "∞" })
                    })
                })
                .and_then(|_| sink.tagged(sign_kind, |s| s.write_str(suffix)))
        } else {
            plan.formatter
                .format(decimal.as_ref().unwrap())
                .write_to_parts(sink)
        }
    };
    let result = if let Some(unit) = &plan.unit {
        let category = decimal
            .as_ref()
            .map_or(icu_plurals::PluralCategory::Other, |decimal| {
                unit.plurals.category_for(decimal)
            });
        let parts = sink.track;
        unit.formatter.write(category, &mut sink, parts, numeric)
    } else {
        numeric(&mut sink)
    };

    if result.is_err() {
        return -1;
    }
    if plan.style == 1 {
        use fmt::Write;
        if sink.tagged(9, |s| s.write_str("%")).is_err() {
            return -1;
        }
    }
    sink.flush();
    if !spans_needed.is_null() {
        unsafe {
            *spans_needed = sink.count;
        }
    }
    sink.written as i32
}

#[no_mangle]
pub unsafe extern "C" fn mal_i18n_number_formatter_free(handle: *mut core::ffi::c_void) -> usize {
    if handle.is_null() {
        return 0;
    }
    let plan = unsafe { Box::from_raw(handle.cast::<NumberPlan>()) };
    let bytes = plan.heap_bytes();
    drop(plan);
    bytes
}
