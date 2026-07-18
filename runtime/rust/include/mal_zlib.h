/*
 * mal_zlib.h - flat streaming decompression ABI for the Rust codec backend.
 * The caller owns all input/output storage; the opaque stream retains no buffer
 * pointers across calls. Available only when Cargo feature `node-zlib` is linked.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MAL_ZLIB_ABI_VERSION 1u

typedef struct MalZlibStream MalZlibStream;

#define MAL_ZLIB_FORMAT_ZLIB   1u
#define MAL_ZLIB_FORMAT_GZIP   2u
#define MAL_ZLIB_FORMAT_BROTLI 3u

#define MAL_ZLIB_STATUS_NEED_INPUT        1
#define MAL_ZLIB_STATUS_NEED_OUTPUT       2
#define MAL_ZLIB_STATUS_STREAM_END        3
#define MAL_ZLIB_STATUS_DATA_ERROR       -1
#define MAL_ZLIB_STATUS_TRUNCATED        -2
#define MAL_ZLIB_STATUS_INVALID_ARGUMENT -3

uint32_t mal_zlib_abi_version(void);

/* On success, stores a new handle and returns NEED_INPUT. On failure, stores
 * NULL and returns INVALID_ARGUMENT. */
int32_t mal_zlib_create(uint32_t format, MalZlibStream **out_handle);

/* Borrows the two bounded buffers for this call only. Always initializes
 * consumed/produced when those pointers are valid. Unconsumed input remains the
 * caller's responsibility and must be resubmitted. All non-null pointers must be
 * valid for their stated access; handle, input, output, consumed, and produced
 * must not overlap, and one handle must not be pumped concurrently. Buffer lengths
 * above PTRDIFF_MAX are rejected with INVALID_ARGUMENT before buffer access. */
int32_t mal_zlib_pump(MalZlibStream *handle,
                      const uint8_t *input, size_t input_len,
                      uint8_t *output, size_t output_len,
                      size_t *consumed, size_t *produced);

/* Declare that no more input will arrive. STREAM_END confirms a complete zlib
 * or Brotli stream, or one or more complete gzip members. Otherwise this returns
 * TRUNCATED (or the stream's sticky DATA_ERROR). Drain NEED_OUTPUT first. After a
 * successful finish, later pump calls return STREAM_END without consuming input. */
int32_t mal_zlib_finish(MalZlibStream *handle);

/* Takes ownership through the slot, sets *handle to NULL, then releases it.
 * Calling repeatedly with the same slot, a null slot, or a slot holding NULL is safe. */
void mal_zlib_free(MalZlibStream **handle);

#ifdef __cplusplus
}
#endif
