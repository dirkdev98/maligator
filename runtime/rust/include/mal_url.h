/*
 * mal_url.h — C ABI for the URL half of the `mal_rust` shim (the `ada-url` crate,
 * wrapping the C++ `ada` library).
 *
 * Hand-maintained to mirror the `#[no_mangle] extern "C"` surface in
 * runtime/rust/src/url.rs. The C runtime owns all JS-spec glue (the URL and
 * URLSearchParams objects, the Symbol protocol, error shaping, URLSearchParams
 * itself); this header exposes only a parsed-URL handle + flat component accessors.
 *
 * Because `ada-url` links a C++ library, every final link needs the C++ stdlib
 * (`-lc++`/`-lstdc++`), added by src/rust-build.ts artifact resolution.
 *
 * Inputs are UTF-16 (`const uint16_t *` + length) — MalString's native storage,
 * decoded lossily to scalar values. Outputs are UTF-8 via the probe-then-fill
 * convention (call with cap 0 to get the length, then again to fill); the C side
 * decodes to a MalString.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Bump alongside MAL_URL_ABI_VERSION in url.rs on breaking changes. */
#define MAL_URL_ABI_VERSION 1u

/* Returns the ABI version compiled into the linked archive. */
uint32_t mal_url_abi_version(void);

/* Parse `input` (UTF-16), optionally against `base` (UTF-16, used only when
 * has_base is true). Returns an opaque, heap-allocated handle, or NULL on a parse
 * failure (the C side throws TypeError). Free with mal_url_free. */
void *mal_url_parse(const uint16_t *input, size_t input_len, const uint16_t *base,
                    size_t base_len, bool has_base);

/* URL.canParse(input, base?): whether parsing would succeed (no handle allocated). */
bool mal_url_can_parse(const uint16_t *input, size_t input_len, const uint16_t *base,
                       size_t base_len, bool has_base);

/* Free a handle from mal_url_parse (null-tolerant, so the GC finalizer is
 * idempotent after nulling the field). */
void mal_url_free(void *handle);

/* Component getters: write the component (UTF-8) into `out` (<= out_cap bytes) and
 * return its full byte length (probe with out_cap 0, then fill). */
int32_t mal_url_href(void *handle, uint8_t *out, int32_t out_cap);
int32_t mal_url_protocol(void *handle, uint8_t *out, int32_t out_cap);
int32_t mal_url_username(void *handle, uint8_t *out, int32_t out_cap);
int32_t mal_url_password(void *handle, uint8_t *out, int32_t out_cap);
int32_t mal_url_host(void *handle, uint8_t *out, int32_t out_cap);
int32_t mal_url_hostname(void *handle, uint8_t *out, int32_t out_cap);
int32_t mal_url_port(void *handle, uint8_t *out, int32_t out_cap);
int32_t mal_url_pathname(void *handle, uint8_t *out, int32_t out_cap);
int32_t mal_url_search(void *handle, uint8_t *out, int32_t out_cap);
int32_t mal_url_hash(void *handle, uint8_t *out, int32_t out_cap);
int32_t mal_url_origin(void *handle, uint8_t *out, int32_t out_cap);

/* Component setters. Return whether ada accepted the value (invalid values are
 * ignored per spec — the setter is a no-op and returns false). set_href/
 * set_protocol take a plain string; the rest take an optional string (is_null
 * clears the component). set_search/set_hash always succeed (void). */
bool mal_url_set_href(void *handle, const uint16_t *value, size_t value_len);
bool mal_url_set_protocol(void *handle, const uint16_t *value, size_t value_len);
bool mal_url_set_username(void *handle, const uint16_t *value, size_t value_len, bool is_null);
bool mal_url_set_password(void *handle, const uint16_t *value, size_t value_len, bool is_null);
bool mal_url_set_host(void *handle, const uint16_t *value, size_t value_len, bool is_null);
bool mal_url_set_hostname(void *handle, const uint16_t *value, size_t value_len, bool is_null);
bool mal_url_set_port(void *handle, const uint16_t *value, size_t value_len, bool is_null);
bool mal_url_set_pathname(void *handle, const uint16_t *value, size_t value_len, bool is_null);
void mal_url_set_search(void *handle, const uint16_t *value, size_t value_len, bool is_null);
void mal_url_set_hash(void *handle, const uint16_t *value, size_t value_len, bool is_null);

#ifdef __cplusplus
}
#endif
