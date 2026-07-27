#include "node_crypto.h"

#include <limits.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "ascii.h"
#include "array_buffer_object.h"
#include "base64.h"
#include "builtin_data_view.h"
#include "function_object.h"
#include "gc.h"
#include "entropy.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "hex.h"
#include "intrinsics.h"
#include "node_buffer.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "utf8.h"
#include "typed_array_object.h"
#include "value.h"
#include "vm.h"
#include "vm_ops.h"

#if MAL_NODE

/* ---------------------------------------------------------------------------
 * SHA-256 (FIPS 180-4). Self-contained: no OpenSSL, no Rust FFI. Operates on a
 * caller-provided context on the C stack, so it never allocates and is safe to
 * run between the argument reads and the single result-string allocation.
 * --------------------------------------------------------------------------- */

typedef struct {
    u32 state[8];
    u64 bit_len;   // total message length in bits (of fully-absorbed data)
    u8 block[64];  // partial block being filled
    usize block_len;
} MalSha256;

static const u32 MAL_SHA256_K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

#define MAL_ROTR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
#define MAL_ROTL(x, n) (((x) << (n)) | ((x) >> (32 - (n))))

static void mal_sha256_init(MalSha256 *ctx) {
    ctx->state[0] = 0x6a09e667;
    ctx->state[1] = 0xbb67ae85;
    ctx->state[2] = 0x3c6ef372;
    ctx->state[3] = 0xa54ff53a;
    ctx->state[4] = 0x510e527f;
    ctx->state[5] = 0x9b05688c;
    ctx->state[6] = 0x1f83d9ab;
    ctx->state[7] = 0x5be0cd19;
    ctx->bit_len = 0;
    ctx->block_len = 0;
}

static void mal_sha256_compress(MalSha256 *ctx, const u8 *p) {
    u32 w[64];
    for (int i = 0; i < 16; i++) {
        w[i] = ((u32) p[i * 4] << 24) | ((u32) p[i * 4 + 1] << 16) | ((u32) p[i * 4 + 2] << 8)
            | (u32) p[i * 4 + 3];
    }
    for (int i = 16; i < 64; i++) {
        u32 s0 = MAL_ROTR(w[i - 15], 7) ^ MAL_ROTR(w[i - 15], 18) ^ (w[i - 15] >> 3);
        u32 s1 = MAL_ROTR(w[i - 2], 17) ^ MAL_ROTR(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    u32 a = ctx->state[0], b = ctx->state[1], c = ctx->state[2], d = ctx->state[3];
    u32 e = ctx->state[4], f = ctx->state[5], g = ctx->state[6], h = ctx->state[7];
    for (int i = 0; i < 64; i++) {
        u32 s1 = MAL_ROTR(e, 6) ^ MAL_ROTR(e, 11) ^ MAL_ROTR(e, 25);
        u32 ch = (e & f) ^ (~e & g);
        u32 t1 = h + s1 + ch + MAL_SHA256_K[i] + w[i];
        u32 s0 = MAL_ROTR(a, 2) ^ MAL_ROTR(a, 13) ^ MAL_ROTR(a, 22);
        u32 maj = (a & b) ^ (a & c) ^ (b & c);
        u32 t2 = s0 + maj;
        h = g;
        g = f;
        f = e;
        e = d + t1;
        d = c;
        c = b;
        b = a;
        a = t1 + t2;
    }
    ctx->state[0] += a;
    ctx->state[1] += b;
    ctx->state[2] += c;
    ctx->state[3] += d;
    ctx->state[4] += e;
    ctx->state[5] += f;
    ctx->state[6] += g;
    ctx->state[7] += h;
}

static void mal_sha256_update(MalSha256 *ctx, const u8 *data, usize len) {
    for (usize i = 0; i < len; i++) {
        ctx->block[ctx->block_len++] = data[i];
        if (ctx->block_len == 64) {
            mal_sha256_compress(ctx, ctx->block);
            ctx->bit_len += 512;
            ctx->block_len = 0;
        }
    }
}

static void mal_sha256_final(MalSha256 *ctx, u8 out[32]) {
    usize i = ctx->block_len;
    ctx->bit_len += (u64) ctx->block_len * 8;
    // Append the 0x80 terminator, then pad with zeros to a 56-byte boundary,
    // spilling into an extra block when there is no room for the length field.
    ctx->block[i++] = 0x80;
    if (i > 56) {
        while (i < 64) {
            ctx->block[i++] = 0;
        }
        mal_sha256_compress(ctx, ctx->block);
        i = 0;
    }
    while (i < 56) {
        ctx->block[i++] = 0;
    }
    for (int k = 0; k < 8; k++) {
        ctx->block[63 - k] = (u8) (ctx->bit_len >> (k * 8));  // big-endian 64-bit length
    }
    mal_sha256_compress(ctx, ctx->block);
    for (int j = 0; j < 8; j++) {
        out[j * 4] = (u8) (ctx->state[j] >> 24);
        out[j * 4 + 1] = (u8) (ctx->state[j] >> 16);
        out[j * 4 + 2] = (u8) (ctx->state[j] >> 8);
        out[j * 4 + 3] = (u8) (ctx->state[j]);
    }
}

/* SHA-1 (FIPS 180-4), retained only for the pinned etag compatibility slice. */
typedef struct {
    u32 state[5];
    u64 bit_len;
    u8 block[64];
    usize block_len;
} MalSha1;

static void mal_sha1_init(MalSha1 *ctx) {
    ctx->state[0] = 0x67452301;
    ctx->state[1] = 0xefcdab89;
    ctx->state[2] = 0x98badcfe;
    ctx->state[3] = 0x10325476;
    ctx->state[4] = 0xc3d2e1f0;
    ctx->bit_len = 0;
    ctx->block_len = 0;
}

static void mal_sha1_compress(MalSha1 *ctx, const u8 *p) {
    u32 w[80];
    for (int i = 0; i < 16; i++) {
        w[i] = ((u32) p[i * 4] << 24) | ((u32) p[i * 4 + 1] << 16)
            | ((u32) p[i * 4 + 2] << 8) | (u32) p[i * 4 + 3];
    }
    for (int i = 16; i < 80; i++) {
        w[i] = MAL_ROTL(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    u32 a = ctx->state[0], b = ctx->state[1], c = ctx->state[2];
    u32 d = ctx->state[3], e = ctx->state[4];
    for (int i = 0; i < 80; i++) {
        u32 f;
        u32 k;
        if (i < 20) {
            f = (b & c) | (~b & d);
            k = 0x5a827999;
        } else if (i < 40) {
            f = b ^ c ^ d;
            k = 0x6ed9eba1;
        } else if (i < 60) {
            f = (b & c) | (b & d) | (c & d);
            k = 0x8f1bbcdc;
        } else {
            f = b ^ c ^ d;
            k = 0xca62c1d6;
        }
        u32 temp = MAL_ROTL(a, 5) + f + e + k + w[i];
        e = d;
        d = c;
        c = MAL_ROTL(b, 30);
        b = a;
        a = temp;
    }
    ctx->state[0] += a;
    ctx->state[1] += b;
    ctx->state[2] += c;
    ctx->state[3] += d;
    ctx->state[4] += e;
}

static void mal_sha1_update(MalSha1 *ctx, const u8 *data, usize len) {
    for (usize i = 0; i < len; i++) {
        ctx->block[ctx->block_len++] = data[i];
        if (ctx->block_len == 64) {
            mal_sha1_compress(ctx, ctx->block);
            ctx->bit_len += 512;
            ctx->block_len = 0;
        }
    }
}

static void mal_sha1_final(MalSha1 *ctx, u8 out[20]) {
    usize i = ctx->block_len;
    ctx->bit_len += (u64) ctx->block_len * 8;
    ctx->block[i++] = 0x80;
    if (i > 56) {
        while (i < 64) ctx->block[i++] = 0;
        mal_sha1_compress(ctx, ctx->block);
        i = 0;
    }
    while (i < 56) ctx->block[i++] = 0;
    for (int k = 0; k < 8; k++) ctx->block[63 - k] = (u8) (ctx->bit_len >> (k * 8));
    mal_sha1_compress(ctx, ctx->block);
    for (int j = 0; j < 5; j++) {
        out[j * 4] = (u8) (ctx->state[j] >> 24);
        out[j * 4 + 1] = (u8) (ctx->state[j] >> 16);
        out[j * 4 + 2] = (u8) (ctx->state[j] >> 8);
        out[j * 4 + 3] = (u8) ctx->state[j];
    }
}

/* MD5 (RFC 1321), retained only for PostgreSQL's legacy password exchange. */
typedef struct {
    u32 state[4];
    u64 bit_len;
    u8 block[64];
    usize block_len;
} MalMd5;

static const u32 MAL_MD5_K[64] = {
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
    0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
    0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
    0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
    0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
    0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
};

static const u8 MAL_MD5_SHIFT[64] = {
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
};

static void mal_md5_init(MalMd5 *ctx) {
    ctx->state[0] = 0x67452301;
    ctx->state[1] = 0xefcdab89;
    ctx->state[2] = 0x98badcfe;
    ctx->state[3] = 0x10325476;
    ctx->bit_len = 0;
    ctx->block_len = 0;
}

static void mal_md5_compress(MalMd5 *ctx, const u8 *block) {
    u32 words[16];
    for (usize i = 0; i < countof(words); i++) {
        words[i] = (u32) block[i * 4] | ((u32) block[i * 4 + 1] << 8)
            | ((u32) block[i * 4 + 2] << 16) | ((u32) block[i * 4 + 3] << 24);
    }
    u32 a = ctx->state[0];
    u32 b = ctx->state[1];
    u32 c = ctx->state[2];
    u32 d = ctx->state[3];
    for (u32 i = 0; i < 64; i++) {
        u32 f;
        u32 word;
        if (i < 16) {
            f = (b & c) | (~b & d);
            word = i;
        } else if (i < 32) {
            f = (d & b) | (~d & c);
            word = (5 * i + 1) % 16;
        } else if (i < 48) {
            f = b ^ c ^ d;
            word = (3 * i + 5) % 16;
        } else {
            f = c ^ (b | ~d);
            word = (7 * i) % 16;
        }
        u32 next = d;
        d = c;
        c = b;
        b += MAL_ROTL(a + f + MAL_MD5_K[i] + words[word], MAL_MD5_SHIFT[i]);
        a = next;
    }
    ctx->state[0] += a;
    ctx->state[1] += b;
    ctx->state[2] += c;
    ctx->state[3] += d;
}

static void mal_md5_update(MalMd5 *ctx, const u8 *data, usize length) {
    for (usize i = 0; i < length; i++) {
        ctx->block[ctx->block_len++] = data[i];
        if (ctx->block_len == 64) {
            mal_md5_compress(ctx, ctx->block);
            ctx->bit_len += 512;
            ctx->block_len = 0;
        }
    }
}

static void mal_md5_final(MalMd5 *ctx, u8 out[16]) {
    usize i = ctx->block_len;
    ctx->bit_len += (u64) ctx->block_len * 8;
    ctx->block[i++] = 0x80;
    if (i > 56) {
        while (i < 64) ctx->block[i++] = 0;
        mal_md5_compress(ctx, ctx->block);
        i = 0;
    }
    while (i < 56) ctx->block[i++] = 0;
    for (int k = 0; k < 8; k++) ctx->block[56 + k] = (u8) (ctx->bit_len >> (k * 8));
    mal_md5_compress(ctx, ctx->block);
    for (int j = 0; j < 4; j++) {
        out[j * 4] = (u8) ctx->state[j];
        out[j * 4 + 1] = (u8) (ctx->state[j] >> 8);
        out[j * 4 + 2] = (u8) (ctx->state[j] >> 16);
        out[j * 4 + 3] = (u8) (ctx->state[j] >> 24);
    }
}

/* ---------------------------------------------------------------------------
 * The `hash` export.
 * --------------------------------------------------------------------------- */

/* True when `str` is exactly the ASCII literal `ascii` of length `n`. Used for the
 * algorithm and output-encoding checks — both must match one fixed lowercase word,
 * so a code-unit-wise compare (no allocation, no ToLower) is enough. */
static bool mal_node_crypto_str_is(const MalString *str, const char *ascii, usize n) {
    return strlen(ascii) == n && mal_string_equals_ascii(str, ascii);
}

static bool mal_node_crypto_str_is_utf8(const MalString *str) {
    return mal_string_equals_ascii_ci(str, "utf8") ||
        mal_string_equals_ascii_ci(str, "utf-8");
}

// Validate the complete view before applying its byte offset. In particular,
// detached stores have null data, so even adding a zero offset would be undefined.
static bool mal_node_crypto_byte_span(MalVm *vm, MalValue value, MalBufferSourceSpan *out) {
    if (mal_buffer_source_span(value, out) == MAL_BUFFER_SOURCE_SPAN_OK) {
        return true;
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        (const byte *) "crypto.hash: detached or out-of-bounds byte source");
    return false;
}

typedef enum {
    MAL_NODE_CRYPTO_SHA1,
    MAL_NODE_CRYPTO_SHA256,
    MAL_NODE_CRYPTO_MD5,
    MAL_NODE_CRYPTO_HMAC_SHA256,
} MalNodeCryptoStateKind;

typedef struct {
    MalNodeCryptoStateKind kind;
    bool finalized;
    union {
        MalSha1 sha1;
        MalSha256 sha256;
        MalMd5 md5;
        struct {
            MalSha256 inner;
            u8 outer_pad[64];
        } hmac;
    } digest;
} MalNodeCryptoState;

static bool mal_node_crypto_array_buffer_view_span(
    MalVm *vm, MalValue value, MalBufferSourceSpan *out
) {
    if (!mal_value_is_typed_array_object(value) && !mal_value_is_data_view_object(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "crypto: value must be an ArrayBufferView");
        return false;
    }
    return mal_node_crypto_byte_span(vm, value, out);
}

static MalKey mal_node_crypto_state_key(MalValue callee) {
    MalValue marker = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    return (MalKey) {.kind = MAL_KEY_SYMBOL, .value = marker};
}

static MalNodeCryptoState *mal_node_crypto_read_state(
    MalVm *vm, MalValue receiver, MalValue callee
) {
    if (mal_value_is_object(receiver)) {
        MalPropertyLookup lookup = mal_object_get_own(
            mal_value_to_object(receiver), mal_node_crypto_state_key(callee));
        if (lookup.present && mal_value_is_array_buffer_object(lookup.desc.value)) {
            MalArrayBufferObject *buffer = mal_value_to_array_buffer_object(lookup.desc.value);
            if (!buffer->detached && buffer->byte_length == sizeof(MalNodeCryptoState)) {
                return (MalNodeCryptoState *) buffer->data;
            }
        }
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        (const byte *) "crypto digest method called on incompatible receiver");
    return nullptr;
}

static bool mal_node_crypto_require_active(MalVm *vm, MalNodeCryptoState *state) {
    if (!state->finalized) return true;
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        (const byte *) "Digest already called");
    return false;
}

static void mal_node_crypto_state_update(
    MalNodeCryptoState *state, const u8 *data, usize length
) {
    if (state->kind == MAL_NODE_CRYPTO_SHA1) {
        mal_sha1_update(&state->digest.sha1, data, length);
    } else if (state->kind == MAL_NODE_CRYPTO_SHA256) {
        mal_sha256_update(&state->digest.sha256, data, length);
    } else if (state->kind == MAL_NODE_CRYPTO_MD5) {
        mal_md5_update(&state->digest.md5, data, length);
    } else {
        mal_sha256_update(&state->digest.hmac.inner, data, length);
    }
}

static MalValue mal_node_crypto_update(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee
) {
    (void) new_target;
    MalNodeCryptoState *state = mal_node_crypto_read_state(vm, receiver, callee);
    if (state == nullptr || !mal_node_crypto_require_active(vm, state)) {
        return mal_value_new_undefined();
    }
    MalValue data = argc > 0 ? args[0] : mal_value_new_undefined();
    if (mal_value_is_string(data)) {
        if (argc > 1 && !mal_value_is_undefined(args[1])) {
            if (!mal_value_is_string(args[1])
                || !mal_node_crypto_str_is_utf8(mal_value_to_string(args[1]))) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    (const byte *) "crypto.update: only utf8 string input is supported");
                return mal_value_new_undefined();
            }
        }
        MalString *string = mal_value_to_string(data);
        usize length;
        byte *bytes = mal_string_to_utf8(string, &length);
        if (bytes == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        mal_node_crypto_state_update(state, (const u8 *) bytes, length);
        free(bytes);
        return receiver;
    }

    MalBufferSourceSpan span;
    if (!mal_node_crypto_array_buffer_view_span(vm, data, &span)) {
        return mal_value_new_undefined();
    }
    if (span.length > 0) mal_node_crypto_state_update(state, span.data, span.length);
    return receiver;
}

static MalValue mal_node_crypto_base64(MalVm *vm, const u8 *bytes, usize length) {
    char encoded[44];
    usize output = mal_base64_encode(
        (const byte *) bytes, length, MAL_BASE64_ALPHABET_STANDARD, true, encoded);
    return mal_value_from_string(
        mal_string_new_ascii(&vm->heap, (const byte *) encoded, output));
}

static MalValue mal_node_crypto_digest_bytes(
    MalVm *vm, const u8 *bytes, usize length, MalValue encoding) {
    if (mal_value_is_undefined(encoding)) {
        byte *owned = length == 0 ? nullptr : malloc(length);
        if (length > 0 && owned == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        if (length > 0) memcpy(owned, bytes, length);
        return mal_node_buffer_from_owned_bytes(vm, owned, length);
    }
    if (!mal_value_is_string(encoding)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "crypto.digest: encoding must be a string");
        return mal_value_new_undefined();
    }
    MalString *name = mal_value_to_string(encoding);
    if (mal_node_crypto_str_is(name, "base64", 6)) {
        return mal_node_crypto_base64(vm, bytes, length);
    }
    if (mal_node_crypto_str_is(name, "hex", 3)) {
        char encoded[64];
        mal_hex_encode_lower((const byte *) bytes, length, encoded);
        return mal_value_from_string(
            mal_string_new_ascii(&vm->heap, (const byte *) encoded, length * 2));
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        (const byte *) "crypto.digest: unsupported output encoding");
    return mal_value_new_undefined();
}

static MalValue mal_node_crypto_digest(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee
) {
    (void) new_target;
    MalNodeCryptoState *state = mal_node_crypto_read_state(vm, receiver, callee);
    if (state == nullptr || !mal_node_crypto_require_active(vm, state)) {
        return mal_value_new_undefined();
    }
    state->finalized = true;
    u8 result[32];
    usize length;
    if (state->kind == MAL_NODE_CRYPTO_SHA1) {
        mal_sha1_final(&state->digest.sha1, result);
        length = 20;
    } else if (state->kind == MAL_NODE_CRYPTO_SHA256) {
        mal_sha256_final(&state->digest.sha256, result);
        length = 32;
    } else if (state->kind == MAL_NODE_CRYPTO_MD5) {
        mal_md5_final(&state->digest.md5, result);
        length = 16;
    } else {
        u8 inner[32];
        mal_sha256_final(&state->digest.hmac.inner, inner);
        MalSha256 outer;
        mal_sha256_init(&outer);
        mal_sha256_update(&outer, state->digest.hmac.outer_pad, 64);
        mal_sha256_update(&outer, inner, sizeof(inner));
        mal_sha256_final(&outer, result);
        length = 32;
    }
    MalValue encoding = argc > 0 ? args[0] : mal_value_new_undefined();
    return mal_node_crypto_digest_bytes(vm, result, length, encoding);
}

static MalValue mal_node_crypto_new_state(
    MalVm *vm, MalValue callee, const MalNodeCryptoState *initial
) {
    MalValue roots[] = {
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_native_function_object_get_slot(
            mal_value_to_native_function_object(callee), 0),
        mal_native_function_object_get_slot(
            mal_value_to_native_function_object(callee), 1),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalArrayBufferObject *buffer = mal_array_buffer_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        (u32) sizeof(*initial), (u32) sizeof(*initial), false, false);
    roots[0] = mal_value_from_array_buffer_object(buffer);
    memcpy(buffer->data, initial, sizeof(*initial));
    roots[1] = mal_value_from_object(
        mal_object_new(&vm->heap, mal_value_to_object(roots[3])));
    MalPropertyDesc state_desc = mal_intrinsic_data_desc(roots[0], MAL_PROPERTY_NONE);
    mal_object_define_own(mal_value_to_object(roots[1]),
        (MalKey) {.kind = MAL_KEY_SYMBOL, .value = roots[2]}, &state_desc);
    MalValue result = roots[1];
    mal_gc_unroot(&root);
    return result;
}

static MalValue mal_node_crypto_create_hash(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee
) {
    (void) receiver;
    (void) new_target;
    if (argc < 1 || !mal_value_is_string(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "crypto.createHash: algorithm must be a string");
        return mal_value_new_undefined();
    }
    MalString *algorithm = mal_value_to_string(args[0]);
    MalNodeCryptoState state = {0};
    if (mal_node_crypto_str_is(algorithm, "sha1", 4)) {
        state.kind = MAL_NODE_CRYPTO_SHA1;
        mal_sha1_init(&state.digest.sha1);
    } else if (mal_node_crypto_str_is(algorithm, "sha256", 6)) {
        state.kind = MAL_NODE_CRYPTO_SHA256;
        mal_sha256_init(&state.digest.sha256);
    } else if (mal_node_crypto_str_is(algorithm, "md5", 3)) {
        state.kind = MAL_NODE_CRYPTO_MD5;
        mal_md5_init(&state.digest.md5);
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "crypto.createHash: unsupported algorithm");
        return mal_value_new_undefined();
    }
    return mal_node_crypto_new_state(vm, callee, &state);
}

static bool mal_node_crypto_hmac_init(
    MalVm *vm, MalNodeCryptoState *state, MalValue key
) {
    u8 key_block[64] = {0};
    if (mal_value_is_string(key)) {
        MalString *string = mal_value_to_string(key);
        usize length;
        byte *bytes = mal_string_to_utf8(string, &length);
        if (bytes == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        if (length > sizeof(key_block)) {
            MalSha256 key_hash;
            mal_sha256_init(&key_hash);
            mal_sha256_update(&key_hash, (const u8 *) bytes, length);
            mal_sha256_final(&key_hash, key_block);
        } else if (length > 0) {
            memcpy(key_block, bytes, length);
        }
        free(bytes);
    } else {
        MalBufferSourceSpan span;
        if (!mal_node_crypto_array_buffer_view_span(vm, key, &span)) return false;
        if (span.length > sizeof(key_block)) {
            MalSha256 key_hash;
            mal_sha256_init(&key_hash);
            mal_sha256_update(&key_hash, span.data, span.length);
            mal_sha256_final(&key_hash, key_block);
        } else if (span.length > 0) {
            memcpy(key_block, span.data, span.length);
        }
    }

    state->kind = MAL_NODE_CRYPTO_HMAC_SHA256;
    state->finalized = false;
    mal_sha256_init(&state->digest.hmac.inner);
    u8 inner_pad[64];
    for (usize i = 0; i < sizeof(key_block); i++) {
        inner_pad[i] = key_block[i] ^ 0x36;
        state->digest.hmac.outer_pad[i] = key_block[i] ^ 0x5c;
    }
    mal_sha256_update(&state->digest.hmac.inner, inner_pad, sizeof(inner_pad));
    return true;
}

static void mal_node_crypto_hmac_init_bytes(
    MalNodeCryptoState *state, const u8 *key, usize length) {
    u8 key_block[64] = {0};
    if (length > sizeof(key_block)) {
        MalSha256 key_hash;
        mal_sha256_init(&key_hash);
        mal_sha256_update(&key_hash, key, length);
        mal_sha256_final(&key_hash, key_block);
    } else if (length > 0) {
        memcpy(key_block, key, length);
    }
    state->kind = MAL_NODE_CRYPTO_HMAC_SHA256;
    state->finalized = false;
    mal_sha256_init(&state->digest.hmac.inner);
    u8 inner_pad[64];
    for (usize i = 0; i < sizeof(key_block); i++) {
        inner_pad[i] = key_block[i] ^ 0x36;
        state->digest.hmac.outer_pad[i] = key_block[i] ^ 0x5c;
    }
    mal_sha256_update(&state->digest.hmac.inner, inner_pad, sizeof(inner_pad));
}

static void mal_node_crypto_hmac_final(MalNodeCryptoState *state, u8 result[32]) {
    u8 inner[32];
    mal_sha256_final(&state->digest.hmac.inner, inner);
    MalSha256 outer;
    mal_sha256_init(&outer);
    mal_sha256_update(&outer, state->digest.hmac.outer_pad, 64);
    mal_sha256_update(&outer, inner, sizeof(inner));
    mal_sha256_final(&outer, result);
}

static void mal_node_crypto_hmac_bytes(
    const u8 *key, usize key_length, const u8 *first, usize first_length,
    const u8 *second, usize second_length, u8 result[32]) {
    MalNodeCryptoState state;
    mal_node_crypto_hmac_init_bytes(&state, key, key_length);
    if (first_length > 0) mal_node_crypto_state_update(&state, first, first_length);
    if (second_length > 0) mal_node_crypto_state_update(&state, second, second_length);
    mal_node_crypto_hmac_final(&state, result);
}

static MalValue mal_node_crypto_create_hmac(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee
) {
    (void) receiver;
    (void) new_target;
    if (argc < 1 || !mal_value_is_string(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "crypto.createHmac: algorithm must be a string");
        return mal_value_new_undefined();
    }
    if (!mal_node_crypto_str_is(mal_value_to_string(args[0]), "sha256", 6)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "crypto.createHmac: only sha256 is supported");
        return mal_value_new_undefined();
    }
    if (argc < 2) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "crypto.createHmac: key is required");
        return mal_value_new_undefined();
    }
    MalNodeCryptoState state = {0};
    if (!mal_node_crypto_hmac_init(vm, &state, args[1])) {
        return mal_value_new_undefined();
    }
    return mal_node_crypto_new_state(vm, callee, &state);
}

static bool mal_node_crypto_integer(
    MalVm *vm, MalValue value, f64 minimum, f64 maximum, const char *message,
    usize *result) {
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) return false;
    if (!isfinite(number) || trunc(number) != number
        || number < minimum || number > maximum) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) message);
        return false;
    }
    *result = (usize) number;
    return true;
}

static MalValue mal_node_crypto_random_bytes(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    usize length;
    if (argc < 1 || !mal_node_crypto_integer(vm, args[0], 0, INT32_MAX,
            "crypto.randomBytes: size is out of range", &length)) {
        return mal_value_new_undefined();
    }
    byte *bytes = length == 0 ? nullptr : malloc(length);
    if (length > 0 && bytes == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    if (mal_host_entropy(bytes, length) != 0) {
        free(bytes);
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            (const byte *) "crypto.randomBytes: host entropy unavailable");
        return mal_value_new_undefined();
    }
    return mal_node_buffer_from_owned_bytes(vm, bytes, length);
}

static bool mal_node_crypto_input_bytes(
    MalVm *vm, MalValue value, const char *message,
    MalBufferSourceSpan *span, byte **owned) {
    *owned = nullptr;
    if (mal_value_is_string(value)) {
        usize length;
        *owned = mal_string_to_utf8(mal_value_to_string(value), &length);
        if (*owned == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        *span = (MalBufferSourceSpan) {.data = *owned, .length = length};
        return true;
    }
    if (!mal_value_is_typed_array_object(value) && !mal_value_is_data_view_object(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) message);
        return false;
    }
    return mal_node_crypto_byte_span(vm, value, span);
}

static MalValue mal_node_crypto_pbkdf2_sync(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 5 || !mal_value_is_string(args[4])
        || !mal_node_crypto_str_is(mal_value_to_string(args[4]), "sha256", 6)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "crypto.pbkdf2Sync: only sha256 is supported");
        return mal_value_new_undefined();
    }
    usize iterations;
    usize key_length;
    if (!mal_node_crypto_integer(vm, args[2], 1, UINT32_MAX,
            "crypto.pbkdf2Sync: iterations are out of range", &iterations)
        || !mal_node_crypto_integer(vm, args[3], 0, INT32_MAX,
            "crypto.pbkdf2Sync: key length is out of range", &key_length)) {
        return mal_value_new_undefined();
    }
    MalBufferSourceSpan password;
    MalBufferSourceSpan salt;
    byte *owned_password;
    byte *owned_salt;
    if (!mal_node_crypto_input_bytes(vm, args[0],
            "crypto.pbkdf2Sync: password must be a string or ArrayBufferView",
            &password, &owned_password)) {
        return mal_value_new_undefined();
    }
    if (!mal_node_crypto_input_bytes(vm, args[1],
            "crypto.pbkdf2Sync: salt must be a string or ArrayBufferView",
            &salt, &owned_salt)) {
        free(owned_password);
        return mal_value_new_undefined();
    }
    byte *output = key_length == 0 ? nullptr : malloc(key_length);
    if (key_length > 0 && output == nullptr) {
        free(owned_password);
        free(owned_salt);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    usize blocks = (key_length + 31) / 32;
    for (usize block = 1; block <= blocks; block++) {
        u8 index[4] = {
            (u8) (block >> 24), (u8) (block >> 16),
            (u8) (block >> 8), (u8) block,
        };
        u8 value[32];
        u8 accumulated[32];
        mal_node_crypto_hmac_bytes(password.data, password.length,
            salt.data, salt.length, index, sizeof(index), value);
        memcpy(accumulated, value, sizeof(accumulated));
        for (usize round = 1; round < iterations; round++) {
            mal_node_crypto_hmac_bytes(password.data, password.length,
                value, sizeof(value), nullptr, 0, value);
            for (usize i = 0; i < sizeof(accumulated); i++) accumulated[i] ^= value[i];
        }
        usize offset = (block - 1) * 32;
        usize selected = key_length - offset;
        if (selected > sizeof(accumulated)) selected = sizeof(accumulated);
        memcpy(output + offset, accumulated, selected);
    }
    free(owned_password);
    free(owned_salt);
    return mal_node_buffer_from_owned_bytes(vm, output, key_length);
}

static MalValue mal_node_crypto_timing_safe_equal(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee
) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalBufferSourceSpan left;
    MalBufferSourceSpan right;
    if (argc < 1 || !mal_node_crypto_array_buffer_view_span(vm, args[0], &left)) {
        return mal_value_new_undefined();
    }
    if (argc < 2 || !mal_node_crypto_array_buffer_view_span(vm, args[1], &right)) {
        return mal_value_new_undefined();
    }
    if (left.length != right.length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "Input buffers must have the same byte length");
        return mal_value_new_undefined();
    }
    const volatile u8 *left_bytes = left.data;
    const volatile u8 *right_bytes = right.data;
    volatile u8 difference = 0;
    for (usize i = 0; i < left.length; i++) {
        difference |= left_bytes[i] ^ right_bytes[i];
    }
    return mal_value_new_boolean(difference == 0);
}

static MalValue mal_node_crypto_hash(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;

    MalValue algorithm = argc >= 1 ? args[0] : mal_value_new_undefined();
    MalValue data = argc >= 2 ? args[1] : mal_value_new_undefined();
    MalValue encoding = argc >= 3 ? args[2] : mal_value_new_undefined();

    // Algorithm: a primitive string exactly equal to "sha256".
    if (!mal_value_is_string(algorithm)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "crypto.hash: algorithm must be a string");
        return mal_value_new_undefined();
    }
    MalString *algorithm_str = mal_value_to_string(algorithm);
    if (!mal_node_crypto_str_is(algorithm_str, "sha256", 6)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "crypto.hash: only the \"sha256\" algorithm is supported");
        return mal_value_new_undefined();
    }

    // Output encoding: a primitive string exactly equal to lowercase "hex".
    // Validate it before extracting any raw byte pointer below.
    if (!mal_value_is_undefined(encoding)) {
        if (!mal_value_is_string(encoding)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                (const byte *) "crypto.hash: output encoding must be a string");
            return mal_value_new_undefined();
        }
        MalString *encoding_str = mal_value_to_string(encoding);
        if (!mal_node_crypto_str_is(encoding_str, "hex", 3)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                (const byte *) "crypto.hash: only the \"hex\" output encoding is supported");
            return mal_value_new_undefined();
        }
    }

    bool data_is_byte_source = mal_value_is_typed_array_object(data)
        || mal_value_is_data_view_object(data) || mal_value_is_array_buffer_object(data);
    if (!mal_value_is_string(data) && !data_is_byte_source) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "crypto.hash: data must be a string or byte source");
        return mal_value_new_undefined();
    }

    // ArrayBuffers and views are hashed as raw bytes; strings use their UTF-8
    // encoding. SHA-256 itself never allocates, so a raw pointer remains valid.
    MalSha256 ctx;
    mal_sha256_init(&ctx);
    if (data_is_byte_source) {
        MalBufferSourceSpan span;
        if (!mal_node_crypto_byte_span(vm, data, &span)) {
            return mal_value_new_undefined();
        }
        if (span.length > 0) {
            mal_sha256_update(&ctx, span.data, span.length);
        }
    } else {
        MalString *data_str = mal_value_to_string(data);
        usize byte_len;
        byte *bytes = mal_string_to_utf8(data_str, &byte_len);
        if (bytes == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        mal_sha256_update(&ctx, (const u8 *) bytes, byte_len);
        free(bytes);
    }

    u8 digest[32];
    mal_sha256_final(&ctx, digest);

    char hex[64];
    mal_hex_encode_lower((const byte *) digest, countof(digest), hex);
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, (const byte *) hex, 64));
}

/* RFC 4122 version 4 UUID using the engine-neutral host entropy boundary. */
static MalValue mal_node_crypto_random_uuid(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) this_value;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;

    u8 bytes[16];
    if (mal_host_entropy(bytes, sizeof(bytes)) != 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            (const byte *) "crypto.randomUUID: host entropy unavailable");
        return mal_value_new_undefined();
    }
    bytes[6] = (u8) ((bytes[6] & 0x0f) | 0x40);
    bytes[8] = (u8) ((bytes[8] & 0x3f) | 0x80);

    char uuid[36];
    usize out = 0;
    for (usize i = 0; i < countof(bytes); i++) {
        if (i == 4 || i == 6 || i == 8 || i == 10) {
            uuid[out++] = '-';
        }
        mal_hex_encode_byte_lower((byte) bytes[i], uuid + out);
        out += 2;
    }
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, (const byte *) uuid, out));
}

static MalNativeFunctionObject *mal_node_crypto_function_with_slots(
    MalVm *vm, const char *name, i32 length, MalNativeFunctionCallback callback,
    const MalValue *slots, i32 slot_count
) {
    return mal_native_function_object_new_with_slots_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), length, callback, slots, slot_count);
}

void mal_host_install_node_crypto(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue cached = vm->intrinsics[MAL_INTRINSIC_NODE_CRYPTO_MODULE];
    if (!mal_value_is_undefined(cached)) {
        mal_node_module_publish(vm, slots, count, cached);
        return;
    }

    MalValue roots[8];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[0] = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    roots[1] = mal_value_from_object(mal_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])));

    roots[2] = mal_value_from_native_function_object(mal_node_crypto_function_with_slots(
        vm, "update", 2, mal_node_crypto_update, roots, 1));
    roots[3] = mal_value_from_native_function_object(mal_node_crypto_function_with_slots(
        vm, "digest", 1, mal_node_crypto_digest, roots, 1));
    MalPropertyFlags method_flags =
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), (const byte *) "update",
        roots[2], method_flags);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), (const byte *) "digest",
        roots[3], method_flags);

    MalValue factory_slots[] = {roots[0], roots[1]};
    roots[4] = mal_value_from_native_function_object(mal_node_crypto_function_with_slots(
        vm, "createHash", 2, mal_node_crypto_create_hash, factory_slots,
        countof(factory_slots)));
    roots[5] = mal_value_from_native_function_object(mal_node_crypto_function_with_slots(
        vm, "createHmac", 3, mal_node_crypto_create_hmac, factory_slots,
        countof(factory_slots)));
    roots[6] = mal_value_from_native_function_object(mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "timingSafeEqual"), 0,
        mal_node_crypto_timing_safe_equal));

    roots[7] = mal_value_from_object(mal_intrinsic_new_object(vm));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[7]),
        (const byte *) "createHash", roots[4], method_flags);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[7]),
        (const byte *) "createHmac", roots[5], method_flags);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[7]),
        (const byte *) "timingSafeEqual", roots[6], method_flags);

    MalObject *function_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalValue scratch = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(&vm->heap, function_prototype,
            mal_intrinsic_ascii(vm, (const byte *) "hash"), 3, mal_node_crypto_hash));
    MalRootSpan scratch_root;
    mal_gc_root(&scratch_root, &scratch, 1);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[7]),
        (const byte *) "hash", scratch, method_flags);
    mal_gc_unroot(&scratch_root);
    scratch = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(&vm->heap, function_prototype,
            mal_intrinsic_ascii(vm, (const byte *) "pbkdf2Sync"), 5,
            mal_node_crypto_pbkdf2_sync));
    mal_gc_root(&scratch_root, &scratch, 1);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[7]),
        (const byte *) "pbkdf2Sync", scratch, method_flags);
    mal_gc_unroot(&scratch_root);
    scratch = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(&vm->heap, function_prototype,
            mal_intrinsic_ascii(vm, (const byte *) "randomBytes"), 2,
            mal_node_crypto_random_bytes));
    mal_gc_root(&scratch_root, &scratch, 1);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[7]),
        (const byte *) "randomBytes", scratch, method_flags);
    mal_gc_unroot(&scratch_root);
    scratch = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(&vm->heap, function_prototype,
            mal_intrinsic_ascii(vm, (const byte *) "randomUUID"), 1,
            mal_node_crypto_random_uuid));
    mal_gc_root(&scratch_root, &scratch, 1);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[7]),
        (const byte *) "randomUUID", scratch, method_flags);
    mal_gc_unroot(&scratch_root);
    vm->intrinsics[MAL_INTRINSIC_NODE_CRYPTO_MODULE] = roots[7];
    mal_node_module_publish(vm, slots, count, roots[7]);
    mal_gc_unroot(&root);
}

#endif // MAL_NODE
