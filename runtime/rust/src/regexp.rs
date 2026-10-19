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

use std::cell::RefCell;
use std::collections::VecDeque;
use std::sync::Arc;

use regress::{AsciiMatches, Flags, Match, Regex};

use crate::ffi::{nullable_slice, nullable_u16_slice, write_utf8};

/// ABI version, mirrored by MAL_REGEXP_ABI_VERSION in mal_regexp.h.
/// v2: added `mal_regexp_free` (GC finalization, gc_todo.md D2).
/// v3: added immutable-subject identity and execution-path reporting.
/// v4: added conservative allocation-free literal/class execution plans.
/// v5: added compact Latin-1 subject execution.
/// v6: added fresh-state cloning of an existing compiled pattern.
pub const MAL_REGEXP_ABI_VERSION: u32 = 6;

const EXEC_ASCII: u32 = 1 << 0;
const EXEC_CACHE_HIT: u32 = 1 << 1;
const EXEC_CACHE_FILL: u32 = 1 << 2;
const EXEC_NON_ASCII: u32 = 1 << 3;
const EXEC_FAST: u32 = 1 << 4;
const EXEC_LATIN1: u32 = 1 << 5;

// Flag bits, mirrored by MAL_REGEXP_FLAG_* in mal_regexp.h. g/y/d are
// engine-external and deliberately absent.
const FLAG_IGNORE_CASE: u32 = 1 << 0; // i
const FLAG_MULTILINE: u32 = 1 << 1; // m
const FLAG_DOT_ALL: u32 = 1 << 2; // s
const FLAG_UNICODE: u32 = 1 << 3; // u
const FLAG_UNICODE_SETS: u32 = 1 << 4; // v
const COMPILE_FLAGS: u32 =
    FLAG_IGNORE_CASE | FLAG_MULTILINE | FLAG_DOT_ALL | FLAG_UNICODE | FLAG_UNICODE_SETS;

const PATTERN_CACHE_CAPACITY: usize = 24;
const ASCII_SUBJECT_CACHE_MAX_BYTES: usize = 64 * 1024;
const LATIN1_WIDE_RETAINED_UNITS: usize = 64 * 1024;
const FAST_CAPTURE_CAPACITY: usize = 31;
const FAST_CAPTURE_SLOTS: usize = (FAST_CAPTURE_CAPACITY + 1) * 2;

/// A set of UTF-16 code units: a bitmap below 256 and sorted disjoint ranges above.
#[derive(Debug, Clone)]
struct FastClass {
    low: [u64; 4],
    high: Box<[(u16, u16)]>,
}

impl FastClass {
    fn empty() -> Self {
        Self {
            low: [0; 4],
            high: Box::new([]),
        }
    }

    fn from_ranges(mut ranges: Vec<(u16, u16)>, negate: bool) -> Self {
        ranges.sort_unstable();
        let mut merged: Vec<(u16, u16)> = Vec::with_capacity(ranges.len());
        for (first, last) in ranges {
            match merged.last_mut() {
                Some(previous) if u32::from(first) <= u32::from(previous.1) + 1 => {
                    previous.1 = previous.1.max(last);
                }
                _ => merged.push((first, last)),
            }
        }
        if negate {
            let mut complement = Vec::with_capacity(merged.len() + 1);
            let mut next = 0u32;
            for (first, last) in merged {
                if u32::from(first) > next {
                    complement.push((next as u16, first - 1));
                }
                next = u32::from(last) + 1;
            }
            if next <= 0xffff {
                complement.push((next as u16, 0xffff));
            }
            merged = complement;
        }
        let mut low = [0u64; 4];
        let mut high = Vec::new();
        for (first, last) in merged {
            for unit in first..=last.min(255) {
                low[usize::from(unit >> 6)] |= 1 << (unit & 63);
            }
            if last >= 256 {
                high.push((first.max(256), last));
            }
        }
        Self {
            low,
            high: high.into(),
        }
    }

    fn unit(unit: u16) -> Self {
        Self::from_ranges(vec![(unit, unit)], false)
    }

    #[inline]
    fn contains(&self, unit: u16) -> bool {
        if unit < 256 {
            return self.low[usize::from(unit >> 6)] >> (unit & 63) & 1 != 0;
        }
        self.high
            .binary_search_by(|(first, last)| {
                if *last < unit {
                    core::cmp::Ordering::Less
                } else if *first > unit {
                    core::cmp::Ordering::Greater
                } else {
                    core::cmp::Ordering::Equal
                }
            })
            .is_ok()
    }

    fn intersects(&self, other: &Self) -> bool {
        if self.low.iter().zip(&other.low).any(|(a, b)| a & b != 0) {
            return true;
        }
        let (mut left, mut right) = (0, 0);
        while left < self.high.len() && right < other.high.len() {
            let (a, b) = (self.high[left], other.high[right]);
            if a.1 < b.0 {
                left += 1;
            } else if b.1 < a.0 {
                right += 1;
            } else {
                return true;
            }
        }
        false
    }

    fn union(&self, other: &Self) -> Self {
        let mut low = self.low;
        for (word, other_word) in low.iter_mut().zip(&other.low) {
            *word |= other_word;
        }
        let mut high = self.high.to_vec();
        high.extend_from_slice(&other.high);
        let merged = Self::from_ranges(high, false);
        Self {
            low,
            high: merged.high,
        }
    }
}

/// One element of an allocation-free plan. Every quantifier is greedy and never
/// backtracks; `compile_fast_pattern` admits only plans where that is exact.
#[derive(Debug)]
enum FastNode {
    Literal(Box<[u16]>),
    Repeat {
        class: FastClass,
        min: u32,
        max: u32,
    },
    Group {
        body: Box<[FastNode]>,
        capture: Option<usize>,
        /// Capture indices inside the group, cleared when an optional group is skipped.
        inner: core::ops::Range<usize>,
        optional: bool,
    },
    End,
}

#[derive(Debug)]
struct FastPattern {
    anchored_start: bool,
    nodes: Box<[FastNode]>,
    capture_count: usize,
    /// Units a match can begin with, when every match consumes one.
    first: Option<FastClass>,
}

struct FastMatch {
    start: usize,
    end: usize,
    captures: [Option<(usize, usize)>; FAST_CAPTURE_CAPACITY],
}

/// Subject storage the allocation-free plans can scan directly. Plans contain
/// only ASCII units, so compact Latin-1 bytes compare exactly like their UTF-16
/// widening and never need a converted copy.
trait SubjectUnit: Copy {
    fn code_unit(self) -> u16;
    fn find_unit(subject: &[Self], from: usize, needle: u16) -> Option<usize>;
}

impl SubjectUnit for u16 {
    #[inline]
    fn code_unit(self) -> u16 {
        self
    }

    fn find_unit(subject: &[u16], from: usize, needle: u16) -> Option<usize> {
        const LANE_ONES: u64 = 0x0001_0001_0001_0001;
        const LANE_HIGH_BITS: u64 = 0x8000_8000_8000_8000;

        let repeated = u64::from(needle) * LANE_ONES;
        let mut position = from;
        while position + 4 <= subject.len() {
            let word = unsafe {
                subject
                    .as_ptr()
                    .add(position)
                    .cast::<u64>()
                    .read_unaligned()
            };
            let difference = word ^ repeated;
            let candidates = difference.wrapping_sub(LANE_ONES) & !difference & LANE_HIGH_BITS;
            if candidates != 0 {
                for offset in 0..4 {
                    if subject[position + offset] == needle {
                        return Some(position + offset);
                    }
                }
            }
            position += 4;
        }
        (position..subject.len()).find(|index| subject[*index] == needle)
    }
}

impl SubjectUnit for u8 {
    #[inline]
    fn code_unit(self) -> u16 {
        u16::from(self)
    }

    fn find_unit(subject: &[u8], from: usize, needle: u16) -> Option<usize> {
        const LANE_ONES: u64 = 0x0101_0101_0101_0101;
        const LANE_HIGH_BITS: u64 = 0x8080_8080_8080_8080;

        let needle = u8::try_from(needle).ok()?;
        let repeated = u64::from(needle) * LANE_ONES;
        let mut position = from;
        while position + 8 <= subject.len() {
            let word = unsafe {
                subject
                    .as_ptr()
                    .add(position)
                    .cast::<u64>()
                    .read_unaligned()
            };
            let difference = word ^ repeated;
            if difference.wrapping_sub(LANE_ONES) & !difference & LANE_HIGH_BITS != 0 {
                for offset in 0..8 {
                    if subject[position + offset] == needle {
                        return Some(position + offset);
                    }
                }
            }
            position += 8;
        }
        (position..subject.len()).find(|index| subject[*index] == needle)
    }
}

impl FastPattern {
    fn literal_matches_at<U: SubjectUnit>(literal: &[u16], subject: &[U], position: usize) -> bool {
        if position + literal.len() > subject.len() {
            return false;
        }
        literal
            .iter()
            .zip(&subject[position..position + literal.len()])
            .all(|(expected, unit)| unit.code_unit() == *expected)
    }

    fn match_nodes<U: SubjectUnit>(
        nodes: &[FastNode],
        subject: &[U],
        mut position: usize,
        captures: &mut [Option<(usize, usize)>; FAST_CAPTURE_CAPACITY],
    ) -> Option<usize> {
        for node in nodes {
            match node {
                FastNode::Literal(literal) => {
                    if !Self::literal_matches_at(literal, subject, position) {
                        return None;
                    }
                    position += literal.len();
                }
                FastNode::Repeat { class, min, max } => {
                    let limit = subject.len().min(position.saturating_add(*max as usize));
                    let mut end = position;
                    while end < limit && class.contains(subject[end].code_unit()) {
                        end += 1;
                    }
                    if end - position < *min as usize {
                        return None;
                    }
                    position = end;
                }
                FastNode::Group {
                    body,
                    capture,
                    inner,
                    optional,
                } => match Self::match_nodes(body, subject, position, captures) {
                    Some(end) => {
                        if let Some(index) = capture {
                            captures[*index] = Some((position, end));
                        }
                        position = end;
                    }
                    None if *optional => {
                        for index in inner.clone() {
                            captures[index] = None;
                        }
                    }
                    None => return None,
                },
                FastNode::End => {
                    if position != subject.len() {
                        return None;
                    }
                }
            }
        }
        Some(position)
    }

    fn match_at<U: SubjectUnit>(
        &self,
        subject: &[U],
        start: usize,
        captures: &mut [Option<(usize, usize)>; FAST_CAPTURE_CAPACITY],
    ) -> Option<FastMatch> {
        match Self::match_nodes(&self.nodes, subject, start, captures) {
            Some(end) => Some(FastMatch {
                start,
                end,
                captures: *captures,
            }),
            None => {
                captures[..self.capture_count].fill(None);
                None
            }
        }
    }

    fn find<U: SubjectUnit>(&self, subject: &[U], start: usize) -> Option<FastMatch> {
        let mut captures = [None; FAST_CAPTURE_CAPACITY];
        if self.anchored_start {
            return (start == 0)
                .then(|| self.match_at(subject, 0, &mut captures))
                .flatten();
        }
        let leading_unit = match self.nodes.first() {
            Some(FastNode::Literal(literal)) => Some(literal[0]),
            _ => None,
        };
        let mut candidate = start;
        while candidate <= subject.len() {
            if let Some(unit) = leading_unit {
                candidate = U::find_unit(subject, candidate, unit)?;
            } else if let Some(first) = &self.first {
                while candidate < subject.len() && !first.contains(subject[candidate].code_unit()) {
                    candidate += 1;
                }
                if candidate == subject.len() {
                    return None;
                }
            }
            if let Some(found) = self.match_at(subject, candidate, &mut captures) {
                return Some(found);
            }
            candidate += 1;
        }
        None
    }
}

/// How a sequence's first-unit set ends: at a node that always consumes, at a `$`
/// after which nothing can consume, or by matching empty.
#[derive(Clone, Copy, PartialEq, Eq)]
enum FastFirstEnd {
    Consumes,
    Blocked,
    Nullable,
}

fn fast_first(nodes: &[FastNode]) -> (FastClass, FastFirstEnd) {
    let mut first = FastClass::empty();
    for node in nodes {
        let (node_first, end) = match node {
            FastNode::Literal(literal) => (FastClass::unit(literal[0]), FastFirstEnd::Consumes),
            FastNode::Repeat { class, min, .. } => (
                class.clone(),
                if *min > 0 {
                    FastFirstEnd::Consumes
                } else {
                    FastFirstEnd::Nullable
                },
            ),
            FastNode::Group { body, optional, .. } => {
                let (body_first, end) = fast_first(body);
                (
                    body_first,
                    if *optional {
                        FastFirstEnd::Nullable
                    } else {
                        end
                    },
                )
            }
            FastNode::End => (FastClass::empty(), FastFirstEnd::Blocked),
        };
        first = first.union(&node_first);
        if end != FastFirstEnd::Nullable {
            return (first, end);
        }
    }
    (first, FastFirstEnd::Nullable)
}

/// The units that can be consumed first after `nodes`, given those after the enclosing sequence.
fn fast_follow(nodes: &[FastNode], outer: &FastClass) -> FastClass {
    match fast_first(nodes) {
        (first, FastFirstEnd::Nullable) => first.union(outer),
        (first, _) => first,
    }
}

/// Greedy matching equals ECMAScript backtracking when no quantified class shares a unit
/// with what can follow it: a backtracking engine would only retry shorter runs, and the
/// continuation can neither consume a unit of the run nor end the match inside it. An
/// optional group needs the same disjointness and must always consume, so skipping it
/// cannot succeed where taking it failed.
fn fast_nodes_are_greedy_safe(nodes: &[FastNode], outer: &FastClass) -> bool {
    for (index, node) in nodes.iter().enumerate() {
        let follow = fast_follow(&nodes[index + 1..], outer);
        match node {
            FastNode::Repeat { class, min, max } if min != max && class.intersects(&follow) => {
                return false;
            }
            FastNode::Group { body, optional, .. } => {
                if *optional {
                    let (first, end) = fast_first(body);
                    if end != FastFirstEnd::Consumes || first.intersects(&follow) {
                        return false;
                    }
                }
                if !fast_nodes_are_greedy_safe(body, &follow) {
                    return false;
                }
            }
            _ => {}
        }
    }
    true
}

const FAST_REPEAT_LIMIT: u32 = 0xffff;

/// Recursive-descent reader for the allocation-free subset: literals, escapes, classes,
/// greedy quantifiers, plain and optional groups, a leading `^` and `$`. Anything with
/// Annex B or alternation semantics declines the plan.
struct FastParser<'a> {
    units: &'a [u16],
    position: usize,
    capture_count: usize,
    /// Under `i` without `u`, Canonicalize never maps a non-ASCII unit to ASCII, so an
    /// ASCII-only pattern matches as if its letters stood for both cases.
    fold_ascii_case: bool,
}

fn fast_fold_ascii_ranges(ranges: &mut Vec<(u16, u16)>) {
    let mut swapped = Vec::new();
    for &(first, last) in ranges.iter() {
        let (upper_first, upper_last) = (first.max(0x41), last.min(0x5a));
        if upper_first <= upper_last {
            swapped.push((upper_first + 0x20, upper_last + 0x20));
        }
        let (lower_first, lower_last) = (first.max(0x61), last.min(0x7a));
        if lower_first <= lower_last {
            swapped.push((lower_first - 0x20, lower_last - 0x20));
        }
    }
    ranges.extend(swapped);
}

enum FastAtom {
    Unit(u16),
    Class(FastClass),
    Group(FastNode),
    End,
}

fn fast_shorthand_ranges(unit: u16) -> Option<(Vec<(u16, u16)>, bool)> {
    let digits = vec![(0x30, 0x39)];
    let word = vec![(0x30, 0x39), (0x41, 0x5a), (0x5f, 0x5f), (0x61, 0x7a)];
    let space = vec![
        (0x09, 0x0d),
        (0x20, 0x20),
        (0xa0, 0xa0),
        (0x1680, 0x1680),
        (0x2000, 0x200a),
        (0x2028, 0x2029),
        (0x202f, 0x202f),
        (0x205f, 0x205f),
        (0x3000, 0x3000),
        (0xfeff, 0xfeff),
    ];
    match unit {
        0x64 => Some((digits, false)), // d
        0x44 => Some((digits, true)),  // D
        0x77 => Some((word, false)),   // w
        0x57 => Some((word, true)),    // W
        0x73 => Some((space, false)),  // s
        0x53 => Some((space, true)),   // S
        _ => None,
    }
}

impl FastParser<'_> {
    fn peek(&self) -> Option<u16> {
        self.units.get(self.position).copied()
    }

    fn hex(&mut self, digits: usize) -> Option<u16> {
        let mut value = 0u32;
        for _ in 0..digits {
            let digit = char::from_u32(u32::from(self.peek()?))?.to_digit(16)?;
            value = value * 16 + digit;
            self.position += 1;
        }
        Some(value as u16)
    }

    /// A single-unit escape after the backslash, shared by atoms and class members.
    fn escaped_unit(&mut self, unit: u16) -> Option<u16> {
        match unit {
            0x74 => Some(0x09), // t
            0x6e => Some(0x0a), // n
            0x76 => Some(0x0b), // v
            0x66 => Some(0x0c), // f
            0x72 => Some(0x0d), // r
            0x30 if !self
                .peek()
                .is_some_and(|next| (0x30..=0x39).contains(&next)) =>
            {
                Some(0)
            }
            0x78 => self.hex(2),
            0x75 => self.hex(4),
            _ if unit < 0x80 && b"^$\\.*+?()[]{}|/-".contains(&(unit as u8)) => Some(unit),
            _ => None,
        }
    }

    fn class(&mut self) -> Option<FastClass> {
        let negate = self.peek() == Some(u16::from(b'^'));
        if negate {
            self.position += 1;
        }
        let mut ranges = Vec::new();
        let mut members = 0;
        loop {
            let unit = self.peek()?;
            self.position += 1;
            if unit == u16::from(b']') {
                break;
            }
            members += 1;
            let first = if unit == u16::from(b'\\') {
                let escaped = self.peek()?;
                self.position += 1;
                if let Some((shorthand, false)) = fast_shorthand_ranges(escaped) {
                    ranges.extend(shorthand);
                    continue;
                }
                self.escaped_unit(escaped)?
            } else {
                unit
            };
            let is_range = self.peek() == Some(u16::from(b'-'))
                && self.units.get(self.position + 1) != Some(&u16::from(b']'))
                && self.position + 1 < self.units.len();
            if !is_range {
                if self.fold_ascii_case && first >= 0x80 {
                    return None;
                }
                ranges.push((first, first));
                continue;
            }
            self.position += 1;
            let unit = self.peek()?;
            self.position += 1;
            let last = if unit == u16::from(b'\\') {
                let escaped = self.peek()?;
                self.position += 1;
                if fast_shorthand_ranges(escaped).is_some() {
                    return None;
                }
                self.escaped_unit(escaped)?
            } else {
                unit
            };
            if first > last || (self.fold_ascii_case && last >= 0x80) {
                return None;
            }
            ranges.push((first, last));
        }
        if self.fold_ascii_case {
            fast_fold_ascii_ranges(&mut ranges);
        }
        (members > 0).then(|| FastClass::from_ranges(ranges, negate))
    }

    fn quantifier(&mut self) -> Option<Option<(u32, u32)>> {
        let bounds = match self.peek() {
            Some(0x2a) => (0, u32::MAX), // *
            Some(0x2b) => (1, u32::MAX), // +
            Some(0x3f) => (0, 1),        // ?
            Some(0x7b) => {
                // {
                self.position += 1;
                let min = self.number()?;
                let max = if self.peek() == Some(u16::from(b',')) {
                    self.position += 1;
                    if self.peek() == Some(u16::from(b'}')) {
                        u32::MAX
                    } else {
                        self.number()?
                    }
                } else {
                    min
                };
                if self.peek() != Some(u16::from(b'}')) || min > max {
                    return None;
                }
                (min, max)
            }
            _ => return Some(None),
        };
        self.position += 1;
        if self.peek() == Some(u16::from(b'?')) {
            return None;
        }
        Some(Some(bounds))
    }

    fn number(&mut self) -> Option<u32> {
        let start = self.position;
        let mut value = 0u32;
        while let Some(digit @ 0x30..=0x39) = self.peek() {
            value = value * 10 + u32::from(digit - 0x30);
            if value > FAST_REPEAT_LIMIT {
                return None;
            }
            self.position += 1;
        }
        (self.position > start).then_some(value)
    }

    fn atom(&mut self, unit: u16) -> Option<FastAtom> {
        Some(match unit {
            0x24 => FastAtom::End, // $
            0x2e => FastAtom::Class(FastClass::from_ranges(
                vec![(0x0a, 0x0a), (0x0d, 0x0d), (0x2028, 0x2029)],
                true,
            )),
            0x5b => FastAtom::Class(self.class()?), // [
            0x5c => {
                let escaped = self.peek()?;
                self.position += 1;
                match fast_shorthand_ranges(escaped) {
                    Some((ranges, negate)) => {
                        FastAtom::Class(FastClass::from_ranges(ranges, negate))
                    }
                    None => FastAtom::Unit(self.escaped_unit(escaped)?),
                }
            }
            0x28 => {
                // (
                // Named groups report their names from the engine's match, which this
                // plan never builds.
                let capture = if self.peek() == Some(u16::from(b'?')) {
                    if self.units.get(self.position + 1) != Some(&u16::from(b':')) {
                        return None;
                    }
                    self.position += 2;
                    None
                } else {
                    Some(self.next_capture()?)
                };
                let inner_start = self.capture_count;
                let body = self.sequence()?;
                if self.peek() != Some(u16::from(b')')) {
                    return None;
                }
                self.position += 1;
                FastAtom::Group(FastNode::Group {
                    body: body.into(),
                    capture,
                    inner: capture.unwrap_or(inner_start)..self.capture_count,
                    optional: false,
                })
            }
            0x5e | 0x2a | 0x2b | 0x3f | 0x7b | 0x7d | 0x5d | 0x7c | 0x29 => return None,
            _ => FastAtom::Unit(unit),
        })
    }

    fn next_capture(&mut self) -> Option<usize> {
        (self.capture_count < FAST_CAPTURE_CAPACITY).then(|| {
            self.capture_count += 1;
            self.capture_count - 1
        })
    }

    fn sequence(&mut self) -> Option<Vec<FastNode>> {
        let mut nodes: Vec<FastNode> = Vec::new();
        let mut literal: Vec<u16> = Vec::new();
        while let Some(unit) = self.peek() {
            if unit == u16::from(b')') {
                break;
            }
            self.position += 1;
            let atom = self.atom(unit)?;
            let quantifier = self.quantifier()?;
            let folds = match atom {
                FastAtom::Unit(unit) if self.fold_ascii_case => {
                    if unit >= 0x80 {
                        return None;
                    }
                    (unit as u8).is_ascii_alphabetic()
                }
                _ => false,
            };
            let node = match (atom, quantifier) {
                (FastAtom::Unit(unit), None) if !folds => {
                    literal.push(unit);
                    continue;
                }
                (FastAtom::Unit(unit), bounds) => {
                    let mut ranges = vec![(unit, unit)];
                    if folds {
                        fast_fold_ascii_ranges(&mut ranges);
                    }
                    let (min, max) = bounds.unwrap_or((1, 1));
                    FastNode::Repeat {
                        class: FastClass::from_ranges(ranges, false),
                        min,
                        max,
                    }
                }
                (FastAtom::Class(class), bounds) => {
                    let (min, max) = bounds.unwrap_or((1, 1));
                    FastNode::Repeat { class, min, max }
                }
                (FastAtom::Group(group), None) => group,
                (
                    FastAtom::Group(FastNode::Group {
                        body,
                        capture,
                        inner,
                        ..
                    }),
                    Some((0, 1)),
                ) => FastNode::Group {
                    body,
                    capture,
                    inner,
                    optional: true,
                },
                (FastAtom::End, None) => FastNode::End,
                _ => return None,
            };
            if !literal.is_empty() {
                nodes.push(FastNode::Literal(core::mem::take(&mut literal).into()));
            }
            nodes.push(node);
        }
        if !literal.is_empty() {
            nodes.push(FastNode::Literal(literal.into()));
        }
        Some(nodes)
    }
}

fn compile_fast_pattern(units: &[u16], flags: u32) -> Option<FastPattern> {
    if units.is_empty() || flags & COMPILE_FLAGS & !FLAG_IGNORE_CASE != 0 {
        return None;
    }
    let anchored_start = units[0] == u16::from(b'^');
    let mut parser = FastParser {
        units,
        position: usize::from(anchored_start),
        capture_count: 0,
        fold_ascii_case: flags & FLAG_IGNORE_CASE != 0,
    };
    let nodes = parser.sequence()?;
    if parser.position != units.len()
        || nodes.is_empty()
        || !fast_nodes_are_greedy_safe(&nodes, &FastClass::empty())
    {
        return None;
    }
    let first = match fast_first(&nodes) {
        (first, FastFirstEnd::Consumes) => Some(first),
        _ => None,
    };
    Some(FastPattern {
        anchored_start,
        nodes: nodes.into(),
        capture_count: parser.capture_count,
        first,
    })
}

#[derive(PartialEq, Eq)]
struct PatternCacheKey {
    pattern: Box<[u16]>,
    compile_flags: u32,
}

struct PatternCacheEntry {
    key: PatternCacheKey,
    re: Arc<Regex>,
    fast: Option<Arc<FastPattern>>,
}

thread_local! {
    /// RegExp construction is thread-confined by the runtime, so a small local
    /// cache avoids synchronization while bounding retained patterns.
    static PATTERN_CACHE: RefCell<VecDeque<PatternCacheEntry>> =
        const { RefCell::new(VecDeque::new()) };
}

/// A compiled pattern plus its most recent match. The C runtime drives one exec
/// at a time on a single thread and fully consumes each result (captures + named
/// groups) before issuing the next exec, so caching `last` here is sound and
/// lets named groups be queried after a match without re-running it. A `Match`
/// owns all of its data (it does not borrow the subject), so it is safe to
/// retain past the exec call.
struct CompiledPattern {
    re: Arc<Regex>,
    fast: Option<Arc<FastPattern>>,
    /// `u`/`v` patterns match over code points; everything else over code units.
    unicode_mode: bool,
    /// The ASCII backend can use regress's anchored and literal-prefix searchers.
    /// Ignore-case stays on UTF-16 because that backend documents only ASCII
    /// folding, while ECMAScript may require Unicode-aware canonicalization.
    ascii_eligible: bool,
    subject_cache: Option<SubjectCache>,
    last: Option<Match>,
    fast_last_groups: i32,
    fast_last_captures: [i32; FAST_CAPTURE_SLOTS],
}

impl CompiledPattern {
    fn fresh(
        re: Arc<Regex>,
        fast: Option<Arc<FastPattern>>,
        unicode_mode: bool,
        ascii_eligible: bool,
    ) -> Self {
        Self {
            re,
            fast,
            unicode_mode,
            ascii_eligible,
            subject_cache: None,
            last: None,
            fast_last_groups: 0,
            fast_last_captures: [-1; FAST_CAPTURE_SLOTS],
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SubjectEncoding {
    Utf16,
    Latin1,
}

struct SubjectCache {
    heap_identity: u64,
    heap_epoch: u32,
    string_identity: usize,
    /// Widening a compact string in place can hand the same identity over in
    /// another encoding; entries never answer for the other representation.
    encoding: SubjectEncoding,
    /// Defer the O(n) ASCII classification until the same immutable subject is
    /// executed a second time. One-shot exec/search calls stay zero-copy UTF-16.
    classified: bool,
    /// None is a negative cache entry for a non-ASCII or deliberately uncached
    /// oversized subject.
    ascii: Option<String>,
    /// Latin-1 subjects are classified eagerly: the check copies nothing and
    /// lets ASCII text use the borrowed bytes directly.
    latin1_ascii: bool,
    /// Widened Latin-1 code units for executions that need UTF-16 input.
    wide: Option<Vec<u16>>,
    continuation: Option<AsciiContinuation>,
}

/// A global or sticky-free loop of `exec` calls over one ASCII subject resumes a
/// single match iterator, whose backtracking stack keeps its capacity between
/// matches instead of growing from empty on every call.
struct AsciiContinuation {
    // Declared first so it is dropped before the regex and text it borrows.
    matches: AsciiMatches<'static, 'static>,
    /// The position the iterator searches from next; only an `exec` starting
    /// exactly here may resume it.
    next_start: usize,
    text: *const u8,
    len: usize,
    _re: Arc<Regex>,
}

impl SubjectCache {
    fn matches(
        &self,
        heap_identity: u64,
        heap_epoch: u32,
        string_identity: usize,
        encoding: SubjectEncoding,
    ) -> bool {
        self.heap_identity == heap_identity
            && self.heap_epoch == heap_epoch
            && self.string_identity == string_identity
            && self.encoding == encoding
    }
}

/// Returns the ABI version baked into this archive.
#[no_mangle]
pub extern "C" fn mal_regexp_abi_version() -> u32 {
    MAL_REGEXP_ABI_VERSION
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

fn regress_flags(bits: u32) -> Flags {
    let mut flags = Flags::default();
    flags.icase = bits & FLAG_IGNORE_CASE != 0;
    flags.multiline = bits & FLAG_MULTILINE != 0;
    flags.dot_all = bits & FLAG_DOT_ALL != 0;
    flags.unicode = bits & FLAG_UNICODE != 0;
    flags.unicode_sets = bits & FLAG_UNICODE_SETS != 0;
    flags
}

struct CompiledPatternParts {
    re: Arc<Regex>,
    fast: Option<Arc<FastPattern>>,
    unicode_mode: bool,
}

/// Every evaluation of a regex literal constructs a new RegExp; the engine
/// program and the allocation-free plan depend only on the pattern and
/// semantic flags, so both are shared through the cache.
fn compile_pattern(units: &[u16], flags: u32) -> Option<CompiledPatternParts> {
    let semantic_flags = flags & COMPILE_FLAGS;
    let cached = PATTERN_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        let index = cache.iter().position(|entry| {
            entry.key.compile_flags == semantic_flags && entry.key.pattern.as_ref() == units
        })?;
        let entry = cache.remove(index)?;
        let parts = (Arc::clone(&entry.re), entry.fast.clone());
        cache.push_front(entry);
        Some(parts)
    });

    let regress = regress_flags(semantic_flags);
    let unicode_mode = regress.unicode || regress.unicode_sets;
    if let Some((re, fast)) = cached {
        return Some(CompiledPatternParts {
            re,
            fast,
            unicode_mode,
        });
    }

    let codepoints = utf16_to_codepoints(units);
    let re = Arc::new(Regex::from_unicode(codepoints.into_iter(), regress).ok()?);
    let fast = compile_fast_pattern(units, semantic_flags).map(Arc::new);
    PATTERN_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        cache.push_front(PatternCacheEntry {
            key: PatternCacheKey {
                pattern: units.into(),
                compile_flags: semantic_flags,
            },
            re: Arc::clone(&re),
            fast: fast.clone(),
        });
        cache.truncate(PATTERN_CACHE_CAPACITY);
    });
    Some(CompiledPatternParts {
        re,
        fast,
        unicode_mode,
    })
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
    // Keep raw code units here: compile_pattern deliberately preserves lone
    // surrogates as their numeric values instead of replacing them.
    let units = unsafe { nullable_u16_slice(pattern, pattern_len) };

    match compile_pattern(units, flags) {
        Some(CompiledPatternParts {
            re,
            fast,
            unicode_mode,
        }) => {
            let boxed = Box::new(CompiledPattern::fresh(
                re,
                fast,
                unicode_mode,
                flags & FLAG_IGNORE_CASE == 0,
            ));
            Box::into_raw(boxed) as *mut core::ffi::c_void
        }
        None => core::ptr::null_mut(),
    }
}

/// Share immutable engine code with a live handle, retaining no match or subject state.
/// The returned handle has independent ownership; a null source returns null.
#[no_mangle]
pub unsafe extern "C" fn mal_regexp_clone_fresh(
    handle: *const core::ffi::c_void,
) -> *mut core::ffi::c_void {
    if handle.is_null() {
        return core::ptr::null_mut();
    }
    let source = unsafe { &*(handle as *const CompiledPattern) };
    // Cloning replaces a compile-cache hit, so it must preserve that entry's recency.
    PATTERN_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(index) = cache
            .iter()
            .position(|entry| Arc::ptr_eq(&entry.re, &source.re))
        {
            if let Some(entry) = cache.remove(index) {
                cache.push_front(entry);
            }
        }
    });
    let boxed = Box::new(CompiledPattern::fresh(
        Arc::clone(&source.re),
        source.fast.clone(),
        source.unicode_mode,
        source.ascii_eligible,
    ));
    Box::into_raw(boxed) as *mut core::ffi::c_void
}

/// Free an owned compiled-pattern handle. Null-tolerant, so
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

fn cache_fast_captures(
    pattern: &FastPattern,
    found: &FastMatch,
    cached: &mut [i32; FAST_CAPTURE_SLOTS],
) -> i32 {
    cached.fill(-1);
    cached[0] = found.start as i32;
    cached[1] = found.end as i32;
    for index in 0..pattern.capture_count {
        if let Some((start, end)) = found.captures[index] {
            cached[(index + 1) * 2] = start as i32;
            cached[(index + 1) * 2 + 1] = end as i32;
        }
    }
    (pattern.capture_count + 1) as i32
}

unsafe fn copy_cached_captures(
    cached: &[i32; FAST_CAPTURE_SLOTS],
    groups: i32,
    out: *mut i32,
    cap: i32,
) -> i32 {
    let slots = ((groups.max(0) as usize) * 2).min(cap.max(0) as usize);
    if !out.is_null() && slots > 0 {
        unsafe { core::ptr::copy_nonoverlapping(cached.as_ptr(), out, slots) };
    }
    groups
}

fn finish_fast_exec(
    cp: &mut CompiledPattern,
    found: Option<FastMatch>,
    caps_out: *mut i32,
    caps_cap: i32,
) -> i32 {
    cp.last = None;
    match found {
        Some(found) => {
            let groups = cache_fast_captures(
                cp.fast.as_ref().expect("fast plan exists"),
                &found,
                &mut cp.fast_last_captures,
            );
            cp.fast_last_groups = groups;
            unsafe { copy_cached_captures(&cp.fast_last_captures, groups, caps_out, caps_cap) }
        }
        None => {
            cp.fast_last_groups = 0;
            0
        }
    }
}

/// The next match at or after `start`, resuming the cached iterator when the
/// previous `exec` over this same subject ended exactly at `start`.
fn next_ascii_match(
    cache: &mut SubjectCache,
    re: &Arc<Regex>,
    text: &str,
    start: usize,
) -> Option<Match> {
    let resumable = cache.continuation.as_ref().is_some_and(|continuation| {
        continuation.next_start == start
            && continuation.text == text.as_ptr()
            && continuation.len == text.len()
    });
    if !resumable {
        cache.continuation = None;
        let matches = re.find_from_ascii(text, start);
        // SAFETY: the continuation owns a clone of the regex Arc, and the text is
        // the subject's immutable bytes. The cache entry holding it is keyed by
        // heap epoch and string identity, and every sweep that can free the
        // subject bumps the epoch, so a stale entry is replaced before reuse.
        let matches = unsafe {
            core::mem::transmute::<AsciiMatches<'_, '_>, AsciiMatches<'static, 'static>>(matches)
        };
        cache.continuation = Some(AsciiContinuation {
            matches,
            next_start: start,
            text: text.as_ptr(),
            len: text.len(),
            _re: Arc::clone(re),
        });
    }
    let continuation = cache.continuation.as_mut().expect("continuation present");
    let found = continuation.matches.next();
    match &found {
        // After an empty match the iterator steps past it, which `exec` does not.
        Some(m) if m.end() > m.start() => continuation.next_start = m.end(),
        _ => cache.continuation = None,
    }
    found
}

fn finish_exec(
    cp: &mut CompiledPattern,
    found: Option<Match>,
    caps_out: *mut i32,
    caps_cap: i32,
) -> i32 {
    cp.fast_last_groups = 0;
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

fn find_wide(re: &Regex, unicode_mode: bool, subject: &[u16], start: usize) -> Option<Match> {
    if unicode_mode {
        re.find_from_utf16(subject, start).next()
    } else {
        re.find_from_ucs2(subject, start).next()
    }
}

/// Execute against `subject` (UTF-16) starting at code-unit index `start`.
/// Returns the group count (>= 1) on a match, 0 on no match, -1 on error.
#[no_mangle]
pub unsafe extern "C" fn mal_regexp_exec(
    handle: *mut core::ffi::c_void,
    subject: *const u16,
    subject_len: usize,
    start: usize,
    subject_identity: *const core::ffi::c_void,
    heap_identity: u64,
    heap_epoch: u32,
    caps_out: *mut i32,
    caps_cap: i32,
    execution_flags_out: *mut u32,
) -> i32 {
    if !execution_flags_out.is_null() {
        unsafe { *execution_flags_out = 0 };
    }
    if handle.is_null() {
        return -1;
    }
    let cp = unsafe { &mut *(handle as *mut CompiledPattern) };

    if start > subject_len {
        cp.last = None;
        cp.fast_last_groups = 0;
        return 0;
    }
    // regress receives the original code units so non-Unicode mode can match
    // lone surrogates and Unicode mode can apply its own pair handling.
    let subj = unsafe { nullable_u16_slice(subject, subject_len) };

    if let Some(fast) = cp.fast.as_ref() {
        let found = fast.find(subj, start);
        if !execution_flags_out.is_null() {
            unsafe { *execution_flags_out = EXEC_FAST };
        }
        return finish_fast_exec(cp, found, caps_out, caps_cap);
    }

    let mut execution_flags = 0;
    let found = if cp.ascii_eligible {
        let string_identity = subject_identity as usize;
        let cache_hit = cp.subject_cache.as_ref().is_some_and(|cache| {
            cache.matches(
                heap_identity,
                heap_epoch,
                string_identity,
                SubjectEncoding::Utf16,
            )
        });
        if !cache_hit {
            cp.subject_cache = Some(SubjectCache {
                heap_identity,
                heap_epoch,
                string_identity,
                encoding: SubjectEncoding::Utf16,
                classified: false,
                ascii: None,
                latin1_ascii: false,
                wide: None,
                continuation: None,
            });
            execution_flags |= EXEC_CACHE_FILL;
            find_wide(&cp.re, cp.unicode_mode, subj, start)
        } else {
            let cache = cp.subject_cache.as_mut().expect("cache key matched");
            if !cache.classified {
                cache.ascii = if subj.len() <= ASCII_SUBJECT_CACHE_MAX_BYTES
                    && subj.iter().all(|unit| *unit <= 0x7f)
                {
                    let bytes = subj.iter().map(|unit| *unit as u8).collect::<Vec<_>>();
                    Some(unsafe { String::from_utf8_unchecked(bytes) })
                } else {
                    None
                };
                cache.classified = true;
                execution_flags |= EXEC_CACHE_FILL;
            } else {
                execution_flags |= EXEC_CACHE_HIT;
            }

            if let Some(ascii) = cache.ascii.as_ref() {
                execution_flags |= EXEC_ASCII;
                // SAFETY: the copy is never modified after classification and the
                // continuation is the only field the call below updates.
                let text = unsafe { &*(ascii.as_str() as *const str) };
                next_ascii_match(cache, &cp.re, text, start)
            } else {
                execution_flags |= EXEC_NON_ASCII;
                find_wide(&cp.re, cp.unicode_mode, subj, start)
            }
        }
    } else {
        find_wide(&cp.re, cp.unicode_mode, subj, start)
    };
    if !execution_flags_out.is_null() {
        unsafe { *execution_flags_out = execution_flags };
    }
    finish_exec(cp, found, caps_out, caps_cap)
}

/// Execute against compact Latin-1 `subject` bytes. Positions remain UTF-16
/// code-unit indices because every Latin-1 byte is exactly one code unit.
#[no_mangle]
pub unsafe extern "C" fn mal_regexp_exec_latin1(
    handle: *mut core::ffi::c_void,
    subject: *const u8,
    subject_len: usize,
    start: usize,
    subject_identity: *const core::ffi::c_void,
    heap_identity: u64,
    heap_epoch: u32,
    caps_out: *mut i32,
    caps_cap: i32,
    execution_flags_out: *mut u32,
) -> i32 {
    if !execution_flags_out.is_null() {
        unsafe { *execution_flags_out = 0 };
    }
    if handle.is_null() {
        return -1;
    }
    let cp = unsafe { &mut *(handle as *mut CompiledPattern) };

    if start > subject_len {
        cp.last = None;
        cp.fast_last_groups = 0;
        return 0;
    }
    let subj = unsafe { nullable_slice(subject, subject_len) };

    if let Some(fast) = cp.fast.as_ref() {
        let found = fast.find(subj, start);
        if !execution_flags_out.is_null() {
            unsafe { *execution_flags_out = EXEC_FAST | EXEC_LATIN1 };
        }
        return finish_fast_exec(cp, found, caps_out, caps_cap);
    }

    let string_identity = subject_identity as usize;
    let mut execution_flags = EXEC_LATIN1;
    let cache_hit = cp.subject_cache.as_ref().is_some_and(|cache| {
        cache.matches(
            heap_identity,
            heap_epoch,
            string_identity,
            SubjectEncoding::Latin1,
        )
    });
    if cache_hit {
        execution_flags |= EXEC_CACHE_HIT;
    } else {
        // Keep one widening buffer per pattern so loops over many short
        // subjects do not allocate for every line.
        let mut wide = cp.subject_cache.take().and_then(|cache| cache.wide);
        if let Some(buffer) = wide.as_mut() {
            buffer.clear();
        }
        if wide.as_ref().is_some_and(|buffer| {
            buffer.capacity() > LATIN1_WIDE_RETAINED_UNITS
                && buffer.capacity() > subject_len.saturating_mul(4)
        }) {
            wide = None;
        }
        cp.subject_cache = Some(SubjectCache {
            heap_identity,
            heap_epoch,
            string_identity,
            encoding: SubjectEncoding::Latin1,
            classified: true,
            ascii: None,
            latin1_ascii: cp.ascii_eligible && subj.is_ascii(),
            wide,
            continuation: None,
        });
        execution_flags |= EXEC_CACHE_FILL;
    }

    let cache = cp.subject_cache.as_mut().expect("cache filled");
    let found = if cache.latin1_ascii {
        execution_flags |= EXEC_ASCII;
        // Eligibility excludes ignore-case, whose ECMAScript canonicalization
        // can map non-ASCII pattern units onto ASCII subject units.
        let text = unsafe { core::str::from_utf8_unchecked(subj) };
        next_ascii_match(cache, &cp.re, text, start)
    } else {
        execution_flags |= EXEC_NON_ASCII;
        let wide = cache.wide.get_or_insert_with(Vec::new);
        // The buffer is emptied on every fill, so a non-empty buffer already
        // holds this immutable subject.
        if wide.is_empty() {
            wide.extend(subj.iter().map(|unit| u16::from(*unit)));
        }
        find_wide(&cp.re, cp.unicode_mode, wide, start)
    };
    if !execution_flags_out.is_null() {
        unsafe { *execution_flags_out = execution_flags };
    }
    finish_exec(cp, found, caps_out, caps_cap)
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
    if cp.fast_last_groups > 0 {
        return unsafe {
            copy_cached_captures(
                &cp.fast_last_captures,
                cp.fast_last_groups,
                caps_out,
                caps_cap,
            )
        };
    }
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

    unsafe { write_utf8(name, name_out, name_cap) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(value: &str) -> Vec<u16> {
        value.encode_utf16().collect()
    }

    fn clear_cache() {
        PATTERN_CACHE.with(|cache| cache.borrow_mut().clear());
    }

    fn cache_len() -> usize {
        PATTERN_CACHE.with(|cache| cache.borrow().len())
    }

    unsafe fn handle(pattern: &[u16], flags: u32) -> *mut core::ffi::c_void {
        unsafe { mal_regexp_compile(pattern.as_ptr(), pattern.len(), flags) }
    }

    #[test]
    fn repeated_compilation_shares_only_the_regex() {
        clear_cache();
        let pattern = utf16("(a)(b)?");
        let first = unsafe { handle(&pattern, 0) };
        let second = unsafe { handle(&pattern, 0) };

        assert!(!first.is_null());
        assert!(!second.is_null());
        assert_ne!(first, second);
        let first_pattern = unsafe { &*(first as *const CompiledPattern) };
        let second_pattern = unsafe { &*(second as *const CompiledPattern) };
        assert!(Arc::ptr_eq(&first_pattern.re, &second_pattern.re));
        assert!(first_pattern.last.is_none());
        assert!(second_pattern.last.is_none());

        unsafe {
            mal_regexp_free(first);
            mal_regexp_free(second);
        }
    }

    #[test]
    fn fresh_clone_owns_code_but_not_the_sources_subject_or_captures() {
        clear_cache();
        assert!(unsafe { mal_regexp_clone_fresh(core::ptr::null()) }.is_null());
        let pattern = utf16("(?<letter>a)(b)?");
        let source = unsafe { handle(&pattern, FLAG_UNICODE) };
        let mut source_caps = [-1; 6];
        let mut flags = 0;
        assert_eq!(
            unsafe { exec_latin1(source, b"zab", 1, 7, &mut source_caps, &mut flags) },
            3
        );
        assert_eq!(source_caps, [1, 3, 1, 2, 2, 3]);
        let cloned = unsafe { mal_regexp_clone_fresh(source) };
        assert!(!cloned.is_null());
        assert_ne!(source, cloned);
        {
            let original = unsafe { &*(source as *const CompiledPattern) };
            let copy = unsafe { &*(cloned as *const CompiledPattern) };
            assert!(Arc::ptr_eq(&original.re, &copy.re));
            assert!(original.subject_cache.is_some());
            assert!(copy.subject_cache.is_none());
            assert!(copy.unicode_mode);
        }
        let mut clone_caps = [-1; 6];
        assert_eq!(
            unsafe { mal_regexp_copy_captures(cloned, clone_caps.as_mut_ptr(), 6) },
            0
        );
        assert_eq!(unsafe { mal_regexp_named_group_count(cloned) }, 0);
        assert_eq!(
            unsafe { exec_latin1(cloned, b"a", 2, 7, &mut clone_caps, &mut flags) },
            3
        );
        assert_eq!(clone_caps, [0, 1, 0, 1, -1, -1]);
        assert_eq!(unsafe { mal_regexp_named_group_count(cloned) }, 1);
        let mut retained = [-1; 6];
        assert_eq!(
            unsafe { mal_regexp_copy_captures(source, retained.as_mut_ptr(), 6) },
            3
        );
        assert_eq!(retained, source_caps);
        clear_cache();
        unsafe { mal_regexp_free(source) };
        assert_eq!(
            unsafe { exec_latin1(cloned, b"xab", 3, 7, &mut clone_caps, &mut flags) },
            3
        );
        assert_eq!(clone_caps, [1, 3, 1, 2, 2, 3]);
        assert_eq!(cache_len(), 0);
        unsafe { mal_regexp_free(cloned) };
    }

    #[test]
    fn fresh_clone_keeps_existing_compiled_code_hot_across_unrelated_constructions() {
        clear_cache();
        let pattern = utf16("(cache-hot+)");
        let source = unsafe { handle(&pattern, 0) };
        for index in 0..PATTERN_CACHE_CAPACITY + 2 {
            let other = utf16(&format!("other-{index}"));
            let handle = unsafe { handle(&other, 0) };
            unsafe { mal_regexp_free(handle) };
            let clone = unsafe { mal_regexp_clone_fresh(source) };
            unsafe { mal_regexp_free(clone) };
        }
        let recreated = unsafe { handle(&pattern, 0) };
        let original = unsafe { &*(source as *const CompiledPattern) };
        let warm = unsafe { &*(recreated as *const CompiledPattern) };
        assert!(Arc::ptr_eq(&original.re, &warm.re));
        assert_eq!(cache_len(), PATTERN_CACHE_CAPACITY);
        unsafe {
            mal_regexp_free(source);
            mal_regexp_free(recreated);
        }
    }

    #[test]
    fn fresh_clone_shares_fast_plan_but_keeps_capture_slots_independent() {
        clear_cache();
        let pattern = utf16("id=([0-9]+);");
        let source = unsafe { handle(&pattern, 0) };
        let mut source_caps = [-1; 4];
        let mut flags = 0;
        assert_eq!(
            unsafe { exec_latin1(source, b"id=12;", 1, 7, &mut source_caps, &mut flags) },
            2
        );
        assert_eq!(flags, EXEC_FAST | EXEC_LATIN1);
        let cloned = unsafe { mal_regexp_clone_fresh(source) };
        assert!(!cloned.is_null());
        {
            let original = unsafe { &*(source as *const CompiledPattern) };
            let copy = unsafe { &*(cloned as *const CompiledPattern) };
            assert!(Arc::ptr_eq(
                original.fast.as_ref().unwrap(),
                copy.fast.as_ref().unwrap()
            ));
        }
        let mut clone_caps = [-1; 4];
        assert_eq!(
            unsafe { mal_regexp_copy_captures(cloned, clone_caps.as_mut_ptr(), 4) },
            0
        );
        assert_eq!(
            unsafe { exec_latin1(cloned, b"id=345;", 2, 7, &mut clone_caps, &mut flags) },
            2
        );
        assert_eq!(clone_caps, [0, 7, 3, 6]);
        let mut retained = [-1; 4];
        assert_eq!(
            unsafe { mal_regexp_copy_captures(source, retained.as_mut_ptr(), 4) },
            2
        );
        assert_eq!(retained, [0, 6, 3, 5]);
        unsafe {
            mal_regexp_free(source);
            mal_regexp_free(cloned);
        }
    }

    #[test]
    fn shared_regex_handles_retain_independent_captures() {
        clear_cache();
        let pattern = utf16("(a)(b)?|^$");
        let first = unsafe { handle(&pattern, 0) };
        let second = unsafe { handle(&pattern, 0) };
        let first_subject = utf16("ab");
        let second_subject = utf16("a");
        let mut first_caps = [-1; 6];
        let mut second_caps = [-1; 6];
        let mut first_flags = 0;
        let mut second_flags = 0;

        assert_eq!(
            unsafe {
                mal_regexp_exec(
                    first,
                    first_subject.as_ptr(),
                    first_subject.len(),
                    0,
                    first_subject.as_ptr().cast(),
                    1,
                    0,
                    first_caps.as_mut_ptr(),
                    first_caps.len() as i32,
                    &mut first_flags,
                )
            },
            3
        );
        assert_eq!(
            unsafe {
                mal_regexp_exec(
                    second,
                    second_subject.as_ptr(),
                    second_subject.len(),
                    0,
                    second_subject.as_ptr().cast(),
                    1,
                    0,
                    second_caps.as_mut_ptr(),
                    second_caps.len() as i32,
                    &mut second_flags,
                )
            },
            3
        );
        assert_eq!(first_caps, [0, 2, 0, 1, 1, 2]);
        assert_eq!(second_caps, [0, 1, 0, 1, -1, -1]);
        assert_eq!(first_flags, EXEC_CACHE_FILL);
        assert_eq!(second_flags, EXEC_CACHE_FILL);

        let mut retained = [-1; 6];
        assert_eq!(
            unsafe {
                mal_regexp_copy_captures(first, retained.as_mut_ptr(), retained.len() as i32)
            },
            3
        );
        assert_eq!(retained, first_caps);

        unsafe {
            mal_regexp_free(first);
            mal_regexp_free(second);
        }
    }

    #[test]
    fn repeated_immutable_subjects_use_ascii_after_one_utf16_probe() {
        clear_cache();
        let pattern = utf16("value=([0-9]{1,})|^$");
        let subject = utf16("prefix value=42 suffix");
        let compiled = unsafe { handle(&pattern, 0) };
        let mut caps = [-1; 4];
        let mut flags = 0;

        for (expected_flags, epoch) in [
            (EXEC_CACHE_FILL, 7),
            (EXEC_ASCII | EXEC_CACHE_FILL, 7),
            (EXEC_ASCII | EXEC_CACHE_HIT, 7),
            (EXEC_CACHE_FILL, 8),
        ] {
            assert_eq!(
                unsafe {
                    mal_regexp_exec(
                        compiled,
                        subject.as_ptr(),
                        subject.len(),
                        0,
                        subject.as_ptr().cast(),
                        11,
                        epoch,
                        caps.as_mut_ptr(),
                        caps.len() as i32,
                        &mut flags,
                    )
                },
                2
            );
            assert_eq!(flags, expected_flags);
            assert_eq!(caps, [7, 15, 13, 15]);
        }

        unsafe { mal_regexp_free(compiled) };
    }

    #[test]
    fn fast_literal_and_class_plan_writes_captures_without_a_match_allocation() {
        clear_cache();
        let pattern = utf16("^level=([A-Z]+);user=([a-z]+)-([0-9]+);action=([a-z]+);");
        let subject = utf16("level=INFO;user=alpha-17;action=read;");
        let compiled = unsafe { handle(&pattern, 0) };
        let compiled_pattern = unsafe { &*(compiled as *const CompiledPattern) };
        assert!(compiled_pattern.fast.is_some());

        let mut captures = [-1; 10];
        let mut flags = 0;
        assert_eq!(
            unsafe {
                mal_regexp_exec(
                    compiled,
                    subject.as_ptr(),
                    subject.len(),
                    0,
                    subject.as_ptr().cast(),
                    1,
                    0,
                    captures.as_mut_ptr(),
                    captures.len() as i32,
                    &mut flags,
                )
            },
            5
        );
        assert_eq!(flags, EXEC_FAST);
        assert_eq!(captures, [0, 37, 6, 10, 16, 21, 22, 24, 32, 36]);

        let mut retained = [-1; 10];
        assert_eq!(
            unsafe {
                mal_regexp_copy_captures(compiled, retained.as_mut_ptr(), retained.len() as i32)
            },
            5
        );
        assert_eq!(retained, captures);
        unsafe { mal_regexp_free(compiled) };
    }

    #[test]
    fn fast_plan_is_conservative_about_flags_and_greedy_backtracking() {
        assert!(compile_fast_pattern(&utf16("value=([0-9]+)"), 0).is_some());
        assert!(compile_fast_pattern(&utf16("payload=[a-z]+"), 0).is_some());
        assert!(compile_fast_pattern(&utf16("value="), 0).is_some());
        assert!(compile_fast_pattern(&utf16("value$"), 0).is_some());
        assert!(compile_fast_pattern(&utf16(r"^(?:\/users\/([^\/]+))(?:\/$)?$"), 0).is_some());
        assert!(compile_fast_pattern(&utf16("[a-z]+a"), 0).is_none());
        assert!(compile_fast_pattern(&utf16("[a-z]+[a-c]"), 0).is_none());
        assert!(compile_fast_pattern(&utf16("[a-c]+d?b"), 0).is_none());
        assert!(compile_fast_pattern(&utf16("(?:ab)?a"), 0).is_none());
        assert!(compile_fast_pattern(&utf16("(a*)?"), 0).is_none());
        assert!(compile_fast_pattern(&utf16("a+?"), 0).is_none());
        assert!(compile_fast_pattern(&utf16("a|b"), 0).is_none());
        assert!(compile_fast_pattern(&utf16(r"\bword"), 0).is_none());
        assert!(compile_fast_pattern(&utf16("x{2,1}"), 0).is_none());
        assert!(compile_fast_pattern(&utf16("a{"), 0).is_none());
        assert!(compile_fast_pattern(&utf16("(?<name>a)"), 0).is_none());
        assert!(compile_fast_pattern(&utf16("value=([0-9]+)"), FLAG_IGNORE_CASE).is_some());
        assert!(compile_fast_pattern(&utf16("caf\u{e9}"), FLAG_IGNORE_CASE).is_none());
        assert!(compile_fast_pattern(&utf16(r"[\u00e0-\u00ff]"), FLAG_IGNORE_CASE).is_none());
        assert!(compile_fast_pattern(&utf16("value"), FLAG_MULTILINE).is_none());
    }

    fn fast_match_ranges(
        found: Option<FastMatch>,
        groups: usize,
    ) -> Option<Vec<Option<(usize, usize)>>> {
        found.map(|found| {
            let mut ranges = vec![Some((found.start, found.end))];
            ranges.extend((0..groups).map(|index| found.captures[index]));
            ranges
        })
    }

    #[test]
    fn ignore_case_plans_keep_non_ascii_units_off_ascii_letters() {
        for (pattern, subject) in [
            (r"\w", "\u{212a}"),
            ("k", "\u{212a}"),
            ("s", "\u{17f}"),
            ("[a-z]", "\u{17f}"),
        ] {
            let fast = compile_fast_pattern(&utf16(pattern), FLAG_IGNORE_CASE).unwrap();
            assert!(fast.find(&utf16(subject)[..], 0).is_none(), "{pattern}");
        }
        let fast = compile_fast_pattern(&utf16("k"), FLAG_IGNORE_CASE).unwrap();
        assert!(fast.find(&utf16("K")[..], 0).is_some());
    }

    #[test]
    fn fast_plans_agree_with_the_backtracking_engine() {
        let cases = [
            (r#"^(?:\/users\/([^\/]+))(?:\/$)?$"#, "/users/a b/", 0),
            (r#"^(?:\/middleware)(?:\/$)?$"#, "/middleware/", 0),
            (
                r#"^ *([A-Za-z0-9][A-Za-z0-9!#$&^_-]{0,126})\/([A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}) *$"#,
                " application/json ",
                0,
            ),
            (
                r#"^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$"#,
                "text/plain",
                0,
            ),
            (r#"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$"#, "token", 0),
            (r#"\+"#, "a+b", 0),
            (r#"%5B"#, "x%5By", 0),
            (
                r#"^[\x20\x09\x0a\x0d]*([^\x20\x09\x0a\x0d])"#,
                " \tvalue",
                0,
            ),
            (r#"^[\u0020-\u003A\u003D-\u007E]*$"#, "abc=;", 0),
            (r#"^text\/"#, "text/html", 0),
            (r#"a{2,3}b"#, "aaab", 0),
            (r#"(?:ab)?c$"#, "abc", 0),
            (r#"x(\d+)(?:\.(\d+))?y"#, "x12.5y", 0),
            (r#"(\w+)=([^;]*);?"#, "k=v;", 0),
            (r#"\s*,\s*"#, "a , b", 0),
            (r#"\u00e9+"#, "\u{e9}\u{e9}", 0),
            (r#".+"#, "abc", 0),
            (r#"a.c"#, "abc", 0),
            (r#"(a)(b)?"#, "ab", 0),
            (r#"[^a]+a"#, "bba", 0),
            (r#"^$"#, "", 0),
            (r#"x*"#, "xx", 0),
            (r#"([a-z]+)-(\d{2})"#, "ab-12", 0),
            (r#"(?:-(\S+))?$"#, "-foo", 0),
            (r#"\W\D"#, "!a", 0),
            (r#"(?:(a)b)?c"#, "abc", 0),
            (r#"x(?:(a)b)?"#, "xab", 0),
            (
                r#"^(?:\/users\/([^\/]+))(?:\/$)?$"#,
                "/Users/AB/",
                FLAG_IGNORE_CASE,
            ),
            (r#"^(?:\/json)(?:\/$)?$"#, "/JSON/", FLAG_IGNORE_CASE),
            (r#"[a-c]+X"#, "abCx", FLAG_IGNORE_CASE),
            (r#"(\w+)=([^;]*);?"#, "Key=Value;", FLAG_IGNORE_CASE),
            (r#"^text\/"#, "TEXT/html", FLAG_IGNORE_CASE),
            (r#"[^a-z]+"#, "1-A_", FLAG_IGNORE_CASE),
            (r#"x(\d+)y"#, "X12Y", FLAG_IGNORE_CASE),
            (r#"\W\Ds"#, "!aS", FLAG_IGNORE_CASE),
            (r#"[A-z]+"#, "a^Z", FLAG_IGNORE_CASE),
        ];
        let extras = [
            'a', 'b', 'c', 'x', 'y', 'Z', '0', '9', ' ', '/', ';', '=', ',', '-', '.', '\t',
            '\u{e9}', '\u{ff}', '\u{100}', '\u{2028}', '\u{3000}', 'A', 'S', 'X', '\u{c9}',
            '\u{17f}', '\u{212a}', 'k', 's',
        ];
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        for (pattern, seed, flags) in cases {
            let units = utf16(pattern);
            let fast = compile_fast_pattern(&units, flags)
                .unwrap_or_else(|| panic!("{pattern} has no fast plan"));
            let regex = Regex::from_unicode(
                utf16_to_codepoints(&units).into_iter(),
                regress_flags(flags),
            )
            .unwrap_or_else(|error| panic!("{pattern}: {error:?}"));
            let mut alphabet: Vec<u16> =
                units.iter().copied().filter(|unit| *unit < 0x80).collect();
            // regress lets KELVIN SIGN and LONG S match ASCII letters and \w under `i`
            // without `u`; ECMAScript's Canonicalize keeps them apart, as V8 does.
            alphabet.extend(
                extras
                    .iter()
                    .map(|unit| *unit as u16)
                    .filter(|unit| flags == 0 || !matches!(unit, 0x17f | 0x212a)),
            );
            for round in 0..1200 {
                let mut subject: Vec<u16> = if round % 2 == 0 {
                    utf16(seed)
                } else {
                    Vec::new()
                };
                let edits = if round % 2 == 0 {
                    next() % 4
                } else {
                    next() % 11
                };
                for _ in 0..edits {
                    let unit = alphabet[(next() % alphabet.len() as u64) as usize];
                    let position = (next() % (subject.len() as u64 + 1)) as usize;
                    match next() % 3 {
                        0 if position < subject.len() => subject[position] = unit,
                        1 if position < subject.len() => {
                            subject.remove(position);
                        }
                        _ => subject.insert(position, unit),
                    }
                }
                for start in 0..=subject.len() {
                    let expected =
                        regex.find_from_ucs2(&subject, start).next().map(|found| {
                            let mut ranges = vec![Some((found.range.start, found.range.end))];
                            ranges.extend(found.captures.iter().map(|capture| {
                                capture.as_ref().map(|range| (range.start, range.end))
                            }));
                            ranges
                        });
                    let groups = fast.capture_count;
                    assert_eq!(
                        fast_match_ranges(fast.find(&subject[..], start), groups),
                        expected,
                        "{pattern} on {subject:?} from {start}"
                    );
                    if subject.iter().all(|unit| *unit <= 0xff) {
                        let bytes: Vec<u8> = subject.iter().map(|unit| *unit as u8).collect();
                        assert_eq!(
                            fast_match_ranges(fast.find(&bytes[..], start), groups),
                            expected,
                            "{pattern} on Latin-1 {subject:?} from {start}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn fast_literal_candidate_scan_covers_unaligned_blocks_and_scalar_tails() {
        for target in 0..13 {
            let mut subject = vec![b'x' as u16; 13];
            subject[target] = b'v' as u16;
            assert_eq!(u16::find_unit(&subject, 0, b'v' as u16), Some(target));
            assert_eq!(u16::find_unit(&subject, target + 1, b'v' as u16), None);
        }

        let subject = utf16("x---v---");
        assert_eq!(u16::find_unit(&subject, 1, b'v' as u16), Some(4));
        assert_eq!(u16::find_unit(&subject, 1, b'z' as u16), None);
    }

    #[test]
    fn repeated_non_ascii_subjects_remain_on_utf16_without_rescanning() {
        clear_cache();
        let pattern = utf16(".|^$");
        let subject = utf16("é");
        let compiled = unsafe { handle(&pattern, 0) };
        let mut caps = [-1; 2];
        let mut flags = 0;

        for expected_flags in [
            EXEC_CACHE_FILL,
            EXEC_NON_ASCII | EXEC_CACHE_FILL,
            EXEC_NON_ASCII | EXEC_CACHE_HIT,
        ] {
            assert_eq!(
                unsafe {
                    mal_regexp_exec(
                        compiled,
                        subject.as_ptr(),
                        subject.len(),
                        0,
                        subject.as_ptr().cast(),
                        11,
                        7,
                        caps.as_mut_ptr(),
                        caps.len() as i32,
                        &mut flags,
                    )
                },
                1
            );
            assert_eq!(flags, expected_flags);
            assert_eq!(caps, [0, 1]);
        }

        unsafe { mal_regexp_free(compiled) };
    }

    unsafe fn exec_latin1(
        compiled: *mut core::ffi::c_void,
        subject: &[u8],
        identity: usize,
        epoch: u32,
        caps: &mut [i32],
        flags: &mut u32,
    ) -> i32 {
        unsafe {
            mal_regexp_exec_latin1(
                compiled,
                subject.as_ptr(),
                subject.len(),
                0,
                identity as *const core::ffi::c_void,
                11,
                epoch,
                caps.as_mut_ptr(),
                caps.len() as i32,
                flags,
            )
        }
    }

    #[test]
    fn ascii_latin1_subjects_borrow_their_bytes_for_the_ascii_engine() {
        clear_cache();
        let pattern = utf16("value=([0-9]{1,})|^$");
        let compiled = unsafe { handle(&pattern, 0) };
        let mut caps = [-1; 4];
        let mut flags = 0;

        for expected_flags in [
            EXEC_LATIN1 | EXEC_ASCII | EXEC_CACHE_FILL,
            EXEC_LATIN1 | EXEC_ASCII | EXEC_CACHE_HIT,
        ] {
            let found = unsafe {
                exec_latin1(
                    compiled,
                    b"prefix value=42 suffix",
                    1,
                    7,
                    &mut caps,
                    &mut flags,
                )
            };
            assert_eq!(found, 2);
            assert_eq!(flags, expected_flags);
            assert_eq!(caps, [7, 15, 13, 15]);
        }

        unsafe { mal_regexp_free(compiled) };
    }

    #[test]
    fn non_ascii_latin1_subjects_match_through_one_cached_widening() {
        clear_cache();
        let pattern = utf16("caf(.)=([0-9]{1,})|^$");
        let compiled = unsafe { handle(&pattern, 0) };
        let subject = b"menu caf\xe9=42";
        let mut caps = [-1; 6];
        let mut flags = 0;

        for expected_flags in [
            EXEC_LATIN1 | EXEC_NON_ASCII | EXEC_CACHE_FILL,
            EXEC_LATIN1 | EXEC_NON_ASCII | EXEC_CACHE_HIT,
        ] {
            assert_eq!(
                unsafe { exec_latin1(compiled, subject, 2, 7, &mut caps, &mut flags) },
                3
            );
            assert_eq!(flags, expected_flags);
            assert_eq!(caps, [5, 12, 8, 9, 10, 12]);
        }

        let other = b"caf\xe8=7";
        assert_eq!(
            unsafe { exec_latin1(compiled, other, 3, 7, &mut caps, &mut flags) },
            3
        );
        assert_eq!(flags, EXEC_LATIN1 | EXEC_NON_ASCII | EXEC_CACHE_FILL);
        assert_eq!(caps, [0, 6, 3, 4, 5, 6]);

        unsafe { mal_regexp_free(compiled) };
    }

    #[test]
    fn ignore_case_latin1_subjects_keep_unicode_canonicalization() {
        clear_cache();
        // Simple case folding maps KELVIN SIGN onto ASCII k, which the ASCII
        // backend's ASCII-only folding would miss.
        let pattern = utf16("\u{212a}");
        let compiled = unsafe { handle(&pattern, FLAG_IGNORE_CASE | FLAG_UNICODE) };
        let mut caps = [-1; 2];
        let mut flags = 0;

        assert_eq!(
            unsafe { exec_latin1(compiled, b"ok", 1, 7, &mut caps, &mut flags) },
            1
        );
        assert_eq!(flags & EXEC_ASCII, 0);
        assert_eq!(caps, [1, 2]);

        unsafe { mal_regexp_free(compiled) };
    }

    #[test]
    fn fast_plans_scan_latin1_bytes_above_ascii_without_matching_them() {
        clear_cache();
        let pattern = utf16("id=([0-9]+);");
        let compiled = unsafe { handle(&pattern, 0) };
        assert!(unsafe { &*(compiled as *const CompiledPattern) }
            .fast
            .is_some());
        let subject = b"\xe9\xe9\xe9id=\xb9;id=314;";
        let mut caps = [-1; 4];
        let mut flags = 0;

        assert_eq!(
            unsafe { exec_latin1(compiled, subject, 1, 7, &mut caps, &mut flags) },
            2
        );
        assert_eq!(flags, EXEC_FAST | EXEC_LATIN1);
        assert_eq!(caps, [8, 15, 11, 14]);

        unsafe { mal_regexp_free(compiled) };
    }

    #[test]
    fn subject_cache_entries_do_not_answer_for_another_encoding() {
        clear_cache();
        let pattern = utf16("b+|^$");
        let compiled = unsafe { handle(&pattern, 0) };
        // Alternation is not a fast plan, so both entries go through the subject cache.
        assert!(unsafe { &*(compiled as *const CompiledPattern) }
            .fast
            .is_none());
        let wide = utf16("abba");
        let mut caps = [-1; 2];
        let mut flags = 0;

        assert_eq!(
            unsafe { exec_latin1(compiled, b"abba", 5, 7, &mut caps, &mut flags) },
            1
        );
        assert_eq!(flags, EXEC_LATIN1 | EXEC_ASCII | EXEC_CACHE_FILL);
        assert_eq!(
            unsafe {
                mal_regexp_exec(
                    compiled,
                    wide.as_ptr(),
                    wide.len(),
                    0,
                    5 as *const core::ffi::c_void,
                    11,
                    7,
                    caps.as_mut_ptr(),
                    caps.len() as i32,
                    &mut flags,
                )
            },
            1
        );
        assert_eq!(flags, EXEC_CACHE_FILL);
        assert_eq!(caps, [1, 3]);

        unsafe { mal_regexp_free(compiled) };
    }

    #[test]
    fn latin1_unit_scan_covers_unaligned_blocks_and_scalar_tails() {
        for target in 0..21 {
            let mut subject = vec![0xe9u8; 21];
            subject[target] = b'v';
            assert_eq!(u8::find_unit(&subject, 0, b'v' as u16), Some(target));
            assert_eq!(u8::find_unit(&subject, target + 1, b'v' as u16), None);
        }
        assert_eq!(u8::find_unit(b"vvvv", 0, 0x176), None);
    }

    #[test]
    fn repeated_compilation_shares_the_allocation_free_plan() {
        clear_cache();
        let pattern = utf16("id=([0-9]+);");
        let first = unsafe { handle(&pattern, 0) };
        let second = unsafe { handle(&pattern, 0) };
        let first_fast = unsafe { &*(first as *const CompiledPattern) }
            .fast
            .as_ref()
            .unwrap();
        let second_fast = unsafe { &*(second as *const CompiledPattern) }
            .fast
            .as_ref()
            .unwrap();
        assert!(Arc::ptr_eq(first_fast, second_fast));
        unsafe {
            mal_regexp_free(first);
            mal_regexp_free(second);
        }
    }

    #[test]
    fn compile_flags_are_part_of_the_cache_key() {
        clear_cache();
        let pattern = utf16("a");
        let plain = compile_pattern(&pattern, 0).unwrap().re;
        let ignore_case = compile_pattern(&pattern, FLAG_IGNORE_CASE).unwrap().re;

        assert!(!Arc::ptr_eq(&plain, &ignore_case));
        assert_eq!(cache_len(), 2);
        assert!(plain.find_from_ucs2(&utf16("A"), 0).next().is_none());
        assert!(ignore_case.find_from_ucs2(&utf16("A"), 0).next().is_some());
    }

    #[test]
    fn invalid_patterns_are_not_cached() {
        clear_cache();
        let pattern = utf16("(");

        assert!(compile_pattern(&pattern, 0).is_none());
        assert!(compile_pattern(&pattern, 0).is_none());
        assert_eq!(cache_len(), 0);
    }

    #[test]
    fn cache_is_bounded_and_evicts_the_least_recent_pattern() {
        clear_cache();
        let first_pattern = utf16("pattern-0");
        let first = compile_pattern(&first_pattern, 0).unwrap().re;

        for index in 1..=PATTERN_CACHE_CAPACITY {
            let pattern = utf16(&format!("pattern-{index}"));
            assert!(compile_pattern(&pattern, 0).is_some());
        }
        assert_eq!(cache_len(), PATTERN_CACHE_CAPACITY);

        let recompiled = compile_pattern(&first_pattern, 0).unwrap().re;
        assert!(!Arc::ptr_eq(&first, &recompiled));
        assert_eq!(cache_len(), PATTERN_CACHE_CAPACITY);
    }
}
