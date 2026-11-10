use core::fmt;
use icu_decimal::input::Decimal;
use icu_experimental::relativetime::{provider::*, RelativeTimeFormatterPreferences};
use icu_provider::marker::ErasedMarker;
use icu_provider::prelude::*;
use std::cell::RefCell;
use writeable::Writeable;

use crate::intl::parse_locale;

type Patterns = DataPayload<ErasedMarker<RelativeTimePatternData<'static>>>;

struct DecimalProvider {
    numbering_system: RefCell<Option<Box<DataMarkerAttributes>>>,
}

impl<M: DataMarker> DataProvider<M> for DecimalProvider
where
    icu_decimal::provider::Baked: DataProvider<M>,
{
    fn load(&self, req: DataRequest) -> Result<DataResponse<M>, DataError> {
        let result = icu_decimal::provider::Baked.load(req)?;
        if std::any::TypeId::of::<M>()
            == std::any::TypeId::of::<icu_decimal::provider::DecimalDigitsV1>()
        {
            *self.numbering_system.borrow_mut() = Some(req.id.marker_attributes.to_owned());
        }
        Ok(result)
    }
}

struct RelativeTimePlan {
    prefs: RelativeTimeFormatterPreferences,
    decimal: icu_decimal::DecimalFormatter,
    plurals: icu_plurals::PluralRules,
    units: [Option<Patterns>; 8],
    length: i32,
    auto: bool,
    locale: String,
    numbering_system: Box<DataMarkerAttributes>,
}

impl RelativeTimePlan {
    fn heap_bytes(&self) -> usize {
        // Compiled unit/decimal/plural payloads borrow static provider data.
        core::mem::size_of::<Self>() + self.locale.capacity() + self.numbering_system.as_str().len()
    }

    fn patterns(&mut self, unit: usize) -> Result<&Patterns, DataError> {
        if self.units[unit].is_none() {
            macro_rules! load {
                ($marker:ty) => {{
                    let locale = <$marker>::make_locale(self.prefs.locale_preferences);
                    let response: DataResponse<$marker> =
                        icu_experimental::provider::Baked.load(DataRequest {
                            id: DataIdentifierBorrowed::for_locale(&locale),
                            ..Default::default()
                        })?;
                    response.payload.cast()
                }};
            }
            self.units[unit] = Some(match (self.length, unit) {
                (0, 0) => load!(DatetimeRelativeSecondLongV1),
                (0, 1) => load!(DatetimeRelativeMinuteLongV1),
                (0, 2) => load!(DatetimeRelativeHourLongV1),
                (0, 3) => load!(DatetimeRelativeDayLongV1),
                (0, 4) => load!(DatetimeRelativeWeekLongV1),
                (0, 5) => load!(DatetimeRelativeMonthLongV1),
                (0, 6) => load!(DatetimeRelativeQuarterLongV1),
                (0, 7) => load!(DatetimeRelativeYearLongV1),
                (1, 0) => load!(DatetimeRelativeSecondShortV1),
                (1, 1) => load!(DatetimeRelativeMinuteShortV1),
                (1, 2) => load!(DatetimeRelativeHourShortV1),
                (1, 3) => load!(DatetimeRelativeDayShortV1),
                (1, 4) => load!(DatetimeRelativeWeekShortV1),
                (1, 5) => load!(DatetimeRelativeMonthShortV1),
                (1, 6) => load!(DatetimeRelativeQuarterShortV1),
                (1, 7) => load!(DatetimeRelativeYearShortV1),
                (2, 0) => load!(DatetimeRelativeSecondNarrowV1),
                (2, 1) => load!(DatetimeRelativeMinuteNarrowV1),
                (2, 2) => load!(DatetimeRelativeHourNarrowV1),
                (2, 3) => load!(DatetimeRelativeDayNarrowV1),
                (2, 4) => load!(DatetimeRelativeWeekNarrowV1),
                (2, 5) => load!(DatetimeRelativeMonthNarrowV1),
                (2, 6) => load!(DatetimeRelativeQuarterNarrowV1),
                (2, 7) => load!(DatetimeRelativeYearNarrowV1),
                _ => unreachable!(),
            });
        }
        Ok(self.units[unit].as_ref().unwrap())
    }
}

#[repr(C)]
pub struct MalI18nRelativeResolved {
    pub locale: *const u8,
    pub locale_len: usize,
    pub numbering_system: *const u8,
    pub numbering_len: usize,
    pub heap_bytes: usize,
    pub locale_matches_input: u8,
}

#[no_mangle]
pub unsafe extern "C" fn mal_i18n_relative_time_new(
    locale_ptr: *const u8,
    locale_len: usize,
    numbering_ptr: *const u8,
    numbering_len: usize,
    length: i32,
    numeric_auto: i32,
    resolved_out: *mut MalI18nRelativeResolved,
) -> *mut core::ffi::c_void {
    let Some(locale) = parse_locale(locale_ptr, locale_len) else {
        return core::ptr::null_mut();
    };
    if !(0..=2).contains(&length) {
        return core::ptr::null_mut();
    }
    let mut prefs = RelativeTimeFormatterPreferences::from(&locale);
    let explicit = if numbering_len == 0 {
        None
    } else {
        let bytes = unsafe { crate::ffi::nullable_slice(numbering_ptr, numbering_len) };
        core::str::from_utf8(bytes).ok().and_then(|text| {
            let keyword = icu_locale::extensions::unicode::Value::try_from_str(text).ok()?;
            let system =
                icu_experimental::relativetime::preferences::NumberingSystem::try_from(&keyword)
                    .ok()?;
            let request = DataRequest {
                id: DataIdentifierBorrowed::for_marker_attributes(
                    DataMarkerAttributes::from_str_or_panic(text),
                ),
                ..Default::default()
            };
            let response: Result<DataResponse<icu_decimal::provider::DecimalDigitsV1>, _> =
                icu_decimal::provider::Baked.load(request);
            response.ok().map(|_| system)
        })
    };
    if let Some(system) = explicit {
        prefs.numbering_system = Some(system);
    }
    let provider = DecimalProvider {
        numbering_system: RefCell::new(None),
    };
    let Ok(decimal) = icu_decimal::DecimalFormatter::try_new_unstable(
        &provider,
        (&prefs).into(),
        Default::default(),
    ) else {
        return core::ptr::null_mut();
    };
    let Ok(plurals) = icu_plurals::PluralRules::try_new_cardinal((&prefs).into()) else {
        return core::ptr::null_mut();
    };
    let Some(numbering_system) = provider.numbering_system.into_inner() else {
        return core::ptr::null_mut();
    };
    let mut resolved = icu_locale::Locale::from(locale.id.clone());
    if let Some(requested) = locale
        .extensions
        .unicode
        .keywords
        .get(&icu_locale::extensions::unicode::key!("nu"))
    {
        if requested.to_string() == numbering_system.as_str() {
            resolved.extensions.unicode.keywords.set(
                icu_locale::extensions::unicode::key!("nu"),
                requested.clone(),
            );
        }
    }
    let plan = Box::new(RelativeTimePlan {
        prefs,
        decimal,
        plurals,
        units: core::array::from_fn(|_| None),
        length,
        auto: numeric_auto != 0,
        locale: resolved.to_string(),
        numbering_system,
    });
    if !resolved_out.is_null() {
        unsafe {
            *resolved_out = MalI18nRelativeResolved {
                locale: plan.locale.as_ptr(),
                locale_len: plan.locale.len(),
                numbering_system: plan.numbering_system.as_str().as_ptr(),
                numbering_len: plan.numbering_system.as_str().len(),
                heap_bytes: plan.heap_bytes(),
                locale_matches_input: u8::from(
                    plan.locale.as_bytes() == crate::ffi::nullable_slice(locale_ptr, locale_len),
                ),
            };
        }
    }
    Box::into_raw(plan).cast()
}

#[no_mangle]
pub unsafe extern "C" fn mal_i18n_relative_time_free(handle: *mut core::ffi::c_void) -> usize {
    if handle.is_null() {
        return 0;
    }
    let plan = unsafe { Box::from_raw(handle.cast::<RelativeTimePlan>()) };
    let bytes = plan.heap_bytes();
    drop(plan);
    bytes
}

#[repr(C)]
pub struct MalI18nRelativePart {
    pub start: usize,
    pub len: usize,
    pub kind: i32,
}

struct PartsSink<'a> {
    out: &'a mut [u16],
    spans: &'a mut [MalI18nRelativePart],
    track_parts: bool,
    written: usize,
    start: usize,
    count: usize,
    kind: i32,
}

impl PartsSink<'_> {
    fn flush(&mut self) {
        if self.track_parts && self.written > self.start {
            if let Some(span) = self.spans.get_mut(self.count) {
                *span = MalI18nRelativePart {
                    start: self.start,
                    len: self.written - self.start,
                    kind: self.kind,
                };
            }
            self.count += 1;
        }
        self.start = self.written;
    }
}

impl fmt::Write for PartsSink<'_> {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        for unit in value.encode_utf16() {
            if self.written >= i32::MAX as usize {
                return Err(fmt::Error);
            }
            if let Some(slot) = self.out.get_mut(self.written) {
                *slot = unit;
            }
            self.written += 1;
        }
        Ok(())
    }
}

impl writeable::PartsWrite for PartsSink<'_> {
    type SubPartsWrite = Self;

    fn with_part(
        &mut self,
        part: writeable::Part,
        mut f: impl FnMut(&mut Self) -> fmt::Result,
    ) -> fmt::Result {
        if !self.track_parts {
            return f(self);
        }
        let kind = if part == icu_decimal::parts::INTEGER {
            1
        } else if part == icu_decimal::parts::GROUP {
            2
        } else if part == icu_decimal::parts::DECIMAL {
            3
        } else if part == icu_decimal::parts::FRACTION {
            4
        } else {
            return f(self);
        };
        if kind == self.kind {
            return f(self);
        }
        self.flush();
        let previous = self.kind;
        self.kind = kind;
        f(self)?;
        self.flush();
        self.kind = previous;
        Ok(())
    }
}

// RelativeTimeFormat receives the exact binary Number, whereas the public
// NumberFormat API first converts through Number::toString. Quantizing the
// significand avoids shortest-decimal ties and floating-point double rounding.
fn relative_decimal(value: f64) -> Option<Decimal> {
    let bits = value.to_bits();
    let raw_exponent = ((bits >> 52) & 0x7ff) as i32;
    let mantissa = (bits & ((1_u64 << 52) - 1)) | if raw_exponent == 0 { 0 } else { 1_u64 << 52 };
    let exponent = if raw_exponent == 0 {
        -1074
    } else {
        raw_exponent - 1075
    };
    let mut decimal = if exponent < 0 {
        let numerator = mantissa * 125;
        let shift = exponent + 3;
        let thousandths = if shift >= 0 {
            numerator << shift
        } else {
            let places = -shift;
            if places >= 64 {
                0
            } else {
                let remainder = numerator & ((1_u64 << places) - 1);
                (numerator >> places) + u64::from(remainder >= (1_u64 << (places - 1)))
            }
        };
        let mut decimal = Decimal::from(thousandths);
        decimal.multiply_pow10(-3);
        decimal
    } else if exponent <= 75 {
        Decimal::from((mantissa as u128) << exponent)
    } else {
        // These values are integral. Explicit fixed precision preserves their
        // exact integer, with at most 309 digits for finite binary64 input.
        Decimal::try_from_str(&format!("{value:.0}")).ok()?
    };
    decimal.trim_end();
    Some(decimal)
}

#[no_mangle]
pub unsafe extern "C" fn mal_i18n_relative_time_format(
    handle: *mut core::ffi::c_void,
    value: f64,
    unit: i32,
    out: *mut u16,
    out_cap: usize,
    spans: *mut MalI18nRelativePart,
    spans_cap: usize,
    spans_needed: *mut usize,
) -> i32 {
    use core::fmt::Write;
    if handle.is_null()
        || !value.is_finite()
        || !(0..8).contains(&unit)
        || (out_cap != 0 && out.is_null())
        || (spans_cap != 0 && spans.is_null())
    {
        return -1;
    }
    let plan = unsafe { &mut *handle.cast::<RelativeTimePlan>() };
    if plan.patterns(unit as usize).is_err() {
        return -1;
    }
    let data = plan.units[unit as usize].as_ref().unwrap().get();
    let out = if out_cap == 0 {
        &mut []
    } else {
        unsafe { core::slice::from_raw_parts_mut(out, out_cap) }
    };
    let spans = if spans_cap == 0 {
        &mut []
    } else {
        unsafe { core::slice::from_raw_parts_mut(spans, spans_cap) }
    };
    let mut sink = PartsSink {
        out,
        spans,
        track_parts: !spans_needed.is_null(),
        written: 0,
        start: 0,
        count: 0,
        kind: 0,
    };

    // Auto lookup uses the unrounded value: 1.0004 formats numerically even
    // though the number formatter rounds it to 1. Both zeros look up "0".
    let literal = if plan.auto && value.fract() == 0.0 && (-128.0..=127.0).contains(&value) {
        data.get_relative(value as i8)
    } else {
        None
    };
    let result = if let Some(literal) = literal {
        sink.write_str(literal)
    } else {
        let Some(decimal) = relative_decimal(value.abs()) else {
            return -1;
        };
        let pattern = if value.is_sign_negative() {
            &data.past
        } else {
            &data.future
        };
        let result = pattern
            .get((&decimal).into(), &plan.plurals)
            .interpolate((plan.decimal.format(&decimal),))
            .write_to_parts(&mut sink);
        result
    };
    if result.is_err() {
        return -1;
    }
    sink.flush();
    if !spans_needed.is_null() {
        unsafe {
            *spans_needed = sink.count;
        }
    }
    sink.written as i32
}
