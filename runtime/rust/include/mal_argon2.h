/*
 * mal_argon2.h - flat Argon2 (RFC 9106) derivation ABI for the Rust backend.
 *
 * Contract:
 *   * Every pointer in MalArgon2Request is borrowed for the duration of one
 *     mal_argon2_hash call and never retained. A null pointer is accepted only
 *     with a zero length.
 *   * `out` must be writable for exactly `out_len` bytes and must not overlap
 *     any input.
 *   * No message string ever crosses this boundary: only the fixed status codes
 *     below are returned, so a derivation failure cannot leak key material into
 *     a diagnostic. The C adapter maps each status to a fixed English message.
 *   * The implementation holds no shared state, so independent concurrent calls
 *     on different threads are safe. A single request must not be hashed by two
 *     threads at once.
 *   * The crate profile is `panic = "abort"`, so the Rust side never unwinds:
 *     every bound is checked and reported as a status instead.
 *
 * Residual allocation risk (deliberate, see mal_argon2_hash): the backing crate
 * allocates its block matrix infallibly, so an allocator failure inside the
 * derivation aborts the process. mal_argon2_hash performs a fallible
 * try_reserve probe of the same size first, but on an overcommitting allocator
 * (macOS, default Linux) that probe succeeds for sizes the machine cannot
 * actually back — it catches the checked overflow and allocators that do
 * refuse, and nothing more. The host-layer resource policy is the real defense:
 * MAL_ARGON2_DEFAULT_MAX_MEMORY_KIB bounds the matrix (256 MiB) and
 * MAL_ARGON2_DEFAULT_MAX_TAG_LENGTH bounds the output (16 MiB), both checked in
 * C before this boundary is crossed.
 *
 * Available only when Cargo feature `node-argon2` is linked.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MAL_ARGON2_ABI_VERSION 1u

#define MAL_ARGON2_VARIANT_D  0u
#define MAL_ARGON2_VARIANT_I  1u
#define MAL_ARGON2_VARIANT_ID 2u

#define MAL_ARGON2_STATUS_OK                0
#define MAL_ARGON2_STATUS_INVALID_ARGUMENT -1
/* Reservation failed, or the requested matrix exceeds the host ceiling. */
#define MAL_ARGON2_STATUS_MEMORY           -2
#define MAL_ARGON2_STATUS_INTERNAL         -3

typedef struct MalArgon2Request {
    uint32_t variant;
    uint32_t parallelism;
    uint32_t passes;
    uint32_t memory_kib;
    uint32_t tag_length;
    const uint8_t *message;
    size_t message_len;
    const uint8_t *nonce;
    size_t nonce_len;
    const uint8_t *secret;
    size_t secret_len;
    const uint8_t *associated_data;
    size_t associated_data_len;
} MalArgon2Request;

uint32_t mal_argon2_abi_version(void);

/* Reference block count after Argon2's rounding
 * (floor(max(m, 8p) / (4p)) * 4p), so the caller can size and policy-check a
 * derivation before any allocation is attempted. Returns
 * MAL_ARGON2_STATUS_INVALID_ARGUMENT (leaving *out_blocks untouched) when the
 * parameters are outside Argon2's bounds. */
int32_t mal_argon2_block_count(
    uint32_t parallelism, uint32_t memory_kib, uint64_t *out_blocks);

/* Derives exactly `out_len` bytes into `out`; `out_len` must equal
 * request->tag_length. Never allocates the output. */
int32_t mal_argon2_hash(
    const MalArgon2Request *request, uint8_t *out, size_t out_len);

#ifdef __cplusplus
}
#endif
