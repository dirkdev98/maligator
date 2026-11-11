use crate::intl_parts::UNIT_LABEL;
use core::fmt::{self, Write};
use icu_locale::Locale;
use icu_plurals::PluralCategory;
use writeable::PartsWrite;

#[path = "intl_unit_data.rs"]
mod data;

#[derive(Clone, Copy)]
pub(super) struct UnitSpec {
    numerator: u8,
    denominator: Option<u8>,
}
impl UnitSpec {
    pub(super) fn parse(identifier: &str) -> Option<Self> {
        let (numerator, denominator) = identifier
            .split_once("-per-")
            .map_or((identifier, None), |(a, b)| (a, Some(b)));
        Some(Self {
            numerator: data::SIMPLE.binary_search(&numerator).ok()? as u8,
            denominator: match denominator {
                Some(name) => Some(data::SIMPLE.binary_search(&name).ok()? as u8),
                None => None,
            },
        })
    }
}

#[derive(Clone, Copy)]
pub(super) struct UnitLocale {
    pub(super) locale: &'static str,
    tables: [u16; 3],
}
impl UnitLocale {
    pub(super) fn new(locale: &Locale) -> Self {
        let mut candidate = locale.id.to_string();
        loop {
            if let Ok(index) =
                data::LOCALES.binary_search_by_key(&candidate.as_str(), |(name, _)| name)
            {
                let (locale, tables) = data::LOCALES[index];
                return Self { locale, tables };
            }
            if let Ok(index) =
                data::PARENTS.binary_search_by_key(&candidate.as_str(), |(name, _)| name)
            {
                candidate = data::PARENTS[index].1.into();
            } else if let Some(at) = candidate.rfind('-') {
                candidate.truncate(at);
            } else {
                let (locale, tables) = data::LOCALES[data::LOCALES
                    .binary_search_by_key(&"en", |(name, _)| name)
                    .unwrap()];
                return Self { locale, tables };
            }
        }
    }
    fn table(&self, width: usize) -> &'static [u16] {
        &data::TABLES[self.tables[width] as usize]
    }
}

fn text(index: u16) -> &'static str {
    let start = data::OFFSETS[index as usize] as usize;
    let end = data::OFFSETS[index as usize + 1] as usize;
    &data::TEXT[start..end]
}
fn category_index(category: PluralCategory) -> usize {
    match category {
        PluralCategory::Zero => 0,
        PluralCategory::One => 1,
        PluralCategory::Two => 2,
        PluralCategory::Few => 3,
        PluralCategory::Many => 4,
        PluralCategory::Other => 5,
    }
}
fn form(record: &[u16; 8], category: usize) -> &'static str {
    text(if record[category] == 0 {
        record[5]
    } else {
        record[category]
    })
}

enum Patterns {
    Static(&'static [u16; 8]),
    Compound(Box<[String; 6]>),
}
pub(super) struct UnitFormat {
    patterns: Patterns,
}
impl UnitFormat {
    pub(super) fn new(locale: UnitLocale, spec: UnitSpec, width: usize) -> Self {
        let row = locale.table(width);
        let numerator = &data::FORMS[row[spec.numerator as usize] as usize];
        let Some(denominator) = spec.denominator else {
            return Self {
                patterns: Patterns::Static(numerator),
            };
        };
        if let Ok(index) = data::COMPOUNDS.binary_search(&(spec.numerator, denominator)) {
            return Self {
                patterns: Patterns::Static(&data::FORMS[row[data::SIMPLE.len() + index] as usize]),
            };
        }
        let denominator = &data::FORMS[row[denominator as usize] as usize];
        let per = if denominator[6] == 0 {
            text(row[data::SIMPLE.len() + data::COMPOUNDS.len()])
        } else {
            text(denominator[6])
        };
        let patterns = core::array::from_fn(|category| {
            per.replace("{0}", form(numerator, category))
                .replace("{1}", text(denominator[7]))
        });
        Self {
            patterns: Patterns::Compound(Box::new(patterns)),
        }
    }
    pub(super) fn heap_bytes(&self) -> usize {
        match &self.patterns {
            Patterns::Static(_) => 0,
            Patterns::Compound(patterns) => {
                core::mem::size_of::<[String; 6]>()
                    + patterns.iter().map(String::capacity).sum::<usize>()
            }
        }
    }
    pub(super) fn write<W: PartsWrite + ?Sized>(
        &self,
        category: PluralCategory,
        sink: &mut W,
        mut number: impl FnMut(&mut W) -> fmt::Result,
    ) -> fmt::Result {
        let category = category_index(category);
        let pattern = match &self.patterns {
            Patterns::Static(record) => form(record, category),
            Patterns::Compound(patterns) => &patterns[category],
        };
        if let Some(at) = pattern.find("{0}") {
            affix(&pattern[..at], sink)?;
            number(sink)?;
            affix(&pattern[at + 3..], sink)
        } else {
            // Some plural forms encode the amount in the unit word itself.
            affix(pattern, sink)
        }
    }
}
fn boundary(character: char) -> bool {
    character.is_whitespace()
        || matches!(character,'\u{061c}'|'\u{200e}'|'\u{200f}'|'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}')
}
fn affix<W: PartsWrite + ?Sized>(pattern: &str, sink: &mut W) -> fmt::Result {
    let core = pattern.trim_matches(boundary);
    if core.is_empty() {
        return sink.write_str(pattern);
    }
    let start = pattern.len() - pattern.trim_start_matches(boundary).len();
    sink.write_str(&pattern[..start])?;
    sink.with_part(UNIT_LABEL, |sink| sink.write_str(core))?;
    sink.write_str(&pattern[start + core.len()..])
}

#[no_mangle]
pub unsafe extern "C" fn mal_i18n_unit_is_valid(identifier: *const u8, length: usize) -> i32 {
    let input = unsafe { crate::ffi::nullable_slice(identifier, length) };
    i32::from(
        core::str::from_utf8(input)
            .ok()
            .and_then(UnitSpec::parse)
            .is_some(),
    )
}
