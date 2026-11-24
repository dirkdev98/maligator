//! WHATWG URL primitives over Ada's C ABI. The Rust crate builds the C++
//! archive. The runtime owns JS coercion and errors, and URLSearchParams is
//! implemented on the C side. Buffer ownership stays with the producer.

extern crate ada_url as _;

use alloc::string::String;
use core::ffi::c_void;

use crate::ffi::{nullable_slice, nullable_u16_slice, write_utf8};

/// ABI version, mirrored by MAL_URL_ABI_VERSION in mal_url.h.
pub const MAL_URL_ABI_VERSION: u32 = 1;

#[no_mangle]
pub extern "C" fn mal_url_abi_version() -> u32 {
    MAL_URL_ABI_VERSION
}

#[repr(C)]
struct AdaString {
    data: *const u8,
    length: usize,
}

impl AdaString {
    unsafe fn write(&self, output: *mut u8, capacity: i32) -> i32 {
        let bytes = unsafe { nullable_slice(self.data, self.length) };
        let text = unsafe { core::str::from_utf8_unchecked(bytes) };
        unsafe { write_utf8(text, output, capacity) }
    }
}

extern "C" {
    fn ada_parse(input: *const u8, length: usize) -> *mut c_void;
    fn ada_parse_with_base(
        input: *const u8,
        length: usize,
        base: *const u8,
        base_length: usize,
    ) -> *mut c_void;
    fn ada_is_valid(url: *mut c_void) -> bool;
    fn ada_can_parse(input: *const u8, length: usize) -> bool;
    fn ada_can_parse_with_base(
        input: *const u8,
        length: usize,
        base: *const u8,
        base_length: usize,
    ) -> bool;
    fn ada_free(url: *mut c_void);
    fn ada_free_owned_string(value: AdaString);
    fn ada_get_origin(url: *mut c_void) -> AdaString;
    fn ada_idna_to_unicode(input: *const u8, length: usize) -> AdaString;
    fn ada_clear_port(url: *mut c_void);
    fn ada_set_port(url: *mut c_void, input: *const u8, length: usize) -> bool;
    fn ada_set_hostname(url: *mut c_void, input: *const u8, length: usize) -> bool;
    fn ada_get_hostname(url: *mut c_void) -> AdaString;
}

unsafe fn utf16_to_string(ptr: *const u16, len: usize) -> String {
    String::from_utf16_lossy(unsafe { nullable_u16_slice(ptr, len) })
}

#[no_mangle]
pub unsafe extern "C" fn mal_url_parse(
    input: *const u16,
    input_len: usize,
    base: *const u16,
    base_len: usize,
    has_base: bool,
) -> *mut c_void {
    let input = unsafe { utf16_to_string(input, input_len) };
    let url = if has_base {
        let base = unsafe { utf16_to_string(base, base_len) };
        unsafe { ada_parse_with_base(input.as_ptr(), input.len(), base.as_ptr(), base.len()) }
    } else {
        unsafe { ada_parse(input.as_ptr(), input.len()) }
    };
    if unsafe { ada_is_valid(url) } {
        url
    } else {
        unsafe { ada_free(url) };
        core::ptr::null_mut()
    }
}

#[no_mangle]
pub unsafe extern "C" fn mal_url_can_parse(
    input: *const u16,
    input_len: usize,
    base: *const u16,
    base_len: usize,
    has_base: bool,
) -> bool {
    let input = unsafe { utf16_to_string(input, input_len) };
    if has_base {
        let base = unsafe { utf16_to_string(base, base_len) };
        unsafe { ada_can_parse_with_base(input.as_ptr(), input.len(), base.as_ptr(), base.len()) }
    } else {
        unsafe { ada_can_parse(input.as_ptr(), input.len()) }
    }
}

#[no_mangle]
pub unsafe extern "C" fn mal_url_free(handle: *mut c_void) {
    if !handle.is_null() {
        unsafe { ada_free(handle) };
    }
}

macro_rules! url_getter {
    ($name:ident, $method:ident) => {
        #[no_mangle]
        pub unsafe extern "C" fn $name(handle: *mut c_void, out: *mut u8, capacity: i32) -> i32 {
            extern "C" {
                fn $method(url: *mut c_void) -> AdaString;
            }
            unsafe { $method(handle).write(out, capacity) }
        }
    };
}

url_getter!(mal_url_href, ada_get_href);
url_getter!(mal_url_protocol, ada_get_protocol);
url_getter!(mal_url_username, ada_get_username);
url_getter!(mal_url_password, ada_get_password);
url_getter!(mal_url_host, ada_get_host);
url_getter!(mal_url_hostname, ada_get_hostname);
url_getter!(mal_url_port, ada_get_port);
url_getter!(mal_url_pathname, ada_get_pathname);
url_getter!(mal_url_search, ada_get_search);
url_getter!(mal_url_hash, ada_get_hash);

#[no_mangle]
pub unsafe extern "C" fn mal_url_origin(handle: *mut c_void, out: *mut u8, capacity: i32) -> i32 {
    let origin = unsafe { ada_get_origin(handle) };
    let length = unsafe { origin.write(out, capacity) };
    unsafe { ada_free_owned_string(origin) };
    length
}

macro_rules! url_setter {
    ($name:ident, $method:ident $(, $is_null:ident)?) => {
        #[no_mangle]
        pub unsafe extern "C" fn $name(
            handle: *mut c_void,
            input: *const u16,
            length: usize,
            $($is_null: bool,)?
        ) -> bool {
            extern "C" {
                fn $method(url: *mut c_void, input: *const u8, length: usize) -> bool;
            }
            $(if $is_null { return unsafe { $method(handle, b"".as_ptr(), 0) }; })?
            let value = unsafe { utf16_to_string(input, length) };
            unsafe { $method(handle, value.as_ptr(), value.len()) }
        }
    };
}

url_setter!(mal_url_set_href, ada_set_href);
url_setter!(mal_url_set_protocol, ada_set_protocol);
url_setter!(mal_url_set_username, ada_set_username, is_null);
url_setter!(mal_url_set_password, ada_set_password, is_null);
url_setter!(mal_url_set_host, ada_set_host, is_null);
url_setter!(mal_url_set_hostname, ada_set_hostname, is_null);
url_setter!(mal_url_set_pathname, ada_set_pathname, is_null);

#[no_mangle]
pub unsafe extern "C" fn mal_url_set_port(
    handle: *mut c_void,
    input: *const u16,
    length: usize,
    is_null: bool,
) -> bool {
    if is_null {
        unsafe { ada_clear_port(handle) };
        true
    } else {
        let value = unsafe { utf16_to_string(input, length) };
        unsafe { ada_set_port(handle, value.as_ptr(), value.len()) }
    }
}

macro_rules! url_set_suffix {
    ($name:ident, $set:ident, $clear:ident) => {
        #[no_mangle]
        pub unsafe extern "C" fn $name(
            handle: *mut c_void, input: *const u16, length: usize, is_null: bool,
        ) {
            extern "C" {
                fn $set(url: *mut c_void, input: *const u8, length: usize);
                fn $clear(url: *mut c_void);
            }
            if is_null {
                unsafe { $clear(handle) };
            } else {
                let value = unsafe { utf16_to_string(input, length) };
                unsafe { $set(handle, value.as_ptr(), value.len()) };
            }
        }
    };
}

url_set_suffix!(mal_url_set_search, ada_set_search, ada_clear_search);
url_set_suffix!(mal_url_set_hash, ada_set_hash, ada_clear_hash);

/// The ASCII hostname a special URL takes after assignment. The Unicode
/// form additionally applies Ada's UTS #46 conversion.
#[no_mangle]
pub unsafe extern "C" fn mal_url_domain_convert(
    input: *const u16,
    input_len: usize,
    unicode: bool,
    out: *mut u8,
    capacity: i32,
) -> i32 {
    let domain = unsafe { utf16_to_string(input, input_len) };
    if domain.is_empty() {
        return 0;
    }
    let url = unsafe { ada_parse(b"ws://x".as_ptr(), b"ws://x".len()) };
    let length = if unsafe { ada_set_hostname(url, domain.as_ptr(), domain.len()) } {
        let host = unsafe { ada_get_hostname(url) };
        if unicode {
            let owned = unsafe { ada_idna_to_unicode(host.data, host.length) };
            let length = unsafe { owned.write(out, capacity) };
            unsafe { ada_free_owned_string(owned) };
            length
        } else {
            unsafe { host.write(out, capacity) }
        }
    } else {
        0
    };
    unsafe { ada_free(url) };
    length
}
