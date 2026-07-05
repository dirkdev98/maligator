//! WHATWG URL primitives over the `ada-url` crate (which wraps the C++ `ada`
//! library). Lives in the single `mal_rust` staticlib like the regexp/i18n halves
//! (two Rust staticlibs cannot co-link). Because `ada-url` pulls in a C++ library,
//! the final link of every binary needs the C++ stdlib (`-lc++`/`-lstdc++`); that
//! flag is added in `src/rust-build.ts` (`rustLinkArgs`). C ABI is `mal_url.h`.
//!
//! Design contract (same as the other halves): the C runtime owns all JS-spec glue
//! (the URL/URLSearchParams objects, the Symbol protocol, error shaping). This
//! module exposes only a parsed-URL handle + flat component accessors.
//!
//! Strings cross as UTF-16 IN (MalString's native storage → `String::from_utf16_
//! lossy`, since WHATWG operates on scalar values) and UTF-8 OUT (the probe-then-
//! fill `write_str` convention; the C side decodes to a MalString). URLSearchParams
//! is implemented entirely C-side (form-urlencoded), so it needs nothing here.

use ada_url::Url;

/// ABI version, mirrored by MAL_URL_ABI_VERSION in mal_url.h.
pub const MAL_URL_ABI_VERSION: u32 = 1;

/// Returns the ABI version baked into this archive.
#[no_mangle]
pub extern "C" fn mal_url_abi_version() -> u32 {
    MAL_URL_ABI_VERSION
}

/// Build a `&[u16]` from a (ptr, len), tolerating a null ptr when len is 0
/// (`from_raw_parts` is UB on null even for an empty slice).
unsafe fn slice_u16<'a>(ptr: *const u16, len: usize) -> &'a [u16] {
    if len == 0 {
        &[]
    } else {
        unsafe { core::slice::from_raw_parts(ptr, len) }
    }
}

/// UTF-16 (ptr, len) → owned String, lossily (lone surrogates → U+FFFD), matching
/// WHATWG URL's scalar-value handling of input.
unsafe fn utf16_to_string(ptr: *const u16, len: usize) -> String {
    String::from_utf16_lossy(unsafe { slice_u16(ptr, len) })
}

/// Copy `s` (UTF-8) into `out` (at most `out_cap` bytes) and return the full byte
/// length, so the C side can probe with cap 0 then fill.
fn write_str(s: &str, out: *mut u8, out_cap: i32) -> i32 {
    let bytes = s.as_bytes();
    if !out.is_null() && out_cap > 0 {
        let n = bytes.len().min(out_cap as usize);
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, n) };
    }
    bytes.len() as i32
}

unsafe fn url_ref<'a>(handle: *mut core::ffi::c_void) -> &'a Url {
    unsafe { &*(handle as *const Url) }
}

unsafe fn url_mut<'a>(handle: *mut core::ffi::c_void) -> &'a mut Url {
    unsafe { &mut *(handle as *mut Url) }
}

/// Parse `input` (UTF-16), optionally against `base` (UTF-16, used only when
/// `has_base` is nonzero). Returns an opaque boxed `Url` handle, or NULL on a parse
/// failure (the C side throws TypeError). Free with `mal_url_free`.
#[no_mangle]
pub unsafe extern "C" fn mal_url_parse(
    input: *const u16,
    input_len: usize,
    base: *const u16,
    base_len: usize,
    has_base: bool,
) -> *mut core::ffi::c_void {
    let input_str = unsafe { utf16_to_string(input, input_len) };
    let base_str = if has_base {
        Some(unsafe { utf16_to_string(base, base_len) })
    } else {
        None
    };
    match Url::parse(input_str, base_str.as_deref()) {
        Ok(url) => Box::into_raw(Box::new(url)) as *mut core::ffi::c_void,
        Err(_) => core::ptr::null_mut(),
    }
}

/// URL.canParse(input, base?): whether parsing would succeed, without allocating a
/// handle.
#[no_mangle]
pub unsafe extern "C" fn mal_url_can_parse(
    input: *const u16,
    input_len: usize,
    base: *const u16,
    base_len: usize,
    has_base: bool,
) -> bool {
    let input_str = unsafe { utf16_to_string(input, input_len) };
    let base_str = if has_base {
        Some(unsafe { utf16_to_string(base, base_len) })
    } else {
        None
    };
    Url::can_parse(&input_str, base_str.as_deref())
}

/// Free a handle from `mal_url_parse` (null-tolerant, so the GC finalizer is
/// idempotent after nulling the field).
#[no_mangle]
pub unsafe extern "C" fn mal_url_free(handle: *mut core::ffi::c_void) {
    if handle.is_null() {
        return;
    }
    drop(unsafe { Box::from_raw(handle as *mut Url) });
}

/// Define a `&str` component getter: writes UTF-8 into `out` (probe with cap 0),
/// returns the full byte length.
macro_rules! url_getter {
    ($name:ident, $method:ident) => {
        #[no_mangle]
        pub unsafe extern "C" fn $name(
            handle: *mut core::ffi::c_void,
            out: *mut u8,
            out_cap: i32,
        ) -> i32 {
            write_str(unsafe { url_ref(handle) }.$method(), out, out_cap)
        }
    };
}

url_getter!(mal_url_href, href);
url_getter!(mal_url_protocol, protocol);
url_getter!(mal_url_username, username);
url_getter!(mal_url_password, password);
url_getter!(mal_url_host, host);
url_getter!(mal_url_hostname, hostname);
url_getter!(mal_url_port, port);
url_getter!(mal_url_pathname, pathname);
url_getter!(mal_url_search, search);
url_getter!(mal_url_hash, hash);

/// origin is computed (returns an owned String), so it needs its own body.
#[no_mangle]
pub unsafe extern "C" fn mal_url_origin(
    handle: *mut core::ffi::c_void,
    out: *mut u8,
    out_cap: i32,
) -> i32 {
    write_str(&unsafe { url_ref(handle) }.origin(), out, out_cap)
}

/// Define a setter taking a plain string (`set_href`/`set_protocol`). Returns
/// whether ada accepted it.
macro_rules! url_setter_str {
    ($name:ident, $method:ident) => {
        #[no_mangle]
        pub unsafe extern "C" fn $name(
            handle: *mut core::ffi::c_void,
            value: *const u16,
            value_len: usize,
        ) -> bool {
            let v = unsafe { utf16_to_string(value, value_len) };
            unsafe { url_mut(handle) }.$method(&v).is_ok()
        }
    };
}

url_setter_str!(mal_url_set_href, set_href);
url_setter_str!(mal_url_set_protocol, set_protocol);

/// Define a setter taking `Option<&str>` (an empty value clears the component when
/// `is_null` is set). Returns whether ada accepted it.
macro_rules! url_setter_opt {
    ($name:ident, $method:ident) => {
        #[no_mangle]
        pub unsafe extern "C" fn $name(
            handle: *mut core::ffi::c_void,
            value: *const u16,
            value_len: usize,
            is_null: bool,
        ) -> bool {
            let v = if is_null {
                None
            } else {
                Some(unsafe { utf16_to_string(value, value_len) })
            };
            unsafe { url_mut(handle) }.$method(v.as_deref()).is_ok()
        }
    };
}

url_setter_opt!(mal_url_set_username, set_username);
url_setter_opt!(mal_url_set_password, set_password);
url_setter_opt!(mal_url_set_host, set_host);
url_setter_opt!(mal_url_set_hostname, set_hostname);
url_setter_opt!(mal_url_set_port, set_port);
url_setter_opt!(mal_url_set_pathname, set_pathname);

/// set_search / set_hash return () in ada (they always accept); expose as void.
#[no_mangle]
pub unsafe extern "C" fn mal_url_set_search(
    handle: *mut core::ffi::c_void,
    value: *const u16,
    value_len: usize,
    is_null: bool,
) {
    let v = if is_null {
        None
    } else {
        Some(unsafe { utf16_to_string(value, value_len) })
    };
    unsafe { url_mut(handle) }.set_search(v.as_deref());
}

#[no_mangle]
pub unsafe extern "C" fn mal_url_set_hash(
    handle: *mut core::ffi::c_void,
    value: *const u16,
    value_len: usize,
    is_null: bool,
) {
    let v = if is_null {
        None
    } else {
        Some(unsafe { utf16_to_string(value, value_len) })
    };
    unsafe { url_mut(handle) }.set_hash(v.as_deref());
}
