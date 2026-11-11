use crate::intl_decimal::DecimalProvider;
use icu_decimal::provider::{DecimalDigitsV1, DecimalSymbolsV1};
use icu_provider::prelude::*;

#[derive(Default)]
pub(super) struct DateProvider {
    pub(super) decimal: DecimalProvider,
}

icu_provider::marker::impl_data_provider_never_marker!(DateProvider);

// Explicit markers preserve ICU selection while the decimal provider replaces digit data.
macro_rules! delegate {
    ($provider:path; $($marker:path),* $(,)?) => {
        $(impl DataProvider<$marker> for DateProvider {
            fn load(&self, request: DataRequest) -> Result<DataResponse<$marker>, DataError> {
                $provider.load(request)
            }
        })*
    };
}

delegate!(icu_datetime::provider::Baked;
    icu_datetime::provider::names::DatetimeNamesYearBuddhistV1,
    icu_datetime::provider::names::DatetimeNamesYearChineseV1,
    icu_datetime::provider::names::DatetimeNamesYearCopticV1,
    icu_datetime::provider::names::DatetimeNamesYearDangiV1,
    icu_datetime::provider::names::DatetimeNamesYearEthiopianV1,
    icu_datetime::provider::names::DatetimeNamesYearGregorianV1,
    icu_datetime::provider::names::DatetimeNamesYearHebrewV1,
    icu_datetime::provider::names::DatetimeNamesYearIndianV1,
    icu_datetime::provider::names::DatetimeNamesYearHijriV1,
    icu_datetime::provider::names::DatetimeNamesYearJapaneseV1,
    icu_datetime::provider::names::DatetimeNamesYearPersianV1,
    icu_datetime::provider::names::DatetimeNamesYearRocV1,
    icu_datetime::provider::names::DatetimeNamesMonthBuddhistV1,
    icu_datetime::provider::names::DatetimeNamesMonthChineseV1,
    icu_datetime::provider::names::DatetimeNamesMonthCopticV1,
    icu_datetime::provider::names::DatetimeNamesMonthDangiV1,
    icu_datetime::provider::names::DatetimeNamesMonthEthiopianV1,
    icu_datetime::provider::names::DatetimeNamesMonthGregorianV1,
    icu_datetime::provider::names::DatetimeNamesMonthHebrewV1,
    icu_datetime::provider::names::DatetimeNamesMonthIndianV1,
    icu_datetime::provider::names::DatetimeNamesMonthHijriV1,
    icu_datetime::provider::names::DatetimeNamesMonthJapaneseV1,
    icu_datetime::provider::names::DatetimeNamesMonthPersianV1,
    icu_datetime::provider::names::DatetimeNamesMonthRocV1,
    icu_datetime::provider::names::DatetimeNamesDayperiodV1,
    icu_datetime::provider::semantic_skeletons::DatetimePatternsDateBuddhistV1,
    icu_datetime::provider::semantic_skeletons::DatetimePatternsDateChineseV1,
    icu_datetime::provider::semantic_skeletons::DatetimePatternsDateCopticV1,
    icu_datetime::provider::semantic_skeletons::DatetimePatternsDateDangiV1,
    icu_datetime::provider::semantic_skeletons::DatetimePatternsDateEthiopianV1,
    icu_datetime::provider::semantic_skeletons::DatetimePatternsDateGregorianV1,
    icu_datetime::provider::semantic_skeletons::DatetimePatternsDateHebrewV1,
    icu_datetime::provider::semantic_skeletons::DatetimePatternsDateIndianV1,
    icu_datetime::provider::semantic_skeletons::DatetimePatternsDateHijriV1,
    icu_datetime::provider::semantic_skeletons::DatetimePatternsDateJapaneseV1,
    icu_datetime::provider::semantic_skeletons::DatetimePatternsDatePersianV1,
    icu_datetime::provider::semantic_skeletons::DatetimePatternsDateRocV1,
    icu_datetime::provider::semantic_skeletons::DatetimePatternsGlueV1,
    icu_datetime::provider::semantic_skeletons::DatetimePatternsTimeV1,
);
delegate!(icu_calendar::provider::Baked;
    icu_calendar::provider::CalendarPreferredV1,
    icu_calendar::provider::CalendarJapaneseModernV1,
);

impl DataProvider<DecimalSymbolsV1> for DateProvider {
    fn load(&self, request: DataRequest) -> Result<DataResponse<DecimalSymbolsV1>, DataError> {
        self.decimal.load(request)
    }
}
impl DataProvider<DecimalDigitsV1> for DateProvider {
    fn load(&self, request: DataRequest) -> Result<DataResponse<DecimalDigitsV1>, DataError> {
        self.decimal.load(request)
    }
}

#[repr(C)]
pub struct MalI18nDateTimeResolved {
    pub(super) calendar: *const u8,
    pub(super) calendar_len: usize,
    pub(super) numbering: [u8; 8],
    pub(super) numbering_len: usize,
    pub(super) heap_bytes: usize,
}

pub(super) struct DateWriter<'a> {
    pub(super) output: crate::intl_parts::Sink<'a>,
    pub(super) related_year: Option<(
        &'a icu_decimal::DecimalFormatter,
        &'a fixed_decimal::Decimal,
    )>,
}

impl core::fmt::Write for DateWriter<'_> {
    fn write_str(&mut self, text: &str) -> core::fmt::Result {
        self.output.write_str(text)
    }
    fn write_char(&mut self, value: char) -> core::fmt::Result {
        self.output.write_char(value)
    }
}

impl writeable::PartsWrite for DateWriter<'_> {
    type SubPartsWrite = Self;
    fn with_part(
        &mut self,
        part: writeable::Part,
        mut write: impl FnMut(&mut Self) -> core::fmt::Result,
    ) -> core::fmt::Result {
        use writeable::Writeable;
        if part == icu_datetime::parts::RELATED_YEAR {
            if let Some((formatter, year)) = self.related_year {
                // ICU uses UTS35 Latin related-year digits; ECMA-402 uses the selected numbering system.
                return self
                    .output
                    .tagged(13, |sink| formatter.format(year).write_to(sink));
            }
        }
        if !self.output.track || self.output.kind == 22 || part.category != "datetime" {
            return write(self);
        }
        let kind = match part.value {
            "era" => 11,
            "year" => 12,
            "relatedYear" => 13,
            "yearName" => 14,
            "month" => 15,
            "day" => 16,
            "weekday" => 17,
            "dayPeriod" => 18,
            "hour" => 19,
            "minute" => 20,
            "second" => 21,
            "timeZoneName" => 22,
            _ => 23,
        };
        if kind == self.output.kind {
            return write(self);
        }
        self.output.flush();
        let previous = self.output.kind;
        self.output.kind = kind;
        write(self)?;
        self.output.flush();
        self.output.kind = previous;
        Ok(())
    }
}

pub(super) struct DateTextWriter<'a, W> {
    pub(super) output: W,
    pub(super) related_year: Option<(
        &'a icu_decimal::DecimalFormatter,
        &'a fixed_decimal::Decimal,
    )>,
}
impl<W: core::fmt::Write> core::fmt::Write for DateTextWriter<'_, W> {
    fn write_str(&mut self, text: &str) -> core::fmt::Result {
        self.output.write_str(text)
    }
    fn write_char(&mut self, value: char) -> core::fmt::Result {
        self.output.write_char(value)
    }
}
impl<W: core::fmt::Write> writeable::PartsWrite for DateTextWriter<'_, W> {
    type SubPartsWrite = Self;
    fn with_part(
        &mut self,
        part: writeable::Part,
        mut write: impl FnMut(&mut Self) -> core::fmt::Result,
    ) -> core::fmt::Result {
        use writeable::Writeable;
        if part == icu_datetime::parts::RELATED_YEAR {
            if let Some((formatter, year)) = self.related_year {
                return formatter.format(year).write_to(&mut self.output);
            }
        }
        write(self)
    }
}
