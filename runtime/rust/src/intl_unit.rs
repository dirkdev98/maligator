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
impl Patterns {
    fn get(&self, category: usize) -> &str {
        match self {
            Self::Static(record) => form(record, category),
            Self::Compound(patterns) => &patterns[category],
        }
    }
}

#[derive(Clone, Copy, Default)]
struct PatternLayout {
    number: u32,
    before_start: u32,
    before_end: u32,
    after_start: u32,
    after_end: u32,
}
impl PatternLayout {
    fn new(pattern: &str) -> Self {
        let offset = |value| u32::try_from(value).expect("unit pattern exceeds u32 offsets");
        let bounds = |text: &str| {
            let start = text.len() - text.trim_start_matches(boundary).len();
            let end = start + text.trim_matches(boundary).len();
            (offset(start), offset(end))
        };
        let number = pattern.find("{0}");
        let (before, after) =
            number.map_or((pattern, ""), |at| (&pattern[..at], &pattern[at + 3..]));
        let (before_start, before_end) = bounds(before);
        let (after_start, after_end) = bounds(after);
        Self {
            number: number.map_or(u32::MAX, offset),
            before_start,
            before_end,
            after_start,
            after_end,
        }
    }
}

pub(super) struct UnitFormat {
    patterns: Patterns,
    layouts: [PatternLayout; 6],
}
impl UnitFormat {
    fn prepare(patterns: Patterns) -> Self {
        let mut layouts = [PatternLayout::default(); 6];
        for category in 0..6 {
            let pattern = patterns.get(category);
            layouts[category] = (0..category)
                .find(|&previous| patterns.get(previous) == pattern)
                .map_or_else(|| PatternLayout::new(pattern), |previous| layouts[previous]);
        }
        Self { patterns, layouts }
    }

    pub(super) fn new(locale: UnitLocale, spec: UnitSpec, width: usize) -> Self {
        let row = locale.table(width);
        let numerator = &data::FORMS[row[spec.numerator as usize] as usize];
        let Some(denominator) = spec.denominator else {
            return Self::prepare(Patterns::Static(numerator));
        };
        if let Ok(index) = data::COMPOUNDS.binary_search(&(spec.numerator, denominator)) {
            return Self::prepare(Patterns::Static(
                &data::FORMS[row[data::SIMPLE.len() + index] as usize],
            ));
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
        Self::prepare(Patterns::Compound(Box::new(patterns)))
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
        parts: bool,
        mut number: impl FnMut(&mut W) -> fmt::Result,
    ) -> fmt::Result {
        let category = category_index(category);
        let pattern = self.patterns.get(category);
        let layout = self.layouts[category];
        if layout.number != u32::MAX {
            let at = layout.number as usize;
            affix(
                &pattern[..at],
                layout.before_start,
                layout.before_end,
                sink,
                parts,
            )?;
            number(sink)?;
            affix(
                &pattern[at + 3..],
                layout.after_start,
                layout.after_end,
                sink,
                parts,
            )
        } else {
            // Some plural forms encode the amount in the unit word itself.
            affix(pattern, layout.before_start, layout.before_end, sink, parts)
        }
    }
}
fn boundary(character: char) -> bool {
    character.is_whitespace()
        || matches!(character,'\u{061c}'|'\u{200e}'|'\u{200f}'|'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}')
}
fn affix<W: PartsWrite + ?Sized>(
    pattern: &str,
    start: u32,
    end: u32,
    sink: &mut W,
    parts: bool,
) -> fmt::Result {
    if !parts || start == end {
        return sink.write_str(pattern);
    }
    let start = start as usize;
    let end = end as usize;
    if start > 0 {
        sink.write_str(&pattern[..start])?;
    }
    sink.with_part(UNIT_LABEL, |sink| sink.write_str(&pattern[start..end]))?;
    if end < pattern.len() {
        sink.write_str(&pattern[end..])?;
    }
    Ok(())
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
