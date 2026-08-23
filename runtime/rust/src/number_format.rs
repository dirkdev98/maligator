//! Allocation-free formatting primitives for ECMAScript Number.
//!
//! Rust's `LowerExp` formatter supplies the proven shortest round-tripping f64
//! digit sequence. The explicit-precision methods cannot use its rounding
//! directly because Rust rounds ties to even while ECMAScript chooses the
//! larger decimal integer. For those methods, a small fixed-capacity bigint
//! expands the binary f64 exactly and applies the spec's round-half-expand rule.

use core::cmp::Ordering;
use core::fmt::{self, Write as _};

const BIG_BASE: u64 = 1_000_000_000;
const BIG_LIMBS: usize = 128;
const EXACT_DIGITS: usize = 1100;
const RESULT_BYTES: usize = 256;
// A binary64 rounding interval is at least 2^-54 of its magnitude on either
// side. After 64 radix digits even base 2 has a grid spacing below 2^-63 of the
// normalized value, so a candidate must already be strictly inside. The long
// base-2 subnormal spelling comes from point placement, not significant digits.
const RADIX_DIGITS: usize = 64;
// The smallest binary64 has n = -1073 in base 2, so sign + "0." + leading
// zeroes + every significant digit still needs fewer than 1,200 bytes.
const RADIX_BYTES: usize = 1200;

struct ByteWriter<const N: usize> {
    bytes: [u8; N],
    len: usize,
}

impl<const N: usize> ByteWriter<N> {
    const fn new() -> Self {
        Self {
            bytes: [0; N],
            len: 0,
        }
    }

    fn push(&mut self, byte: u8) -> bool {
        if self.len == N {
            return false;
        }
        self.bytes[self.len] = byte;
        self.len += 1;
        true
    }

    fn extend(&mut self, bytes: &[u8]) -> bool {
        if bytes.len() > N - self.len {
            return false;
        }
        self.bytes[self.len..self.len + bytes.len()].copy_from_slice(bytes);
        self.len += bytes.len();
        true
    }

    fn as_bytes(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}

impl<const N: usize> fmt::Write for ByteWriter<N> {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        if self.extend(value.as_bytes()) {
            Ok(())
        } else {
            Err(fmt::Error)
        }
    }
}

fn push_u32<const N: usize>(out: &mut ByteWriter<N>, mut value: u32) -> bool {
    let mut reversed = [0u8; 10];
    let mut len = 0;
    loop {
        reversed[len] = b'0' + (value % 10) as u8;
        len += 1;
        value /= 10;
        if value == 0 {
            break;
        }
    }
    for index in (0..len).rev() {
        if !out.push(reversed[index]) {
            return false;
        }
    }
    true
}

fn push_signed_exponent<const N: usize>(out: &mut ByteWriter<N>, exponent: i32) -> bool {
    if !out.push(b'e') || !out.push(if exponent < 0 { b'-' } else { b'+' }) {
        return false;
    }
    push_u32(out, exponent.unsigned_abs())
}

struct ScientificDigits {
    digits: [u8; 24],
    len: usize,
    exponent: i32,
}

fn checked_power_of_five(exponent: i32) -> Option<u64> {
    if exponent < 0 {
        return None;
    }
    let mut result = 1u64;
    for _ in 0..exponent {
        result = result.checked_mul(5)?;
    }
    Some(result)
}

/// Rust's shortest formatter and ECMAScript agree except when the exact binary
/// value is halfway between two shortest decimal integers: Rust may choose the
/// odd one, while Number::toString recommends the even one. Detect that rare
/// case from the normalized binary exponent and correct only its integer.
fn correct_shortest_even_tie(value: f64, scientific: &mut ScientificDigits) {
    if scientific.len == 0 || scientific.digits[scientific.len - 1] & 1 == 0 {
        return;
    }

    let bits = value.to_bits();
    let raw_exponent = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1u64 << 52) - 1);
    let (significand, exponent2) = if raw_exponent == 0 {
        (fraction, -1074)
    } else {
        (fraction | (1u64 << 52), raw_exponent - 1023 - 52)
    };
    if significand == 0 {
        return;
    }
    let trailing_binary_zeros = significand.trailing_zeros() as i32;
    let odd_significand = significand >> trailing_binary_zeros;
    let normalized_exponent2 = exponent2 + trailing_binary_zeros;
    let unit_exponent10 = scientific.exponent - scientific.len as i32 + 1;

    // 2*x/10^q is an odd integer exactly at a halfway point. After removing
    // powers of two from x, this requires q == e2+1; the remaining factor is a
    // power of five, multiplied for q<0 and divided for q>0.
    if unit_exponent10 != normalized_exponent2 + 1 {
        return;
    }
    let odd_twice = if unit_exponent10 < 0 {
        let Some(power) = checked_power_of_five(-unit_exponent10) else {
            return;
        };
        let Some(value) = odd_significand.checked_mul(power) else {
            return;
        };
        value
    } else {
        let Some(power) = checked_power_of_five(unit_exponent10) else {
            return;
        };
        if odd_significand % power != 0 {
            return;
        }
        odd_significand / power
    };
    if odd_twice & 1 == 0 {
        return;
    }

    let lower = odd_twice / 2;
    let upper = lower + 1;
    let mut current = 0u64;
    for &digit in &scientific.digits[..scientific.len] {
        let Some(next) = current
            .checked_mul(10)
            .and_then(|value| value.checked_add((digit - b'0') as u64))
        else {
            return;
        };
        current = next;
    }
    if current != lower && current != upper {
        return;
    }
    let mut chosen = if lower & 1 == 0 { lower } else { upper };
    if chosen == current {
        return;
    }

    let mut corrected_unit_exponent = unit_exponent10;
    while chosen % 10 == 0 {
        chosen /= 10;
        corrected_unit_exponent += 1;
    }
    let mut reversed = [0u8; 20];
    let mut len = 0;
    while chosen != 0 {
        reversed[len] = b'0' + (chosen % 10) as u8;
        chosen /= 10;
        len += 1;
    }
    for index in 0..len {
        scientific.digits[index] = reversed[len - index - 1];
    }
    scientific.len = len;
    scientific.exponent = corrected_unit_exponent + len as i32 - 1;
}

fn shortest_scientific(value: f64) -> Option<ScientificDigits> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }

    let mut formatted = ByteWriter::<32>::new();
    write!(&mut formatted, "{:e}", value).ok()?;
    let bytes = formatted.as_bytes();
    let exponent_at = bytes.iter().position(|byte| *byte == b'e')?;

    let mut digits = [0u8; 24];
    let mut len = 0;
    for &byte in &bytes[..exponent_at] {
        if byte != b'.' {
            digits[len] = byte;
            len += 1;
        }
    }

    let mut index = exponent_at + 1;
    let negative = bytes.get(index) == Some(&b'-');
    if negative || bytes.get(index) == Some(&b'+') {
        index += 1;
    }
    let mut exponent = 0i32;
    while index < bytes.len() {
        let digit = bytes[index].checked_sub(b'0')?;
        if digit > 9 {
            return None;
        }
        exponent = exponent.checked_mul(10)?.checked_add(digit as i32)?;
        index += 1;
    }
    if negative {
        exponent = -exponent;
    }

    let mut result = ScientificDigits {
        digits,
        len,
        exponent,
    };
    correct_shortest_even_tie(value, &mut result);
    Some(result)
}

fn format_shortest(value: f64, exponential: bool) -> Option<ByteWriter<64>> {
    if !value.is_finite() {
        return None;
    }

    let mut out = ByteWriter::<64>::new();
    if value == 0.0 {
        out.push(b'0');
        if exponential {
            push_signed_exponent(&mut out, 0);
        }
        return Some(out);
    }

    let negative = value.is_sign_negative();
    let scientific = shortest_scientific(value.abs())?;
    if negative && !out.push(b'-') {
        return None;
    }

    if exponential {
        if !out.push(scientific.digits[0]) {
            return None;
        }
        if scientific.len > 1
            && (!out.push(b'.') || !out.extend(&scientific.digits[1..scientific.len]))
        {
            return None;
        }
        if !push_signed_exponent(&mut out, scientific.exponent) {
            return None;
        }
        return Some(out);
    }

    let decimal_position = scientific.exponent + 1;
    let digit_count = scientific.len as i32;
    if digit_count <= decimal_position && decimal_position <= 21 {
        if !out.extend(&scientific.digits[..scientific.len]) {
            return None;
        }
        for _ in 0..decimal_position - digit_count {
            if !out.push(b'0') {
                return None;
            }
        }
    } else if 0 < decimal_position && decimal_position <= 21 {
        let split = decimal_position as usize;
        if !out.extend(&scientific.digits[..split])
            || !out.push(b'.')
            || !out.extend(&scientific.digits[split..scientific.len])
        {
            return None;
        }
    } else if -6 < decimal_position && decimal_position <= 0 {
        if !out.extend(b"0.") {
            return None;
        }
        for _ in 0..-decimal_position {
            if !out.push(b'0') {
                return None;
            }
        }
        if !out.extend(&scientific.digits[..scientific.len]) {
            return None;
        }
    } else {
        if !out.push(scientific.digits[0]) {
            return None;
        }
        if scientific.len > 1
            && (!out.push(b'.') || !out.extend(&scientific.digits[1..scientific.len]))
        {
            return None;
        }
        if !push_signed_exponent(&mut out, scientific.exponent) {
            return None;
        }
    }
    Some(out)
}

#[derive(Clone)]
struct BigNat {
    limbs: [u32; BIG_LIMBS],
    len: usize,
}

impl BigNat {
    fn from_u64(mut value: u64) -> Self {
        let mut result = Self {
            limbs: [0; BIG_LIMBS],
            len: 0,
        };
        while value != 0 {
            result.limbs[result.len] = (value % BIG_BASE) as u32;
            result.len += 1;
            value /= BIG_BASE;
        }
        result
    }

    fn multiply_small(&mut self, factor: u32) -> Option<()> {
        let mut carry = 0u64;
        for limb in &mut self.limbs[..self.len] {
            let product = *limb as u64 * factor as u64 + carry;
            *limb = (product % BIG_BASE) as u32;
            carry = product / BIG_BASE;
        }
        while carry != 0 {
            if self.len == BIG_LIMBS {
                return None;
            }
            self.limbs[self.len] = (carry % BIG_BASE) as u32;
            self.len += 1;
            carry /= BIG_BASE;
        }
        Some(())
    }

    fn multiply_power_small(&mut self, factor: u32, mut exponent: i32) -> Option<()> {
        if exponent < 0 || factor < 2 {
            return None;
        }

        let mut chunk = factor;
        let mut chunk_exponent = 1;
        while let Some(next) = chunk.checked_mul(factor) {
            chunk = next;
            chunk_exponent += 1;
        }
        while exponent >= chunk_exponent {
            self.multiply_small(chunk)?;
            exponent -= chunk_exponent;
        }
        for _ in 0..exponent {
            self.multiply_small(factor)?;
        }
        Some(())
    }

    fn compare(&self, other: &Self) -> core::cmp::Ordering {
        match self.len.cmp(&other.len) {
            core::cmp::Ordering::Equal => {
                for index in (0..self.len).rev() {
                    match self.limbs[index].cmp(&other.limbs[index]) {
                        core::cmp::Ordering::Equal => {}
                        ordering => return ordering,
                    }
                }
                core::cmp::Ordering::Equal
            }
            ordering => ordering,
        }
    }

    fn subtract(&mut self, other: &Self) -> Option<()> {
        if self.compare(other).is_lt() {
            return None;
        }
        let mut borrow = 0i64;
        for index in 0..self.len {
            let right = if index < other.len {
                other.limbs[index] as i64
            } else {
                0
            };
            let difference = self.limbs[index] as i64 - right - borrow;
            if difference < 0 {
                self.limbs[index] = (difference + BIG_BASE as i64) as u32;
                borrow = 1;
            } else {
                self.limbs[index] = difference as u32;
                borrow = 0;
            }
        }
        if borrow != 0 {
            return None;
        }
        while self.len != 0 && self.limbs[self.len - 1] == 0 {
            self.len -= 1;
        }
        Some(())
    }

    fn compare_sum(&self, addend: &Self, other: &Self) -> core::cmp::Ordering {
        let max_len = self.len.max(addend.len).max(other.len);
        let mut carry = 0u64;
        let mut ordering = core::cmp::Ordering::Equal;
        for index in 0..max_len {
            let left = if index < self.len {
                self.limbs[index] as u64
            } else {
                0
            } + if index < addend.len {
                addend.limbs[index] as u64
            } else {
                0
            } + carry;
            let limb = (left % BIG_BASE) as u32;
            carry = left / BIG_BASE;
            let right = if index < other.len {
                other.limbs[index]
            } else {
                0
            };
            match limb.cmp(&right) {
                core::cmp::Ordering::Equal => {}
                current => ordering = current,
            }
        }
        if carry != 0 {
            core::cmp::Ordering::Greater
        } else {
            ordering
        }
    }

    fn compare_twice(&self, other: &Self) -> core::cmp::Ordering {
        let max_len = self.len.max(other.len);
        let mut carry = 0u64;
        let mut ordering = core::cmp::Ordering::Equal;
        for index in 0..max_len {
            let left = if index < self.len {
                self.limbs[index] as u64 * 2
            } else {
                0
            } + carry;
            let limb = (left % BIG_BASE) as u32;
            carry = left / BIG_BASE;
            let right = if index < other.len {
                other.limbs[index]
            } else {
                0
            };
            match limb.cmp(&right) {
                core::cmp::Ordering::Equal => {}
                current => ordering = current,
            }
        }
        if carry != 0 {
            core::cmp::Ordering::Greater
        } else {
            ordering
        }
    }

    fn decimal_digits(&self, out: &mut [u8; EXACT_DIGITS]) -> Option<usize> {
        if self.len == 0 {
            out[0] = b'0';
            return Some(1);
        }

        let mut writer = ByteWriter::<EXACT_DIGITS>::new();
        if !push_u32(&mut writer, self.limbs[self.len - 1]) {
            return None;
        }
        for index in (0..self.len - 1).rev() {
            let limb = self.limbs[index];
            let mut divisor = 100_000_000u32;
            while divisor != 0 {
                if !writer.push(b'0' + ((limb / divisor) % 10) as u8) {
                    return None;
                }
                divisor /= 10;
            }
        }
        out[..writer.len].copy_from_slice(writer.as_bytes());
        Some(writer.len)
    }
}

struct ExactDecimal {
    digits: [u8; EXACT_DIGITS],
    len: usize,
    exponent: i32,
}

impl ExactDecimal {
    fn from_f64(value: f64) -> Option<Self> {
        if !value.is_finite() || value <= 0.0 {
            return None;
        }

        let bits = value.to_bits();
        let raw_exponent = ((bits >> 52) & 0x7ff) as i32;
        let fraction = bits & ((1u64 << 52) - 1);
        let (significand, exponent2) = if raw_exponent == 0 {
            (fraction, -1074)
        } else {
            (fraction | (1u64 << 52), raw_exponent - 1023 - 52)
        };
        if significand == 0 {
            return None;
        }

        let mut integer = BigNat::from_u64(significand);
        let decimal_scale;
        if exponent2 >= 0 {
            decimal_scale = 0;
            let mut remaining = exponent2;
            while remaining >= 31 {
                integer.multiply_small(1u32 << 31)?;
                remaining -= 31;
            }
            if remaining != 0 {
                integer.multiply_small(1u32 << remaining)?;
            }
        } else {
            decimal_scale = -exponent2;
            let mut remaining = decimal_scale;
            while remaining >= 13 {
                // 5^13 fits in u32, while a base-1e9 limb product still fits
                // in u64. Chunking avoids ~1,000 limb walks for subnormals.
                integer.multiply_small(1_220_703_125)?;
                remaining -= 13;
            }
            for _ in 0..remaining {
                integer.multiply_small(5)?;
            }
        }

        let mut digits = [0u8; EXACT_DIGITS];
        let len = integer.decimal_digits(&mut digits)?;
        Some(Self {
            digits,
            len,
            exponent: len as i32 - decimal_scale - 1,
        })
    }

    fn round_significant(&mut self, keep: usize) -> Option<()> {
        if keep == 0 || keep >= EXACT_DIGITS {
            return None;
        }
        if keep >= self.len {
            self.digits[self.len..keep].fill(b'0');
            self.len = keep;
            return Some(());
        }

        let round_up = self.digits[keep] >= b'5';
        self.len = keep;
        if !round_up {
            return Some(());
        }

        for index in (0..keep).rev() {
            if self.digits[index] != b'9' {
                self.digits[index] += 1;
                return Some(());
            }
            self.digits[index] = b'0';
        }
        self.digits[0] = b'1';
        self.digits[1..keep].fill(b'0');
        self.exponent += 1;
        Some(())
    }
}

struct BinaryInterval {
    value: BigNat,
    denominator: BigNat,
    lower_margin: BigNat,
    upper_margin: BigNat,
    inclusive: bool,
}

impl BinaryInterval {
    fn from_f64(value: f64) -> Option<Self> {
        if !value.is_finite() || value <= 0.0 {
            return None;
        }

        let bits = value.to_bits();
        let raw_exponent = ((bits >> 52) & 0x7ff) as i32;
        let fraction = bits & ((1u64 << 52) - 1);
        let (significand, exponent2) = if raw_exponent == 0 {
            (fraction, -1074)
        } else {
            (fraction | (1u64 << 52), raw_exponent - 1023 - 52)
        };
        if significand == 0 {
            return None;
        }

        // At an exact normal power of two (except the minimum normal), the
        // predecessor is half as far away as the successor. Express x and both
        // midpoint margins in units of the smaller half-ULP. Everywhere else
        // the two margins are equal. A midpoint belongs to x exactly when x's
        // significand is even, matching IEEE roundTiesToEven.
        let asymmetric = raw_exponent > 1 && fraction == 0;
        let coefficient_shift = if asymmetric { 2 } else { 1 };
        let binary_scale = exponent2 - coefficient_shift;
        let mut interval = Self {
            value: BigNat::from_u64(significand << coefficient_shift),
            denominator: BigNat::from_u64(1),
            lower_margin: BigNat::from_u64(1),
            upper_margin: BigNat::from_u64(if asymmetric { 2 } else { 1 }),
            inclusive: significand & 1 == 0,
        };
        if binary_scale >= 0 {
            interval.value.multiply_power_small(2, binary_scale)?;
            interval
                .lower_margin
                .multiply_power_small(2, binary_scale)?;
            interval
                .upper_margin
                .multiply_power_small(2, binary_scale)?;
        } else {
            interval
                .denominator
                .multiply_power_small(2, -binary_scale)?;
        }
        Some(interval)
    }
}

fn increment_radix_digits(
    digits: &mut [u8; RADIX_DIGITS],
    len: &mut usize,
    exponent: &mut i32,
    radix: u8,
) -> Option<()> {
    for index in (0..*len).rev() {
        if digits[index] + 1 < radix {
            digits[index] += 1;
            return Some(());
        }
        digits[index] = 0;
    }
    if *len == RADIX_DIGITS {
        return None;
    }
    digits.copy_within(0..*len, 1);
    digits[0] = 1;
    *len += 1;
    *exponent += 1;
    Some(())
}

fn radix_digit(value: u8) -> u8 {
    if value < 10 {
        b'0' + value
    } else {
        b'a' + value - 10
    }
}

fn append_radix_parity(parity: u8, digit: u8, radix: u8) -> u8 {
    (parity * (radix & 1) + (digit & 1)) & 1
}

/// Dragon-style shortest formatting for a non-decimal radix. The exact binary
/// value and its two round-to-nearest boundaries are scaled into [1, radix),
/// then digits are emitted until either adjacent radix integer lies inside the
/// rounding interval. This directly enforces Number::toString's minimal-k rule;
/// no digit cap or floating-point multiply loop participates in the result.
fn format_radix(value: f64, radix: i32) -> Option<ByteWriter<RADIX_BYTES>> {
    if !value.is_finite() || !(2..=36).contains(&radix) {
        return None;
    }

    let mut out = ByteWriter::<RADIX_BYTES>::new();
    if value == 0.0 {
        out.push(b'0');
        return Some(out);
    }

    let negative = value.is_sign_negative();
    let magnitude = value.abs();
    let radix_u32 = radix as u32;
    let radix_u8 = radix as u8;
    let mut interval = BinaryInterval::from_f64(magnitude)?;

    // The logarithm only selects a near starting scale. Exact bigint
    // comparisons below correct either adjacent-power rounding direction.
    let mut exponent = magnitude.log(radix as f64).floor() as i32 + 1;
    if exponent > 1 {
        interval
            .denominator
            .multiply_power_small(radix_u32, exponent - 1)?;
    } else if exponent < 1 {
        let scale = 1 - exponent;
        interval.value.multiply_power_small(radix_u32, scale)?;
        interval
            .lower_margin
            .multiply_power_small(radix_u32, scale)?;
        interval
            .upper_margin
            .multiply_power_small(radix_u32, scale)?;
    }

    loop {
        let mut next_denominator = interval.denominator.clone();
        next_denominator.multiply_small(radix_u32)?;
        if interval.value.compare(&next_denominator).is_lt() {
            break;
        }
        interval.denominator = next_denominator;
        exponent += 1;
    }
    while interval.value.compare(&interval.denominator).is_lt() {
        interval.value.multiply_small(radix_u32)?;
        interval.lower_margin.multiply_small(radix_u32)?;
        interval.upper_margin.multiply_small(radix_u32)?;
        exponent -= 1;
    }

    let mut digits = [0u8; RADIX_DIGITS];
    let mut len = 0usize;
    let mut candidate_parity = 0u8;
    loop {
        if len == digits.len() {
            return None;
        }
        let mut digit = 0u8;
        while !interval.value.compare(&interval.denominator).is_lt() {
            interval.value.subtract(&interval.denominator)?;
            digit += 1;
        }
        if digit >= radix_u8 {
            return None;
        }
        digits[len] = digit;
        len += 1;
        candidate_parity = append_radix_parity(candidate_parity, digit, radix_u8);

        let lower_ordering = interval.value.compare(&interval.lower_margin);
        let low =
            lower_ordering.is_lt() || (interval.inclusive && lower_ordering == Ordering::Equal);
        let upper_ordering = interval
            .value
            .compare_sum(&interval.upper_margin, &interval.denominator);
        let high =
            upper_ordering.is_gt() || (interval.inclusive && upper_ordering == Ordering::Equal);
        if low || high {
            let round_up = if low && high {
                match interval.value.compare_twice(&interval.denominator) {
                    Ordering::Less => false,
                    Ordering::Greater => true,
                    Ordering::Equal => candidate_parity != 0,
                }
            } else {
                high
            };
            if round_up {
                increment_radix_digits(&mut digits, &mut len, &mut exponent, radix_u8)?;
            }
            while len > 1 && digits[len - 1] == 0 {
                len -= 1;
            }
            break;
        }

        interval.value.multiply_small(radix_u32)?;
        interval.lower_margin.multiply_small(radix_u32)?;
        interval.upper_margin.multiply_small(radix_u32)?;
    }

    if negative && !out.push(b'-') {
        return None;
    }
    if exponent >= len as i32 {
        for &digit in &digits[..len] {
            if !out.push(radix_digit(digit)) {
                return None;
            }
        }
        for _ in 0..exponent - len as i32 {
            if !out.push(b'0') {
                return None;
            }
        }
    } else if exponent > 0 {
        let split = exponent as usize;
        for &digit in &digits[..split] {
            if !out.push(radix_digit(digit)) {
                return None;
            }
        }
        if !out.push(b'.') {
            return None;
        }
        for &digit in &digits[split..len] {
            if !out.push(radix_digit(digit)) {
                return None;
            }
        }
    } else {
        if !out.extend(b"0.") {
            return None;
        }
        for _ in 0..-exponent {
            if !out.push(b'0') {
                return None;
            }
        }
        for &digit in &digits[..len] {
            if !out.push(radix_digit(digit)) {
                return None;
            }
        }
    }
    Some(out)
}

fn write_sign<const N: usize>(out: &mut ByteWriter<N>, value: f64) -> bool {
    value >= 0.0 || value == 0.0 || out.push(b'-')
}

fn format_fixed(value: f64, fraction_digits: i32) -> Option<ByteWriter<RESULT_BYTES>> {
    if !value.is_finite() || !(0..=100).contains(&fraction_digits) {
        return None;
    }

    let mut out = ByteWriter::<RESULT_BYTES>::new();
    if !write_sign(&mut out, value) {
        return None;
    }

    let f = fraction_digits as usize;
    let mut rounded = [0u8; 128];
    let rounded_len;
    if value == 0.0 || value.abs() < 1e-101 {
        // Even at the maximum accepted 100 fraction digits, every magnitude
        // below 1e-101 is strictly below the 5e-101 half-expand threshold.
        // This covers all subnormals (and other guaranteed-zero tiny values)
        // without constructing their ~1,000-digit exact decimal expansion.
        rounded[0] = b'0';
        rounded_len = 1;
    } else {
        let exact = ExactDecimal::from_f64(value.abs())?;
        let retain = exact.exponent + 1 + fraction_digits;
        if retain < 0 {
            rounded[0] = b'0';
            rounded_len = 1;
        } else if retain == 0 {
            if exact.digits[0] >= b'5' {
                rounded[0] = b'1';
            } else {
                rounded[0] = b'0';
            }
            rounded_len = 1;
        } else {
            let retain = retain as usize;
            if retain >= rounded.len() {
                return None;
            }
            let copied = retain.min(exact.len);
            rounded[..copied].copy_from_slice(&exact.digits[..copied]);
            rounded[copied..retain].fill(b'0');
            rounded_len = if retain < exact.len && exact.digits[retain] >= b'5' {
                let mut carry_at = None;
                for index in (0..retain).rev() {
                    if rounded[index] != b'9' {
                        rounded[index] += 1;
                        carry_at = Some(index);
                        break;
                    }
                    rounded[index] = b'0';
                }
                if carry_at.is_none() {
                    rounded.copy_within(0..retain, 1);
                    rounded[0] = b'1';
                    retain + 1
                } else {
                    retain
                }
            } else {
                retain
            };
        }
    }

    if f == 0 {
        if !out.extend(&rounded[..rounded_len]) {
            return None;
        }
    } else if rounded_len <= f {
        if !out.extend(b"0.") {
            return None;
        }
        for _ in 0..f - rounded_len {
            if !out.push(b'0') {
                return None;
            }
        }
        if !out.extend(&rounded[..rounded_len]) {
            return None;
        }
    } else {
        let split = rounded_len - f;
        if !out.extend(&rounded[..split])
            || !out.push(b'.')
            || !out.extend(&rounded[split..rounded_len])
        {
            return None;
        }
    }
    Some(out)
}

fn format_exponential(value: f64, fraction_digits: i32) -> Option<ByteWriter<RESULT_BYTES>> {
    if !value.is_finite() || !(0..=100).contains(&fraction_digits) {
        return None;
    }
    let keep = fraction_digits as usize + 1;
    let mut exact = if value == 0.0 {
        let mut zero = ExactDecimal {
            digits: [0; EXACT_DIGITS],
            len: keep,
            exponent: 0,
        };
        zero.digits[..keep].fill(b'0');
        zero
    } else {
        let mut exact = ExactDecimal::from_f64(value.abs())?;
        exact.round_significant(keep)?;
        exact
    };
    if exact.len < keep {
        exact.digits[exact.len..keep].fill(b'0');
        exact.len = keep;
    }

    let mut out = ByteWriter::<RESULT_BYTES>::new();
    if !write_sign(&mut out, value) || !out.push(exact.digits[0]) {
        return None;
    }
    if fraction_digits > 0 && (!out.push(b'.') || !out.extend(&exact.digits[1..keep])) {
        return None;
    }
    if !push_signed_exponent(&mut out, exact.exponent) {
        return None;
    }
    Some(out)
}

fn format_precision(value: f64, precision: i32) -> Option<ByteWriter<RESULT_BYTES>> {
    if !value.is_finite() || !(1..=100).contains(&precision) {
        return None;
    }
    let keep = precision as usize;
    let mut exact = if value == 0.0 {
        let mut zero = ExactDecimal {
            digits: [0; EXACT_DIGITS],
            len: keep,
            exponent: 0,
        };
        zero.digits[..keep].fill(b'0');
        zero
    } else {
        let mut exact = ExactDecimal::from_f64(value.abs())?;
        exact.round_significant(keep)?;
        exact
    };
    if exact.len < keep {
        exact.digits[exact.len..keep].fill(b'0');
        exact.len = keep;
    }

    let mut out = ByteWriter::<RESULT_BYTES>::new();
    if !write_sign(&mut out, value) {
        return None;
    }
    if exact.exponent < -6 || exact.exponent >= precision {
        if !out.push(exact.digits[0]) {
            return None;
        }
        if precision > 1 && (!out.push(b'.') || !out.extend(&exact.digits[1..keep])) {
            return None;
        }
        if !push_signed_exponent(&mut out, exact.exponent) {
            return None;
        }
    } else if exact.exponent >= 0 {
        let integer_digits = exact.exponent as usize + 1;
        if !out.extend(&exact.digits[..integer_digits]) {
            return None;
        }
        if keep > integer_digits
            && (!out.push(b'.') || !out.extend(&exact.digits[integer_digits..keep]))
        {
            return None;
        }
    } else {
        if !out.extend(b"0.") {
            return None;
        }
        for _ in 0..(-exact.exponent - 1) {
            if !out.push(b'0') {
                return None;
            }
        }
        if !out.extend(&exact.digits[..keep]) {
            return None;
        }
    }
    Some(out)
}

unsafe fn copy_result(bytes: &[u8], out: *mut u8, out_cap: i32) -> i32 {
    if !out.is_null() && out_cap > 0 {
        let written = bytes.len().min(out_cap as usize);
        unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), out, written) };
    }
    bytes.len() as i32
}

#[no_mangle]
pub unsafe extern "C" fn mal_number_format_shortest(value: f64, out: *mut u8, out_cap: i32) -> i32 {
    match format_shortest(value, false) {
        Some(value) => unsafe { copy_result(value.as_bytes(), out, out_cap) },
        None => -1,
    }
}

#[no_mangle]
pub unsafe extern "C" fn mal_number_format_shortest_exponential(
    value: f64,
    out: *mut u8,
    out_cap: i32,
) -> i32 {
    match format_shortest(value, true) {
        Some(value) => unsafe { copy_result(value.as_bytes(), out, out_cap) },
        None => -1,
    }
}

#[no_mangle]
pub unsafe extern "C" fn mal_number_format_radix(
    value: f64,
    radix: i32,
    out: *mut u8,
    out_cap: i32,
) -> i32 {
    match format_radix(value, radix) {
        Some(value) => unsafe { copy_result(value.as_bytes(), out, out_cap) },
        None => -1,
    }
}

#[no_mangle]
pub unsafe extern "C" fn mal_number_format_fixed(
    value: f64,
    fraction_digits: i32,
    out: *mut u8,
    out_cap: i32,
) -> i32 {
    match format_fixed(value, fraction_digits) {
        Some(value) => unsafe { copy_result(value.as_bytes(), out, out_cap) },
        None => -1,
    }
}

#[no_mangle]
pub unsafe extern "C" fn mal_number_format_exponential(
    value: f64,
    fraction_digits: i32,
    out: *mut u8,
    out_cap: i32,
) -> i32 {
    match format_exponential(value, fraction_digits) {
        Some(value) => unsafe { copy_result(value.as_bytes(), out, out_cap) },
        None => -1,
    }
}

#[no_mangle]
pub unsafe extern "C" fn mal_number_format_precision(
    value: f64,
    precision: i32,
    out: *mut u8,
    out_cap: i32,
) -> i32 {
    match format_precision(value, precision) {
        Some(value) => unsafe { copy_result(value.as_bytes(), out, out_cap) },
        None => -1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text<const N: usize>(value: ByteWriter<N>) -> String {
        String::from_utf8(value.as_bytes().to_vec()).unwrap()
    }

    #[test]
    fn shortest_uses_ecmascript_decimal_thresholds() {
        assert_eq!(text(format_shortest(1.2, false).unwrap()), "1.2");
        assert_eq!(
            text(format_shortest(1e20, false).unwrap()),
            "100000000000000000000"
        );
        assert_eq!(text(format_shortest(1e21, false).unwrap()), "1e+21");
        assert_eq!(text(format_shortest(1e-6, false).unwrap()), "0.000001");
        assert_eq!(text(format_shortest(1e-7, false).unwrap()), "1e-7");
        assert_eq!(text(format_shortest(-0.0, false).unwrap()), "0");
        assert_eq!(
            text(format_shortest(f64::MAX, false).unwrap()),
            "1.7976931348623157e+308"
        );
        assert_eq!(
            text(format_shortest(f64::MIN_POSITIVE, false).unwrap()),
            "2.2250738585072014e-308"
        );
        assert_eq!(
            text(format_shortest(-(553_675_004_028_197.0 / 16.0), false).unwrap()),
            "-34604687751762.312"
        );
        assert_eq!(
            text(format_shortest(553_675_004_028_199.0 / 16.0, false).unwrap()),
            "34604687751762.438"
        );
    }

    #[test]
    fn shortest_exponential_has_a_mandatory_exponent_sign() {
        assert_eq!(text(format_shortest(77.0, true).unwrap()), "7.7e+1");
        assert_eq!(text(format_shortest(0.0, true).unwrap()), "0e+0");
        assert_eq!(text(format_shortest(0.001, true).unwrap()), "1e-3");
    }

    #[test]
    fn arbitrary_radix_uses_the_shortest_round_tripping_interval() {
        assert_eq!(
            text(format_radix(0.1, 3).unwrap()),
            "0.0022002200220022002200220022002201"
        );
        assert_eq!(
            text(format_radix(core::f64::consts::PI, 16).unwrap()),
            "3.243f6a8885a3"
        );
        assert_eq!(
            text(format_radix(-0.1, 7).unwrap()),
            "-0.04620462046204620463"
        );
        assert_eq!(
            text(format_radix(9_007_199_254_740_992.0, 16).unwrap()),
            "20000000000000"
        );
        assert_eq!(
            text(format_radix(1.0000000000000002, 2).unwrap()),
            "1.0000000000000000000000000000000000000000000000000001"
        );
        for radix in 2..=36 {
            assert_eq!(text(format_radix(1.0, radix).unwrap()), "1");
            assert_eq!(text(format_radix(radix as f64, radix).unwrap()), "10");
            assert_eq!(text(format_radix(-(radix as f64), radix).unwrap()), "-10");
        }
    }

    #[test]
    fn arbitrary_radix_handles_binary_range_boundaries() {
        let minimum_binary = text(format_radix(f64::from_bits(1), 2).unwrap());
        assert_eq!(minimum_binary.len(), 1076);
        assert!(minimum_binary.starts_with("0."));
        assert!(minimum_binary[2..minimum_binary.len() - 1]
            .bytes()
            .all(|byte| byte == b'0'));
        assert!(minimum_binary.ends_with('1'));

        let maximum_binary = text(format_radix(f64::MAX, 2).unwrap());
        assert_eq!(maximum_binary.len(), 1024);
        assert!(maximum_binary[..53].bytes().all(|byte| byte == b'1'));
        assert!(maximum_binary[53..].bytes().all(|byte| byte == b'0'));
    }

    #[test]
    fn arbitrary_radix_tracks_whole_integer_parity_and_reports_full_length() {
        // In odd radices the last digit alone does not determine whether the
        // candidate integer is even: base-3 "12" is five, while "20" is six.
        assert_eq!(append_radix_parity(append_radix_parity(0, 1, 3), 2, 3), 1);
        assert_eq!(append_radix_parity(append_radix_parity(0, 2, 3), 0, 3), 0);

        let expected = "0.0022002200220022002200220022002201";
        let mut prefix = [0u8; 4];
        let length =
            unsafe { mal_number_format_radix(0.1, 3, prefix.as_mut_ptr(), prefix.len() as i32) };
        assert_eq!(length as usize, expected.len());
        assert_eq!(&prefix, &expected.as_bytes()[..prefix.len()]);
    }

    #[test]
    fn bigint_power_scaling_crosses_chunk_boundaries_exactly() {
        let mut power_of_two = BigNat::from_u64(1);
        power_of_two.multiply_power_small(2, 63).unwrap();
        assert_eq!(
            power_of_two.compare(&BigNat::from_u64(1u64 << 63)),
            Ordering::Equal
        );

        let mut power_of_five = BigNat::from_u64(1);
        power_of_five.multiply_power_small(5, 20).unwrap();
        assert_eq!(
            power_of_five.compare(&BigNat::from_u64(95_367_431_640_625)),
            Ordering::Equal
        );
    }

    #[test]
    fn fixed_uses_exact_half_expand_rounding() {
        assert_eq!(text(format_fixed(2.5, 0).unwrap()), "3");
        assert_eq!(text(format_fixed(-2.5, 0).unwrap()), "-3");
        assert_eq!(text(format_fixed(1.25, 1).unwrap()), "1.3");
        assert_eq!(text(format_fixed(1.005, 2).unwrap()), "1.00");
        assert_eq!(text(format_fixed(0.0001, 2).unwrap()), "0.00");
        assert_eq!(text(format_fixed(999.5, 0).unwrap()), "1000");
        assert_eq!(text(format_fixed(-0.0, 2).unwrap()), "0.00");
        assert_eq!(
            text(format_fixed(f64::from_bits(1), 100).unwrap()),
            format!("0.{}", "0".repeat(100))
        );
        assert_eq!(
            text(format_fixed(-f64::from_bits(1), 100).unwrap()),
            format!("-0.{}", "0".repeat(100))
        );
    }

    #[test]
    fn explicit_exponential_uses_exact_half_expand_rounding() {
        assert_eq!(text(format_exponential(25.0, 0).unwrap()), "3e+1");
        assert_eq!(text(format_exponential(1.25, 1).unwrap()), "1.3e+0");
        assert_eq!(text(format_exponential(0.0, 3).unwrap()), "0.000e+0");
        assert_eq!(text(format_exponential(-0.0, 0).unwrap()), "0e+0");
    }

    #[test]
    fn precision_selects_fixed_or_exponential_after_rounding() {
        assert_eq!(text(format_precision(25.0, 1).unwrap()), "3e+1");
        assert_eq!(text(format_precision(123.0, 5).unwrap()), "123.00");
        assert_eq!(text(format_precision(0.00000123, 2).unwrap()), "0.0000012");
        assert_eq!(text(format_precision(0.000000123, 2).unwrap()), "1.2e-7");
        assert_eq!(text(format_precision(0.0, 4).unwrap()), "0.000");
        assert_eq!(text(format_precision(-0.0, 2).unwrap()), "0.0");
    }
}
