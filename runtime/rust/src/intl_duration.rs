use crate::intl_decimal::{supports_digits, DecimalProvider};
use core::fmt;
use icu_decimal::input::Decimal;
use icu_experimental::duration::{provider::*, DurationFormatterPreferences};
use icu_provider::prelude::*;
use writeable::Writeable;

use crate::intl::parse_locale;
use crate::intl_parts::{duration_unit, MalI18nNumericPart, Sink, DURATION_UNITS};
use crate::intl_unit::{UnitFormat, UnitLocale, UnitSpec};

struct DurationPlan {
    decimal: icu_decimal::DecimalFormatter,
    digital_decimal: icu_decimal::DecimalFormatter,
    plurals: icu_plurals::PluralRules,
    list: icu_list::ListFormatter,
    digital: DataPayload<UnitsDurationDigitalV1>,
    unit_locale: UnitLocale,
    patterns: [Option<UnitFormat>; 10],
    styles: [u8; 10],
    displays: [u8; 10],
    fractional_digits: i32,
    locale: String,
    numbering: Box<DataMarkerAttributes>,
}

impl DurationPlan {
    fn heap_bytes(&self) -> usize {
        // Lazy unit preparation borrows generated data and adds no owned allocations.
        core::mem::size_of::<Self>() + self.locale.capacity() + self.numbering.as_str().len()
    }

    fn load_pattern(&mut self, unit: usize) {
        if self.patterns[unit].is_none() {
            let spec = UnitSpec::parse(DURATION_UNITS[unit]).unwrap();
            self.patterns[unit] = Some(UnitFormat::new(
                self.unit_locale,
                spec,
                self.styles[unit] as usize,
            ));
        }
    }

    fn fraction(&self, units: &[u128; 10], unit: usize) -> Decimal {
        let mut value = units[unit];
        let mut scale = 0;
        for lower in unit + 1..10 {
            if self.styles[lower] != 5 {
                break;
            }
            value = value * 1000 + units[lower];
            scale += 3;
        }
        let mut decimal = Decimal::from(value);
        decimal.multiply_pow10(-scale);
        if scale > 0 {
            if self.fractional_digits >= 0 {
                decimal.trunc(-(self.fractional_digits as i16));
                decimal.absolute.pad_end(-(self.fractional_digits as i16));
            } else {
                decimal.absolute.trim_end();
            }
        }
        decimal
    }

    fn render(&mut self, units: &[u128; 10], negative: bool, sink: &mut Sink<'_>) -> fmt::Result {
        let mut fields: Vec<(usize, Decimal, bool)> = Vec::with_capacity(10);
        let mut sign_pending = negative;
        let first_numeric = (0..10).find(|&unit| self.styles[unit] == 3 || self.styles[unit] == 4);
        for unit in 0..first_numeric.unwrap_or(10) {
            if self.styles[unit] == 5 {
                break;
            }
            let mut value = if unit >= 6 {
                self.fraction(units, unit)
            } else {
                Decimal::from(units[unit])
            };
            // Visibility uses the mathematical value before fractional truncation.
            let combined_nonzero = units[unit] != 0
                || (unit >= 6
                    && (unit + 1..10)
                        .take_while(|&lower| self.styles[lower] == 5)
                        .any(|lower| units[lower] != 0));
            if combined_nonzero || self.displays[unit] != 0 {
                self.load_pattern(unit);
                if sign_pending {
                    value.set_sign(fixed_decimal::Sign::Negative);
                    sign_pending = false;
                }
                fields.push((unit, value, false));
            }
            if unit < 9 && self.styles[unit + 1] == 5 {
                break;
            }
        }
        if let Some(first) = first_numeric {
            let seconds_nonzero = units[6..].iter().any(|&n| n != 0);
            let hours = first == 4 && (units[4] != 0 || self.displays[4] != 0);
            let seconds = seconds_nonzero || self.displays[6] != 0;
            let minutes =
                first <= 5 && (units[5] != 0 || self.displays[5] != 0 || (hours && seconds));
            for (unit, shown) in [(4, hours), (5, minutes), (6, seconds)] {
                if !shown {
                    continue;
                }
                let mut value = if unit == 6 {
                    self.fraction(units, unit)
                } else {
                    Decimal::from(units[unit])
                };
                let digits: i16 = if self.styles[unit] == 4 { 2 } else { 1 };
                value.absolute.pad_start(digits.into());
                if sign_pending {
                    value.set_sign(fixed_decimal::Sign::Negative);
                    sign_pending = false;
                }
                fields.push((unit, value, true));
            }
        }
        let mut values: Vec<DurationField<'_>> = Vec::with_capacity(fields.len());
        let digital_start = fields
            .iter()
            .position(|field| field.2)
            .unwrap_or(fields.len());
        for (unit, value, _) in &fields[..digital_start] {
            values.push(DurationField::Text {
                plan: self,
                unit: *unit,
                value,
            });
        }
        if digital_start < fields.len() {
            values.push(DurationField::Digital {
                plan: self,
                fields: &fields[digital_start..],
            });
        }
        self.list.format(values.iter()).write_to_parts(sink)
    }
}

enum DurationField<'a> {
    Text {
        plan: &'a DurationPlan,
        unit: usize,
        value: &'a Decimal,
    },
    Digital {
        plan: &'a DurationPlan,
        fields: &'a [(usize, Decimal, bool)],
    },
}

impl Writeable for DurationField<'_> {
    fn write_to_parts<W: writeable::PartsWrite + ?Sized>(&self, sink: &mut W) -> fmt::Result {
        match self {
            Self::Text { plan, unit, value } => sink.with_part(duration_unit(*unit), |sink| {
                plan.patterns[*unit].as_ref().unwrap().write(
                    plan.plurals.category_for(*value),
                    sink,
                    |sink| plan.decimal.format(value).write_to_parts(sink),
                )
            }),
            Self::Digital { plan, fields } => {
                for (index, (unit, value, _)) in fields.iter().enumerate() {
                    if index > 0 {
                        sink.write_str(&plan.digital.get().separator)?;
                    }
                    sink.with_part(duration_unit(*unit), |sink| {
                        plan.digital_decimal.format(value).write_to_parts(sink)
                    })?;
                }
                Ok(())
            }
        }
    }
}

#[repr(C)]
pub struct MalI18nDurationResolved {
    pub locale: *const u8,
    pub locale_len: usize,
    pub numbering: *const u8,
    pub numbering_len: usize,
    pub heap_bytes: usize,
    pub two_digit_hours: u8,
}

#[no_mangle]
pub unsafe extern "C" fn mal_i18n_duration_new(
    locale_ptr: *const u8,
    locale_len: usize,
    numbering_ptr: *const u8,
    numbering_len: usize,
    base_style: i32,
    fractional_digits: i32,
    styles: *const u8,
    displays: *const u8,
    resolved: *mut MalI18nDurationResolved,
) -> *mut core::ffi::c_void {
    let Some(locale) = parse_locale(locale_ptr, locale_len) else {
        return core::ptr::null_mut();
    };
    let mut prefs = DurationFormatterPreferences::from(&locale);
    if numbering_len > 0 {
        let text = unsafe { crate::ffi::nullable_slice(numbering_ptr, numbering_len) };
        if let Ok(text) = core::str::from_utf8(text) {
            let canonical = text.to_ascii_lowercase();
            let text = canonical.as_str();
            if supports_digits(text) {
                if let Ok(keyword) = icu_locale::extensions::unicode::Value::try_from_str(text) {
                    prefs.numbering_system = (&keyword).try_into().ok();
                }
            }
        }
    }
    let provider = DecimalProvider::default();
    let Ok(decimal) = icu_decimal::DecimalFormatter::try_new_unstable(
        &provider,
        (&prefs).into(),
        Default::default(),
    ) else {
        return core::ptr::null_mut();
    };
    let Some(numbering) = provider.numbering_system.into_inner() else {
        return core::ptr::null_mut();
    };
    let mut digital_options = icu_decimal::options::DecimalFormatterOptions::default();
    digital_options.grouping_strategy = Some(icu_decimal::options::GroupingStrategy::Never);
    let Ok(digital_decimal) = icu_decimal::DecimalFormatter::try_new_unstable(
        &DecimalProvider::default(),
        (&prefs).into(),
        digital_options,
    ) else {
        return core::ptr::null_mut();
    };
    let unit_locale = UnitLocale::new(&locale);
    let Ok(plural_locale) = unit_locale.locale.parse::<icu_locale::Locale>() else {
        return core::ptr::null_mut();
    };
    let Ok(plurals) = icu_plurals::PluralRules::try_new_cardinal((&plural_locale).into()) else {
        return core::ptr::null_mut();
    };
    let list_length = match base_style {
        0 => icu_list::options::ListLength::Wide,
        2 => icu_list::options::ListLength::Narrow,
        _ => icu_list::options::ListLength::Short,
    };
    let Ok(list) = icu_list::ListFormatter::try_new_unit(
        (&prefs).into(),
        icu_list::options::ListFormatterOptions::default().with_length(list_length),
    ) else {
        return core::ptr::null_mut();
    };
    let data_locale = UnitsDurationDigitalV1::make_locale(prefs.locale_preferences);
    let data: Result<DataResponse<UnitsDurationDigitalV1>, _> = icu_experimental::provider::Baked
        .load(DataRequest {
            id: DataIdentifierBorrowed::for_locale(&data_locale),
            ..Default::default()
        });
    let Ok(digital) = data else {
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
    let mut styles: [u8; 10] = unsafe { core::slice::from_raw_parts(styles, 10) }
        .try_into()
        .unwrap();
    if styles[4] == 3 && digital.payload.get().hm_padding.h == 2 {
        styles[4] = 4;
    }
    let plan = Box::new(DurationPlan {
        decimal,
        digital_decimal,
        plurals,
        list,
        digital: digital.payload,
        unit_locale,
        patterns: core::array::from_fn(|_| None),
        styles,
        displays: unsafe { core::slice::from_raw_parts(displays, 10) }
            .try_into()
            .unwrap(),
        fractional_digits,
        locale: resolved_locale.to_string(),
        numbering,
    });
    if !resolved.is_null() {
        unsafe {
            *resolved = MalI18nDurationResolved {
                locale: plan.locale.as_ptr(),
                locale_len: plan.locale.len(),
                numbering: plan.numbering.as_str().as_ptr(),
                numbering_len: plan.numbering.as_str().len(),
                heap_bytes: plan.heap_bytes(),
                two_digit_hours: u8::from(plan.digital.get().hm_padding.h == 2),
            };
        }
    }
    Box::into_raw(plan).cast()
}

#[no_mangle]
pub unsafe extern "C" fn mal_i18n_duration_free(handle: *mut core::ffi::c_void) -> usize {
    if handle.is_null() {
        return 0;
    }
    let plan = unsafe { Box::from_raw(handle.cast::<DurationPlan>()) };
    let bytes = plan.heap_bytes();
    drop(plan);
    bytes
}

fn duration_units(values: &[f64]) -> Option<([u128; 10], bool)> {
    let mut units = [0u128; 10];
    let mut sign = 0;
    for (unit, &value) in values.iter().enumerate() {
        if !value.is_finite() || value.fract() != 0.0 {
            return None;
        }
        let current = if value > 0.0 {
            1
        } else if value < 0.0 {
            -1
        } else {
            0
        };
        if current != 0 {
            if sign != 0 && sign != current {
                return None;
            }
            sign = current;
        }
        // Every valid field is below 2^83. Check before the float-to-integer conversion.
        if value.abs() >= 2f64.powi(83) || (unit < 3 && value.abs() >= 4294967296.0) {
            return None;
        }
        units[unit] = value.abs() as u128;
    }
    const SCALES: [u128; 7] = [
        86_400_000_000_000,
        3_600_000_000_000,
        60_000_000_000,
        1_000_000_000,
        1_000_000,
        1_000,
        1,
    ];
    let mut total = 0u128;
    for unit in 3..10 {
        total = total.checked_add(units[unit].checked_mul(SCALES[unit - 3])?)?;
    }
    if total >= (1u128 << 53) * 1_000_000_000 {
        return None;
    }
    Some((units, sign < 0))
}

#[no_mangle]
pub unsafe extern "C" fn mal_i18n_duration_format(
    handle: *mut core::ffi::c_void,
    values: *const f64,
    out: *mut u16,
    out_cap: usize,
    spans: *mut MalI18nNumericPart,
    spans_cap: usize,
    spans_needed: *mut usize,
) -> i32 {
    if (out_cap != 0 && out.is_null()) || (spans_cap != 0 && spans.is_null()) || values.is_null() {
        return -1;
    }
    let Some(plan) = (unsafe { handle.cast::<DurationPlan>().as_mut() }) else {
        return -1;
    };
    let Some((units, negative)) =
        duration_units(unsafe { core::slice::from_raw_parts(values, 10) })
    else {
        return -2;
    };
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
    if plan.render(&units, negative, &mut sink).is_err() {
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

#[no_mangle]
pub unsafe extern "C" fn mal_i18n_duration_parse(
    text: *const u16,
    length: usize,
    out: *mut f64,
) -> i32 {
    let input = unsafe { core::slice::from_raw_parts(text, length) };
    let Ok(input) = String::from_utf16(input) else {
        return -1;
    };
    let Ok(duration) = temporal_rs::Duration::from_utf8(input.as_bytes()) else {
        return -1;
    };
    let fields = [
        duration.years() as f64,
        duration.months() as f64,
        duration.weeks() as f64,
        duration.days() as f64,
        duration.hours() as f64,
        duration.minutes() as f64,
        duration.seconds() as f64,
        duration.milliseconds() as f64,
        duration.microseconds() as f64,
        duration.nanoseconds() as f64,
    ];
    unsafe {
        core::ptr::copy_nonoverlapping(fields.as_ptr(), out, 10);
    }
    0
}
