use core::fmt;
use writeable::PartsWrite;

pub(super) const UNIT_LABEL: writeable::Part = writeable::Part {
    category: "mal-unit",
    value: "label",
};
pub(super) const DURATION_UNITS: [&str; 10] = [
    "year",
    "month",
    "week",
    "day",
    "hour",
    "minute",
    "second",
    "millisecond",
    "microsecond",
    "nanosecond",
];
pub(super) fn duration_unit(unit: usize) -> writeable::Part {
    writeable::Part {
        category: "mal-duration-unit",
        value: DURATION_UNITS[unit],
    }
}

#[repr(C)]
pub struct MalI18nNumericPart {
    pub(super) start: usize,
    pub(super) len: usize,
    pub(super) kind: i32,
    pub(super) unit: i32,
}

pub(super) struct Sink<'a> {
    pub(super) out: &'a mut [u16],
    pub(super) spans: &'a mut [MalI18nNumericPart],
    pub(super) track: bool,
    pub(super) written: usize,
    pub(super) start: usize,
    pub(super) count: usize,
    pub(super) kind: i32,
    pub(super) unit: i32,
}
impl Sink<'_> {
    pub(super) fn flush(&mut self) {
        if self.track && self.written > self.start {
            if let Some(part) = self.spans.get_mut(self.count) {
                *part = MalI18nNumericPart {
                    start: self.start,
                    len: self.written - self.start,
                    kind: self.kind,
                    unit: self.unit,
                };
            }
            self.count += 1;
        }
        self.start = self.written;
    }
    pub(super) fn tagged(
        &mut self,
        kind: i32,
        write: impl FnOnce(&mut Self) -> fmt::Result,
    ) -> fmt::Result {
        if !self.track || kind == self.kind {
            return write(self);
        }
        self.flush();
        let previous = self.kind;
        self.kind = kind;
        write(self)?;
        self.flush();
        self.kind = previous;
        Ok(())
    }
}
impl fmt::Write for Sink<'_> {
    fn write_char(&mut self, ch: char) -> fmt::Result {
        if ch.is_ascii() {
            if self.written >= i32::MAX as usize {
                return Err(fmt::Error);
            }
            if let Some(slot) = self.out.get_mut(self.written) {
                *slot = ch as u16;
            }
            self.written += 1;
            Ok(())
        } else {
            self.write_str(ch.encode_utf8(&mut [0; 4]))
        }
    }

    fn write_str(&mut self, text: &str) -> fmt::Result {
        if text.is_ascii() {
            let end = self
                .written
                .checked_add(text.len())
                .filter(|&end| end <= i32::MAX as usize)
                .ok_or(fmt::Error)?;
            let start = self.written.min(self.out.len());
            let copied_end = end.min(self.out.len());
            for (slot, byte) in self.out[start..copied_end].iter_mut().zip(text.bytes()) {
                *slot = u16::from(byte);
            }
            self.written = end;
            return Ok(());
        }
        let kind = self.kind;
        for ch in text.chars() {
            let bidi = matches!(ch, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}');
            let next = if (kind == 5 || kind == 6) && bidi {
                0
            } else {
                kind
            };
            if self.track && next != self.kind {
                self.flush();
                self.kind = next;
            }
            for unit in ch.encode_utf16(&mut [0; 2]) {
                if self.written >= i32::MAX as usize {
                    return Err(fmt::Error);
                }
                if let Some(slot) = self.out.get_mut(self.written) {
                    *slot = *unit;
                }
                self.written += 1;
            }
        }
        if self.track && self.kind != kind {
            self.flush();
            self.kind = kind;
        }
        Ok(())
    }
}
impl PartsWrite for Sink<'_> {
    type SubPartsWrite = Self;
    fn with_part(
        &mut self,
        part: writeable::Part,
        mut write: impl FnMut(&mut Self) -> fmt::Result,
    ) -> fmt::Result {
        if !self.track {
            return write(self);
        }
        if part.category == "mal-duration-unit" {
            self.flush();
            let previous = self.unit;
            self.unit = DURATION_UNITS
                .iter()
                .position(|&name| name == part.value)
                .map_or(-1, |unit| unit as i32);
            write(self)?;
            self.flush();
            self.unit = previous;
            return Ok(());
        }
        let kind = if part == UNIT_LABEL {
            10
        } else if part == icu_decimal::parts::INTEGER {
            1
        } else if part == icu_decimal::parts::GROUP {
            2
        } else if part == icu_decimal::parts::DECIMAL {
            3
        } else if part == icu_decimal::parts::FRACTION {
            4
        } else if part == icu_decimal::parts::MINUS_SIGN {
            5
        } else if part == icu_decimal::parts::PLUS_SIGN {
            6
        } else {
            return write(self);
        };
        self.tagged(kind, |sink| write(sink))
    }
}
