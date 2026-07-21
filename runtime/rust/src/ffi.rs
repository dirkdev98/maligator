//! Shared primitives at the C ABI boundary.

/// Build a slice from a nullable `(ptr, len)` pair. A null pointer is accepted
/// only for the empty slice; non-empty inputs must satisfy the ordinary
/// `from_raw_parts` validity requirements.
#[cfg(any(test, feature = "intl", feature = "regexp", feature = "web-platform"))]
pub(crate) unsafe fn nullable_slice<'a, T>(ptr: *const T, len: usize) -> &'a [T] {
    if len == 0 {
        &[]
    } else {
        unsafe { core::slice::from_raw_parts(ptr, len) }
    }
}

#[cfg(any(test, feature = "intl", feature = "regexp", feature = "web-platform"))]
pub(crate) unsafe fn nullable_u16_slice<'a>(ptr: *const u16, len: usize) -> &'a [u16] {
    unsafe { nullable_slice(ptr, len) }
}

/// Copy UTF-8 into a caller-owned probe/fill buffer and return the full length.
/// A null output pointer or non-positive capacity is a length probe.
/// When `out_cap` is positive, `out` must be valid for writes of that many bytes.
pub(crate) unsafe fn write_utf8(value: &str, out: *mut u8, out_cap: i32) -> i32 {
    let bytes = value.as_bytes();
    if !out.is_null() && out_cap > 0 {
        let written = bytes.len().min(out_cap as usize);
        unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), out, written) };
    }
    bytes.len() as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_pointer_represents_an_empty_utf16_slice() {
        let slice = unsafe { nullable_u16_slice(core::ptr::null(), 0) };
        assert!(slice.is_empty());
    }

    #[test]
    fn null_pointer_represents_an_empty_generic_slice() {
        let slice: &[u32] = unsafe { nullable_slice(core::ptr::null(), 0) };
        assert!(slice.is_empty());
    }

    #[test]
    fn utf16_slice_transport_does_not_replace_lone_surrogates() {
        let units = [0xd800, b'a' as u16];
        let slice = unsafe { nullable_u16_slice(units.as_ptr(), units.len()) };
        assert_eq!(slice, units);
    }

    #[test]
    fn utf8_output_supports_probe_partial_and_full_fill() {
        assert_eq!(unsafe { write_utf8("aé", core::ptr::null_mut(), 0) }, 3);

        let mut partial = [0u8; 2];
        assert_eq!(unsafe { write_utf8("aé", partial.as_mut_ptr(), 2) }, 3);
        assert_eq!(partial, [b'a', 0xc3]);

        let mut full = [0u8; 3];
        assert_eq!(unsafe { write_utf8("aé", full.as_mut_ptr(), 3) }, 3);
        assert_eq!(full, [b'a', 0xc3, 0xa9]);
    }
}
