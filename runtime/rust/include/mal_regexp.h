/*
 * mal_regexp.h — C ABI for the `mal_regexp` Rust shim (the `regress` engine).
 *
 * Hand-maintained to mirror the `#[no_mangle] extern "C"` surface in
 * runtime/rust/src/regexp.rs. The C runtime owns all JS-spec glue (the RegExp
 * object, lastIndex/global/sticky iteration, result-array shaping, the
 * Symbol.* protocol, $-substitution, the d-flag indices array); this header
 * exposes only flat match primitives.
 *
 * Patterns and subjects are UTF-16 (`const uint16_t *` + length) — MalString's
 * native storage — so they cross zero-copy. All offsets are u16 code-unit
 * indices, i.e. JS string indices directly. See docs/decisions/03-regexp.md.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Bump alongside MAL_REGEXP_ABI_VERSION in regexp.rs on breaking changes.
 * v2: added mal_regexp_free (GC finalization). */
#define MAL_REGEXP_ABI_VERSION 2u

/* Returns the ABI version compiled into the linked archive. */
uint32_t mal_regexp_abi_version(void);

/* Flag bitmask for mal_regexp_compile. g/y/d are engine-external (the C side
 * drives lastIndex, sticky anchoring, and the indices array) and have no bit. */
#define MAL_REGEXP_FLAG_IGNORE_CASE  (1u << 0) /* i */
#define MAL_REGEXP_FLAG_MULTILINE    (1u << 1) /* m */
#define MAL_REGEXP_FLAG_DOT_ALL      (1u << 2) /* s */
#define MAL_REGEXP_FLAG_UNICODE      (1u << 3) /* u */
#define MAL_REGEXP_FLAG_UNICODE_SETS (1u << 4) /* v */

/* Compile `pattern` (UTF-16) with `flags`. Returns an opaque, leaked handle, or
 * NULL when the pattern is invalid (the C side throws SyntaxError). The handle
 * lives as long as the owning RegExp object; freed by mal_regexp_free. */
void *mal_regexp_compile(const uint16_t *pattern, size_t pattern_len, uint32_t flags);

/* Free a handle from mal_regexp_compile (null-tolerant, so the GC finalizer is
 * idempotent after nulling the field). ABI v2+. */
void mal_regexp_free(void *handle);

/* Execute `handle` against `subject` (UTF-16) starting at code-unit index
 * `start`. Returns the capture-group count (>= 1, including group 0) on a match,
 * 0 on no match, -1 on error. On a match, writes (start,end) code-unit index
 * pairs for groups 0..N into caps_out (2 int32 per group; -1,-1 for a group that
 * did not participate), up to caps_cap slots, and retains the match for the
 * named-group queries below. If the return exceeds caps_cap/2 the buffer was too
 * small — grow it and call mal_regexp_copy_captures (no re-match). */
int32_t mal_regexp_exec(void *handle, const uint16_t *subject, size_t subject_len,
                        size_t start, int32_t *caps_out, int32_t caps_cap);

/* Copy the most recent successful match's capture pairs into caps_out without
 * re-matching; returns the group count, or 0 if no match is retained. */
int32_t mal_regexp_copy_captures(void *handle, int32_t *caps_out, int32_t caps_cap);

/* Number of distinct named capture groups in the most recent match. */
int32_t mal_regexp_named_group_count(void *handle);

/* The `index`-th named group of the most recent match: writes the name (UTF-8)
 * into name_out (<= name_cap bytes) and returns the full byte length (probe with
 * name_cap 0); writes the (start,end) code-unit range into range_out[2] (-1,-1
 * if the group did not participate). Returns -1 if no match or index is out of
 * range. */
int32_t mal_regexp_named_group(void *handle, int32_t index, uint8_t *name_out,
                               int32_t name_cap, int32_t *range_out);

#ifdef __cplusplus
}
#endif
