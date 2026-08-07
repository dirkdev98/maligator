//! Argon2 (RFC 9106) derivation primitives for the node:crypto adapter.
//!
//! `sru-systems/rust-argon2` backs this module rather than RustCrypto's
//! `argon2`, which caps associated data at 32 bytes while Node accepts up to
//! 2^32-1 (see runtime/rust/Cargo.toml).
//!
//! Every input pointer is borrowed for one call and never retained; no message
//! string crosses the ABI, so a failure cannot carry key material into a
//! diagnostic. See runtime/rust/include/mal_argon2.h for the full contract.

use argon2::{Config, ThreadMode, Variant, Version};

pub const MAL_ARGON2_ABI_VERSION: u32 = 1;

pub const MAL_ARGON2_VARIANT_D: u32 = 0;
pub const MAL_ARGON2_VARIANT_I: u32 = 1;
pub const MAL_ARGON2_VARIANT_ID: u32 = 2;

pub const MAL_ARGON2_STATUS_OK: i32 = 0;
pub const MAL_ARGON2_STATUS_INVALID_ARGUMENT: i32 = -1;
pub const MAL_ARGON2_STATUS_MEMORY: i32 = -2;
pub const MAL_ARGON2_STATUS_INTERNAL: i32 = -3;

/// Argon2's synchronization points per pass (RFC 9106 §3.2); the block count is
/// rounded down to a multiple of `SYNC_POINTS * lanes`.
const SYNC_POINTS: u64 = 4;
const BLOCK_SIZE: u64 = 1024;

/// Mirrors the C `MalArgon2Request`.
#[repr(C)]
pub struct MalArgon2Request {
    pub variant: u32,
    pub parallelism: u32,
    pub passes: u32,
    pub memory_kib: u32,
    pub tag_length: u32,
    pub message: *const u8,
    pub message_len: usize,
    pub nonce: *const u8,
    pub nonce_len: usize,
    pub secret: *const u8,
    pub secret_len: usize,
    pub associated_data: *const u8,
    pub associated_data_len: usize,
}

#[no_mangle]
pub extern "C" fn mal_argon2_abi_version() -> u32 {
    MAL_ARGON2_ABI_VERSION
}

fn variant_from_code(code: u32) -> Option<Variant> {
    match code {
        MAL_ARGON2_VARIANT_D => Some(Variant::Argon2d),
        MAL_ARGON2_VARIANT_I => Some(Variant::Argon2i),
        MAL_ARGON2_VARIANT_ID => Some(Variant::Argon2id),
        _ => None,
    }
}

/// Argon2's block-count rounding, duplicated here (the crate computes it inside
/// a private `Context`) so C can size and policy-check before allocating.
fn block_count(parallelism: u32, memory_kib: u32) -> Option<u64> {
    if parallelism == 0 || parallelism > 0x00FF_FFFF {
        return None;
    }
    let lanes = parallelism as u64;
    let memory = memory_kib as u64;
    if memory < SYNC_POINTS * 2 || memory < 8 * lanes {
        return None;
    }
    let segment_length = memory / (lanes * SYNC_POINTS);
    Some(segment_length * lanes * SYNC_POINTS)
}

#[no_mangle]
pub unsafe extern "C" fn mal_argon2_block_count(
    parallelism: u32,
    memory_kib: u32,
    out_blocks: *mut u64,
) -> i32 {
    if out_blocks.is_null() {
        return MAL_ARGON2_STATUS_INVALID_ARGUMENT;
    }
    match block_count(parallelism, memory_kib) {
        Some(blocks) => {
            unsafe { *out_blocks = blocks };
            MAL_ARGON2_STATUS_OK
        }
        None => MAL_ARGON2_STATUS_INVALID_ARGUMENT,
    }
}

/// Borrow a `(ptr, len)` pair. `None` marks the one invalid combination: a null
/// pointer with a non-zero length. A null pointer with length 0 is the empty
/// slice, matching how C spells an absent optional input.
unsafe fn borrow<'a>(ptr: *const u8, len: usize) -> Option<&'a [u8]> {
    if len == 0 {
        Some(&[])
    } else if ptr.is_null() {
        None
    } else {
        Some(unsafe { core::slice::from_raw_parts(ptr, len) })
    }
}

/// Probe that the block matrix can be allocated, using a *fallible* reservation
/// of the same byte size. `rust-argon2` then allocates it infallibly, so this
/// only narrows the window. It narrows it less than it looks: on an
/// overcommitting allocator (macOS, default Linux) a multi-terabyte reservation
/// succeeds and the process dies later on first touch. The host-layer resource
/// policy is the real defense — `MAL_ARGON2_DEFAULT_MAX_MEMORY_KIB` (256 MiB)
/// is checked in C before this boundary is crossed; this catches the checked
/// overflow and allocators that do refuse.
fn probe_matrix(blocks: u64) -> i32 {
    let Some(bytes) = blocks.checked_mul(BLOCK_SIZE) else {
        return MAL_ARGON2_STATUS_INVALID_ARGUMENT;
    };
    let Ok(bytes) = usize::try_from(bytes) else {
        return MAL_ARGON2_STATUS_INVALID_ARGUMENT;
    };
    let mut probe: Vec<u8> = Vec::new();
    match probe.try_reserve_exact(bytes) {
        Ok(()) => {
            drop(probe);
            MAL_ARGON2_STATUS_OK
        }
        Err(_) => MAL_ARGON2_STATUS_MEMORY,
    }
}

#[no_mangle]
pub unsafe extern "C" fn mal_argon2_hash(
    request: *const MalArgon2Request,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    if request.is_null() || out.is_null() || out_len == 0 {
        return MAL_ARGON2_STATUS_INVALID_ARGUMENT;
    }
    let request = unsafe { &*request };
    if request.tag_length as usize != out_len {
        return MAL_ARGON2_STATUS_INVALID_ARGUMENT;
    }
    let Some(variant) = variant_from_code(request.variant) else {
        return MAL_ARGON2_STATUS_INVALID_ARGUMENT;
    };
    let Some(blocks) = block_count(request.parallelism, request.memory_kib) else {
        return MAL_ARGON2_STATUS_INVALID_ARGUMENT;
    };
    let (Some(message), Some(nonce), Some(secret), Some(associated_data)) = (
        unsafe { borrow(request.message, request.message_len) },
        unsafe { borrow(request.nonce, request.nonce_len) },
        unsafe { borrow(request.secret, request.secret_len) },
        unsafe { borrow(request.associated_data, request.associated_data_len) },
    ) else {
        return MAL_ARGON2_STATUS_INVALID_ARGUMENT;
    };
    let probe = probe_matrix(blocks);
    if probe != MAL_ARGON2_STATUS_OK {
        return probe;
    }

    // mem_cost is the caller's un-rounded value: Argon2 hashes it into H0 while
    // rounding only the block count, so pre-rounding would change every digest.
    let config = Config {
        ad: associated_data,
        hash_length: request.tag_length,
        lanes: request.parallelism,
        mem_cost: request.memory_kib,
        secret,
        thread_mode: ThreadMode::Sequential,
        time_cost: request.passes,
        variant,
        version: Version::Version13,
    };
    let mut tag = match argon2::hash_raw(message, nonce, &config) {
        Ok(tag) => tag,
        Err(_) => return MAL_ARGON2_STATUS_INTERNAL,
    };
    if tag.len() != out_len {
        scrub(&mut tag);
        return MAL_ARGON2_STATUS_INTERNAL;
    }
    unsafe { core::ptr::copy_nonoverlapping(tag.as_ptr(), out, out_len) };
    scrub(&mut tag);
    MAL_ARGON2_STATUS_OK
}

/// Overwrite a derived tag before its allocation is released. `write_volatile`
/// keeps the stores from being optimized away as dead.
fn scrub(bytes: &mut [u8]) {
    for byte in bytes.iter_mut() {
        unsafe { core::ptr::write_volatile(byte, 0) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }

    /// RFC 9106 §5 inputs: p=4, t=3, m=32, tag 32, pwd 32x01, salt 16x02,
    /// secret 8x03, associated data 12x04.
    fn rfc9106(variant: u32, ad: &[u8]) -> String {
        let message = [0x01u8; 32];
        let nonce = [0x02u8; 16];
        let secret = [0x03u8; 8];
        let mut out = [0u8; 32];
        let request = MalArgon2Request {
            variant,
            parallelism: 4,
            passes: 3,
            memory_kib: 32,
            tag_length: 32,
            message: message.as_ptr(),
            message_len: message.len(),
            nonce: nonce.as_ptr(),
            nonce_len: nonce.len(),
            secret: secret.as_ptr(),
            secret_len: secret.len(),
            associated_data: ad.as_ptr(),
            associated_data_len: ad.len(),
        };
        let status = unsafe { mal_argon2_hash(&request, out.as_mut_ptr(), out.len()) };
        assert_eq!(status, MAL_ARGON2_STATUS_OK);
        hex(&out)
    }

    #[test]
    fn rfc9106_known_answer_vectors_cover_all_three_variants() {
        let ad = [0x04u8; 12];
        assert_eq!(
            rfc9106(MAL_ARGON2_VARIANT_D, &ad),
            "512b391b6f1162975371d30919734294f868e3be3984f3c1a13a4db9fabe4acb"
        );
        assert_eq!(
            rfc9106(MAL_ARGON2_VARIANT_I, &ad),
            "c814d9d1dc7f37aa13f0d77f2494bda1c8de6b016dd388d29952a4c4672b6ce8"
        );
        assert_eq!(
            rfc9106(MAL_ARGON2_VARIANT_ID, &ad),
            "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659"
        );
    }

    /// The direct regression guard for the crate selection: RustCrypto's argon2
    /// rejects associated data past 32 bytes, so a backend swap would surface
    /// here rather than as a silent parity break.
    #[test]
    fn associated_data_past_thirty_two_bytes_changes_the_digest() {
        let at32 = rfc9106(MAL_ARGON2_VARIANT_ID, &[0x04u8; 32]);
        let at33 = rfc9106(MAL_ARGON2_VARIANT_ID, &[0x04u8; 33]);
        let at1000 = rfc9106(MAL_ARGON2_VARIANT_ID, &[0x04u8; 1000]);
        assert_ne!(at32, at33);
        assert_ne!(at33, at1000);
        assert_ne!(at32, at1000);
    }

    #[test]
    fn block_count_rounds_down_to_a_multiple_of_four_lanes() {
        let count = |p, m| {
            let mut blocks = 0u64;
            let status = unsafe { mal_argon2_block_count(p, m, &mut blocks) };
            (status, blocks)
        };
        assert_eq!(count(1, 8), (MAL_ARGON2_STATUS_OK, 8));
        assert_eq!(count(1, 9), (MAL_ARGON2_STATUS_OK, 8));
        assert_eq!(count(1, 11), (MAL_ARGON2_STATUS_OK, 8));
        assert_eq!(count(1, 12), (MAL_ARGON2_STATUS_OK, 12));
        assert_eq!(count(2, 15).0, MAL_ARGON2_STATUS_INVALID_ARGUMENT);
        assert_eq!(count(2, 16), (MAL_ARGON2_STATUS_OK, 16));
        assert_eq!(count(2, 17), (MAL_ARGON2_STATUS_OK, 16));
        assert_eq!(count(2, 23), (MAL_ARGON2_STATUS_OK, 16));
        assert_eq!(count(2, 24), (MAL_ARGON2_STATUS_OK, 24));
        assert_eq!(count(0, 4096).0, MAL_ARGON2_STATUS_INVALID_ARGUMENT);
        assert_eq!(count(1, 7).0, MAL_ARGON2_STATUS_INVALID_ARGUMENT);
    }

    /// m=8 and m=9 round to the same block count but must still differ, because
    /// Argon2 hashes the un-rounded `memory` into H0.
    #[test]
    fn unrounded_memory_enters_the_initial_hash() {
        let derive = |memory_kib| {
            let message = *b"password";
            let nonce = *b"0123456789abcdef";
            let mut out = [0u8; 32];
            let request = MalArgon2Request {
                variant: MAL_ARGON2_VARIANT_ID,
                parallelism: 1,
                passes: 1,
                memory_kib,
                tag_length: 32,
                message: message.as_ptr(),
                message_len: message.len(),
                nonce: nonce.as_ptr(),
                nonce_len: nonce.len(),
                secret: core::ptr::null(),
                secret_len: 0,
                associated_data: core::ptr::null(),
                associated_data_len: 0,
            };
            assert_eq!(
                unsafe { mal_argon2_hash(&request, out.as_mut_ptr(), out.len()) },
                MAL_ARGON2_STATUS_OK
            );
            hex(&out)
        };
        assert_ne!(derive(8), derive(9));
    }

    #[test]
    fn null_inputs_are_accepted_only_with_a_zero_length() {
        let nonce = *b"0123456789abcdef";
        let mut out = [0u8; 32];
        let mut request = MalArgon2Request {
            variant: MAL_ARGON2_VARIANT_ID,
            parallelism: 1,
            passes: 1,
            memory_kib: 8,
            tag_length: 32,
            message: core::ptr::null(),
            message_len: 0,
            nonce: nonce.as_ptr(),
            nonce_len: nonce.len(),
            secret: core::ptr::null(),
            secret_len: 0,
            associated_data: core::ptr::null(),
            associated_data_len: 0,
        };
        assert_eq!(
            unsafe { mal_argon2_hash(&request, out.as_mut_ptr(), out.len()) },
            MAL_ARGON2_STATUS_OK
        );
        request.secret_len = 8;
        assert_eq!(
            unsafe { mal_argon2_hash(&request, out.as_mut_ptr(), out.len()) },
            MAL_ARGON2_STATUS_INVALID_ARGUMENT
        );
    }

    #[test]
    fn rejects_unknown_variants_and_mismatched_output_lengths() {
        let nonce = *b"0123456789abcdef";
        let mut out = [0u8; 32];
        let request = MalArgon2Request {
            variant: 7,
            parallelism: 1,
            passes: 1,
            memory_kib: 8,
            tag_length: 32,
            message: core::ptr::null(),
            message_len: 0,
            nonce: nonce.as_ptr(),
            nonce_len: nonce.len(),
            secret: core::ptr::null(),
            secret_len: 0,
            associated_data: core::ptr::null(),
            associated_data_len: 0,
        };
        assert_eq!(
            unsafe { mal_argon2_hash(&request, out.as_mut_ptr(), out.len()) },
            MAL_ARGON2_STATUS_INVALID_ARGUMENT
        );
        let mismatched = MalArgon2Request {
            variant: MAL_ARGON2_VARIANT_ID,
            ..request
        };
        assert_eq!(
            unsafe { mal_argon2_hash(&mismatched, out.as_mut_ptr(), 16) },
            MAL_ARGON2_STATUS_INVALID_ARGUMENT
        );
        assert_eq!(
            unsafe { mal_argon2_hash(core::ptr::null(), out.as_mut_ptr(), out.len()) },
            MAL_ARGON2_STATUS_INVALID_ARGUMENT
        );
    }

    /// A block count whose byte size overflows must be rejected arithmetically,
    /// before any reservation is attempted.
    #[test]
    fn an_overflowing_matrix_size_is_rejected_without_allocating() {
        assert_eq!(
            probe_matrix(u64::MAX),
            MAL_ARGON2_STATUS_INVALID_ARGUMENT,
            "blocks * 1024 must be a checked multiply"
        );
        assert_eq!(probe_matrix(8), MAL_ARGON2_STATUS_OK);
    }

    /// Pins the probe's real limit: on an overcommitting allocator a reservation
    /// far past physical memory still succeeds, so `probe_matrix` cannot be the
    /// defense against a pathological `memory` — the host resource policy is
    /// (see mal_argon2_configure / MAL_ARGON2_DEFAULT_MAX_MEMORY_KIB).
    #[test]
    fn the_probe_does_not_bound_pathological_sizes_on_overcommit() {
        let four_tib_of_blocks = u32::MAX as u64;
        let status = probe_matrix(four_tib_of_blocks);
        assert!(
            status == MAL_ARGON2_STATUS_OK
                || status == MAL_ARGON2_STATUS_MEMORY
                || status == MAL_ARGON2_STATUS_INVALID_ARGUMENT,
            "the probe reports a status either way; it never aborts"
        );
    }

    #[test]
    fn scrub_clears_a_derived_tag() {
        let mut bytes = [0xa5u8; 16];
        scrub(&mut bytes);
        assert_eq!(bytes, [0u8; 16]);
    }
}
