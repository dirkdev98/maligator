#pragma once

#include "vm.h"

/** Install the global Buffer constructor and the node:buffer module exports. */
void mal_host_install_node_buffer(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch
);

/**
 * Consume a malloc-compatible byte allocation and return a Buffer backed by it.
 * Ownership is consumed on success and failure. `bytes` may be null only when
 * `length` is zero. Installs the current realm's Buffer identity if necessary.
 */
MalValue mal_node_buffer_from_owned_bytes(MalVm *vm, byte *bytes, usize length);

/** Share a view's current byte range with a Buffer whose length stays fixed. */
MalValue mal_node_buffer_fixed_view(MalVm *vm, MalValue view);

/**
 * As mal_node_buffer_from_owned_bytes, but the resulting Buffer's backing store
 * is marked secret-bearing, so it is scrubbed before release instead of being
 * plain-freed. For crypto key/token output only (randomBytes, PBKDF2, Argon2
 * tags) — not for ordinary Buffers, whose bytes are not secrets and whose scrub
 * would be pure cost.
 */
MalValue mal_node_buffer_from_owned_secret_bytes(MalVm *vm, byte *bytes, usize length);

/**
 * Render bytes as a string in a Buffer encoding (`utf8`, `latin1`/`binary`,
 * `ascii`, `hex`, `base64`, `base64url`, `ucs2`/`utf16le`; case-insensitive).
 * An `undefined` encoding returns a Buffer over a copy of the bytes.
 *
 * `throw_on_unknown` selects between the two Node behaviors that share this
 * code: `Hash`/`Hmac` `digest` silently falls back to a Buffer for an
 * unrecognized encoding, while `crypto.hash` throws a TypeError. Returns
 * undefined with a pending exception on failure.
 */
MalValue mal_node_buffer_encode_bytes(
    MalVm *vm, const byte *bytes, usize length, MalValue encoding,
    bool throw_on_unknown);

/**
 * As mal_node_buffer_encode_bytes, but any Buffer it returns owns a
 * secret-bearing backing store (see mal_node_buffer_from_owned_secret_bytes).
 * A string result cannot be scrubbed and is unaffected.
 */
MalValue mal_node_buffer_encode_secret_bytes(
    MalVm *vm, const byte *bytes, usize length, MalValue encoding,
    bool throw_on_unknown);

/** Whether `encoding` names a Buffer encoding (case-insensitively). */
bool mal_node_buffer_encoding_is_known(MalValue encoding);

typedef enum MalBufferEncoding {
    MAL_BUFFER_UTF8,
    MAL_BUFFER_LATIN1,
    MAL_BUFFER_ASCII,
    MAL_BUFFER_HEX,
    MAL_BUFFER_BASE64,
    MAL_BUFFER_BASE64URL,
    MAL_BUFFER_UTF16LE,
} MalBufferEncoding;

typedef struct MalBufferStringDecodePlan {
    MalBufferEncoding encoding;
    usize byte_capacity;
} MalBufferStringDecodePlan;

/** Size the encoded allocation before admission to a retained-work budget. Unknown encodings use UTF-8. */
MalBufferStringDecodePlan mal_node_buffer_plan_string_decode(MalValue string, MalValue encoding);

/** Allocate the planned bytes for the same immutable string. Null signals allocation failure. */
byte *mal_node_buffer_decode_planned_string(
    MalValue string, MalBufferStringDecodePlan plan, usize *length_out);

/**
 * Decode a JS string into bytes using a Buffer encoding, matching
 * `Buffer.from(string, encoding)`. An unrecognized or non-string encoding falls
 * back to UTF-8, as `hash.update` does. The returned allocation is the caller's;
 * null signals an allocation failure with no exception thrown.
 */
byte *mal_node_buffer_decode_string(
    MalVm *vm, MalValue string, MalValue encoding, usize *length_out);
