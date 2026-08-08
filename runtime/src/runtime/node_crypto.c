#include "node_crypto.h"

#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ascii.h"
#include "argon2.h"
#include "array_buffer_object.h"
#include "async_context.h"
#include "base64.h"
#include "builtin_data_view.h"
#include "builtin_math.h"
#include "function_object.h"
#include "gc.h"
#include "entropy.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "hex.h"
#include "host.h"
#include "intrinsics.h"
#include "node_buffer.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "secure_scrub.h"
#include "utf8.h"
#include "typed_array_object.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"
#include "web_host_timer.h"

#if MAL_NODE

#include "mal_argon2.h"

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
 * Node-shaped errors.
 *
 * These messages are compared verbatim against the supported Node release by
 * tests/local/node-crypto-differential.mts, so the wording, punctuation, and
 * the "Received ..." clause are all load-bearing.
 * --------------------------------------------------------------------------- */

#define CRYPTO_MESSAGE_CAPACITY 512

/* The byte-source list Node names in its Argon2 / hash type errors. */
#define CRYPTO_BYTE_SOURCE_TEXT \
    "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView"

static void crypto_throw(MalVm *vm, MalIntrinsic prototype, const char *message) {
    mal_vm_throw_error(vm, prototype, (const byte *) message);
}

static void crypto_copy_string(const MalString *string, char *out, usize capacity) {
    usize length = 0;
    byte *utf8 = mal_string_to_utf8((MalString *) string, &length);
    if (utf8 == nullptr) {
        out[0] = '\0';
        return;
    }
    if (length >= capacity) length = capacity - 1;
    memcpy(out, utf8, length);
    out[length] = '\0';
    free(utf8);
}

/* Node renders `${value}` for numbers, i.e. Number::toString. */
static void crypto_number_text(MalVm *vm, MalValue value, char *out, usize capacity) {
    crypto_copy_string(mal_ops_to_string(&vm->heap, value), out, capacity);
}

/* ERR_OUT_OF_RANGE groups an integer received value in threes, but only above
 * 2^32 (`281_474_976_710_656`, yet a plain `2147483648`). */
static void crypto_received_number(MalVm *vm, MalValue value, char *out, usize capacity) {
    char plain[128];
    crypto_number_text(vm, value, plain, sizeof(plain));
    if (!mal_ops_is_number(value)) {
        snprintf(out, capacity, "%s", plain);
        return;
    }
    f64 raw = mal_ops_number_as_f64(value);
    if (!isfinite(raw) || trunc(raw) != raw
        || (raw <= 4294967296.0 && raw >= -4294967296.0)) {
        snprintf(out, capacity, "%s", plain);
        return;
    }
    // Group the digits (not the sign) in threes from the right.
    usize start = plain[0] == '-' ? 1 : 0;
    usize digits = strlen(plain) - start;
    usize written = 0;
    for (usize i = 0; i < start && written + 1 < capacity; i++) out[written++] = plain[i];
    for (usize i = 0; i < digits && written + 2 < capacity; i++) {
        if (i > 0 && (digits - i) % 3 == 0) out[written++] = '_';
        out[written++] = plain[start + i];
    }
    out[written] = '\0';
}

static bool crypto_constructor_name(MalVm *vm, MalValue value, char *out, usize capacity) {
    MalValue constructor;
    MalKey constructor_key = mal_key_from_value(
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "constructor")));
    if (!mal_vm_get_property(vm, value, constructor_key, &constructor)) {
        vm->completion.kind = MAL_COMPLETION_NORMAL;
        return false;
    }
    if (!mal_value_is_object(constructor)) return false;
    MalValue name;
    MalKey name_key = mal_key_from_value(
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "name")));
    if (!mal_vm_get_property(vm, constructor, name_key, &name)) {
        vm->completion.kind = MAL_COMPLETION_NORMAL;
        return false;
    }
    if (!mal_value_is_string(name) || mal_string_length(mal_value_to_string(name)) == 0) {
        return false;
    }
    crypto_copy_string(mal_value_to_string(name), out, capacity);
    return true;
}

/* The clause Node appends after "Received ". Mirrors lib/internal/errors.js:
 * nullish values print bare, objects print their constructor, and every other
 * primitive prints `type <typeof> (<inspected>)` with the inspected form
 * truncated at 25 characters. */
static void crypto_received(MalVm *vm, MalValue value, char *out, usize capacity) {
    if (mal_value_is_null(value)) {
        snprintf(out, capacity, "null");
        return;
    }
    if (mal_value_is_undefined(value)) {
        snprintf(out, capacity, "undefined");
        return;
    }
    if (mal_value_is_callable(value)) {
        char name[128] = {0};
        MalValue function_name;
        MalKey name_key = mal_key_from_value(
            mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "name")));
        if (mal_vm_get_property(vm, value, name_key, &function_name)
            && mal_value_is_string(function_name)
            && mal_string_length(mal_value_to_string(function_name)) > 0) {
            crypto_copy_string(mal_value_to_string(function_name), name, sizeof(name));
            snprintf(out, capacity, "function %s", name);
            return;
        }
        vm->completion.kind = MAL_COMPLETION_NORMAL;
    }
    if (mal_value_is_object(value)) {
        char name[128] = {0};
        if (crypto_constructor_name(vm, value, name, sizeof(name))) {
            snprintf(out, capacity, "an instance of %s", name);
        } else {
            snprintf(out, capacity, "[Object: null prototype] {}");
        }
        return;
    }
    char inspected[64] = {0};
    const char *type_name = "object";
    if (mal_value_is_boolean(value)) {
        type_name = "boolean";
        snprintf(inspected, sizeof(inspected), "%s",
            mal_value_is_truthy(value) ? "true" : "false");
    } else if (mal_value_is_string(value)) {
        type_name = "string";
        char text[64] = {0};
        crypto_copy_string(mal_value_to_string(value), text, sizeof(text));
        snprintf(inspected, sizeof(inspected), "'%s'", text);
    } else if (mal_value_is_symbol(value)) {
        type_name = "symbol";
        snprintf(inspected, sizeof(inspected), "Symbol()");
    } else if (mal_value_is_bigint(value)) {
        type_name = "bigint";
        char text[48] = {0};
        crypto_copy_string(mal_ops_to_string(&vm->heap, value), text, sizeof(text));
        snprintf(inspected, sizeof(inspected), "%sn", text);
    } else {
        type_name = "number";
        crypto_number_text(vm, value, inspected, sizeof(inspected));
    }
    if (strlen(inspected) > 25) {
        inspected[25] = '\0';
        snprintf(out, capacity, "type %s (%s...)", type_name, inspected);
        return;
    }
    snprintf(out, capacity, "type %s (%s)", type_name, inspected);
}

/* ERR_INVALID_ARG_TYPE for a positional argument. */
static void crypto_throw_arg_type(
    MalVm *vm, const char *name, const char *expected, MalValue actual) {
    char received[CRYPTO_MESSAGE_CAPACITY / 2];
    crypto_received(vm, actual, received, sizeof(received));
    char message[CRYPTO_MESSAGE_CAPACITY];
    snprintf(message, sizeof(message), "The \"%s\" argument must be %s. Received %s",
        name, expected, received);
    crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
}

/* ERR_INVALID_ARG_TYPE for an option-bag property. */
static void crypto_throw_property_type(
    MalVm *vm, const char *name, const char *expected, MalValue actual) {
    char received[CRYPTO_MESSAGE_CAPACITY / 2];
    crypto_received(vm, actual, received, sizeof(received));
    char message[CRYPTO_MESSAGE_CAPACITY];
    snprintf(message, sizeof(message), "The \"%s\" property must be %s. Received %s",
        name, expected, received);
    crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
}

static void crypto_throw_out_of_range(
    MalVm *vm, const char *name, const char *range, MalValue actual) {
    char received[CRYPTO_MESSAGE_CAPACITY / 2];
    crypto_received_number(vm, actual, received, sizeof(received));
    char message[CRYPTO_MESSAGE_CAPACITY];
    snprintf(message, sizeof(message),
        "The value of \"%s\" is out of range. It must be %s. Received %s",
        name, range, received);
    crypto_throw(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, message);
}

/* ---------------------------------------------------------------------------
 * Shared argument helpers.
 * --------------------------------------------------------------------------- */

static void crypto_scrub_free(byte *bytes, usize length) {
    mal_secure_scrub(bytes, length);
    free(bytes);
}

/* True when `str` is exactly the ASCII literal `ascii` of length `n`. Used for the
 * algorithm and output-encoding checks — both must match one fixed lowercase word,
 * so a code-unit-wise compare (no allocation, no ToLower) is enough. */
static bool mal_node_crypto_str_is(const MalString *str, const char *ascii, usize n) {
    return strlen(ascii) == n && mal_string_equals_ascii(str, ascii);
}

// Validate the complete view before applying its byte offset. In particular,
// detached stores have null data, so even adding a zero offset would be undefined.
static bool mal_node_crypto_byte_span(MalVm *vm, MalValue value, MalBufferSourceSpan *out) {
    if (mal_buffer_source_span(value, out) == MAL_BUFFER_SOURCE_SPAN_OK) {
        return true;
    }
    crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "crypto: detached or out-of-bounds byte source");
    return false;
}

static bool crypto_is_byte_source(MalValue value) {
    return mal_value_is_typed_array_object(value) || mal_value_is_data_view_object(value)
        || mal_value_is_array_buffer_object(value);
}

/* Node accepts an ArrayBuffer wherever it accepts a view for these APIs
 * (timingSafeEqual, the HMAC key, every Argon2 byte input). */
static bool crypto_byte_source_span(
    MalVm *vm, MalValue value, const char *name, MalBufferSourceSpan *out) {
    if (!crypto_is_byte_source(value)) {
        char message[CRYPTO_MESSAGE_CAPACITY];
        snprintf(message, sizeof(message),
            "The \"%s\" argument must be an instance of ArrayBuffer, Buffer, "
            "TypedArray, or DataView.", name);
        crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
        return false;
    }
    return mal_node_crypto_byte_span(vm, value, out);
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
    crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "crypto digest method called on incompatible receiver");
    return nullptr;
}

static bool mal_node_crypto_require_active(MalVm *vm, MalNodeCryptoState *state) {
    if (!state->finalized) return true;
    crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Digest already called");
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
        // Any Buffer encoding is accepted; an unrecognized one falls back to
        // UTF-8 rather than throwing, matching Node's StringBytes::Write.
        MalValue encoding = argc > 1 ? args[1] : mal_value_new_undefined();
        usize length = 0;
        byte *bytes = mal_node_buffer_decode_string(vm, data, encoding, &length);
        if (bytes == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        mal_node_crypto_state_update(state, (const u8 *) bytes, length);
        // Absorbed, and this copy is ours. A passcode reaches HMAC through here.
        crypto_scrub_free(bytes, length);
        return receiver;
    }

    MalBufferSourceSpan span;
    if (!crypto_byte_source_span(vm, data, "data", &span)) {
        return mal_value_new_undefined();
    }
    if (span.length > 0) {
        mal_node_crypto_state_update(state, (const u8 *) span.data, span.length);
    }
    return receiver;
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
        mal_secure_scrub((byte *) inner, sizeof(inner));
        mal_secure_scrub((byte *) &outer, sizeof(outer));
    }
    // `result` already holds the digest, so the absorbing state is spent. For
    // HMAC it is the outer pad — the key XOR 0x5c, and so the key — which
    // otherwise outlived the object in the freed backing store. Only the union
    // is cleared: `kind` and `finalized` must survive to keep refusing a second
    // digest() on this receiver.
    mal_secure_scrub((byte *) &state->digest, sizeof(state->digest));
    MalValue encoding = argc > 0 ? args[0] : mal_value_new_undefined();
    // Node's ParseEncoding falls back to BUFFER here, so an unrecognized
    // encoding returns the raw digest instead of throwing. crypto.hash() below
    // is the call site that does throw.
    // A Buffer result is secret-bearing: an HMAC digest is an authentication
    // tag, and a session token is exactly what this returns.
    MalValue encoded = mal_node_buffer_encode_secret_bytes(
        vm, (const byte *) result, length, encoding, false);
    // The returned Buffer owns a separate sensitive store. Do not leave the tag
    // in this native frame after it has been materialized (string results cannot
    // be scrubbed, but this temporary copy still can).
    mal_secure_scrub(result, sizeof(result));
    return encoded;
}

/*
 * Publish a digest state as a fresh object holding it in a private-symbol slot.
 *
 * `initial` is the caller's stack copy and is scrubbed before this returns on
 * every path — for HMAC it is the outer pad, which is the key XOR 0x5c. Taking
 * it by non-const pointer and clearing it here is what keeps a caller from
 * forgetting: createHmac cannot leave the key on its frame.
 */
static MalValue mal_node_crypto_new_state(
    MalVm *vm, MalValue callee, MalNodeCryptoState *initial
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
    // Sensitive: the store outlives the object only as freed memory otherwise,
    // and for HMAC it holds the key-derived pads for the receiver's whole life.
    MalArrayBufferObject *buffer = mal_array_buffer_object_new_sensitive(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        (u32) sizeof(*initial));
    roots[0] = mal_value_from_array_buffer_object(buffer);
    if (buffer->data == nullptr) {
        mal_gc_unroot(&root);
        mal_secure_scrub((byte *) initial, sizeof(*initial));
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    memcpy(buffer->data, initial, sizeof(*initial));
    roots[1] = mal_value_from_object(
        mal_object_new(&vm->heap, mal_value_to_object(roots[3])));
    MalPropertyDesc state_desc = mal_intrinsic_data_desc(roots[0], MAL_PROPERTY_NONE);
    mal_object_define_own(mal_value_to_object(roots[1]),
        (MalKey) {.kind = MAL_KEY_SYMBOL, .value = roots[2]}, &state_desc);
    MalValue result = roots[1];
    mal_gc_unroot(&root);
    mal_secure_scrub((byte *) initial, sizeof(*initial));
    return result;
}

static MalValue mal_node_crypto_create_hash(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee
) {
    (void) receiver;
    (void) new_target;
    if (argc < 1 || !mal_value_is_string(args[0])) {
        crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "crypto.createHash: algorithm must be a string");
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
        crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "crypto.createHash: unsupported algorithm");
        return mal_value_new_undefined();
    }
    return mal_node_crypto_new_state(vm, callee, &state);
}

static void mal_node_crypto_hmac_init_bytes(
    MalNodeCryptoState *state, const u8 *key, usize length) {
    u8 key_block[64] = {0};
    if (length > sizeof(key_block)) {
        MalSha256 key_hash;
        mal_sha256_init(&key_hash);
        mal_sha256_update(&key_hash, key, length);
        mal_sha256_final(&key_hash, key_block);
        mal_secure_scrub((byte *) &key_hash, sizeof(key_hash));
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
    // The key block is the key (or its digest), and the inner pad is one XOR
    // away from it. Both are absorbed by now; only the two pads inside `state`
    // must survive, and those the caller scrubs when it finalizes.
    mal_secure_scrub(key_block, sizeof(key_block));
    mal_secure_scrub(inner_pad, sizeof(inner_pad));
}

static bool mal_node_crypto_hmac_init(
    MalVm *vm, MalNodeCryptoState *state, MalValue key
) {
    if (mal_value_is_string(key)) {
        MalString *string = mal_value_to_string(key);
        usize length;
        byte *bytes = mal_string_to_utf8(string, &length);
        if (bytes == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        mal_node_crypto_hmac_init_bytes(state, (const u8 *) bytes, length);
        // This is the HMAC key, materialized by us from a JavaScript string.
        crypto_scrub_free(bytes, length);
        return true;
    }
    MalBufferSourceSpan span;
    if (!crypto_byte_source_span(vm, key, "key", &span)) return false;
    mal_node_crypto_hmac_init_bytes(state, (const u8 *) span.data, span.length);
    return true;
}

static void mal_node_crypto_hmac_final(MalNodeCryptoState *state, u8 result[32]) {
    u8 inner[32];
    mal_sha256_final(&state->digest.hmac.inner, inner);
    MalSha256 outer;
    mal_sha256_init(&outer);
    mal_sha256_update(&outer, state->digest.hmac.outer_pad, 64);
    mal_sha256_update(&outer, inner, sizeof(inner));
    mal_sha256_final(&outer, result);
    mal_secure_scrub((byte *) inner, sizeof(inner));
    mal_secure_scrub((byte *) &outer, sizeof(outer));
}

/* One-shot HMAC over a caller-owned state. `result` is filled before the
 * keyed state is cleared, so the caller always gets its tag. */
static void mal_node_crypto_hmac_bytes(
    const u8 *key, usize key_length, const u8 *first, usize first_length,
    const u8 *second, usize second_length, u8 result[32]) {
    MalNodeCryptoState state;
    mal_node_crypto_hmac_init_bytes(&state, key, key_length);
    if (first_length > 0) mal_node_crypto_state_update(&state, first, first_length);
    if (second_length > 0) mal_node_crypto_state_update(&state, second, second_length);
    mal_node_crypto_hmac_final(&state, result);
    mal_secure_scrub((byte *) &state, sizeof(state));
}

static MalValue mal_node_crypto_create_hmac(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee
) {
    (void) receiver;
    (void) new_target;
    if (argc < 1 || !mal_value_is_string(args[0])) {
        crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "crypto.createHmac: algorithm must be a string");
        return mal_value_new_undefined();
    }
    if (!mal_node_crypto_str_is(mal_value_to_string(args[0]), "sha256", 6)) {
        crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "crypto.createHmac: only sha256 is supported");
        return mal_value_new_undefined();
    }
    if (argc < 2) {
        crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "crypto.createHmac: key is required");
        return mal_value_new_undefined();
    }
    MalNodeCryptoState state = {0};
    if (!mal_node_crypto_hmac_init(vm, &state, args[1])) {
        return mal_value_new_undefined();
    }
    return mal_node_crypto_new_state(vm, callee, &state);
}

/* ---------------------------------------------------------------------------
 * Randomness.
 * --------------------------------------------------------------------------- */

/* Node's validateNumber: a primitive number, never coerced. */
static bool crypto_require_number(MalVm *vm, MalValue value, const char *name, f64 *out) {
    if (!mal_ops_is_number(value)) {
        crypto_throw_arg_type(vm, name, "of type number", value);
        return false;
    }
    *out = mal_ops_number_as_f64(value);
    return true;
}

static bool crypto_require_safe_integer(
    MalVm *vm, MalValue value, const char *name, f64 *out) {
    if (!mal_ops_is_number(value)) {
        crypto_throw_arg_type(vm, name, "a safe integer", value);
        return false;
    }
    f64 number = mal_ops_number_as_f64(value);
    if (!isfinite(number) || trunc(number) != number
        || number > 9007199254740991.0 || number < -9007199254740991.0) {
        crypto_throw_arg_type(vm, name, "a safe integer", value);
        return false;
    }
    *out = number;
    return true;
}

#define CRYPTO_ENTROPY_UNAVAILABLE "Host entropy unavailable"

/* size must be a primitive number in [0, 2^31-1]; a fractional size truncates
 * (`randomBytes(1.5)` is a one-byte Buffer), it does not throw. */
static bool crypto_random_size(MalVm *vm, MalValue value, usize *out) {
    f64 size;
    if (!crypto_require_number(vm, value, "size", &size)) return false;
    if (!(size >= 0) || size > 2147483647.0) {
        crypto_throw_out_of_range(vm, "size", ">= 0 && <= 2147483647", value);
        return false;
    }
    *out = (usize) trunc(size);
    return true;
}

/* Rejection sampling over whole bytes: draw the smallest byte count that covers
 * `range`, discard the values above the largest exact multiple, retry. Never a
 * bare modulo, which would bias the low end of the range — for a range of 200,
 * 256 % 200 = 56, so modulo would hand out 0..55 twice as often as 56..199. */
/* Reports a platform failure rather than throwing, so the callback form can
 * deliver it through the callback instead of out of the call. */
static bool crypto_random_below(u64 range, u64 *out) {
    usize bytes = 1;
    u64 span = 256;
    while (span < range) {
        bytes++;
        span <<= 8;
    }
    u64 limit = span - (span % range);
    for (;;) {
        u8 draw[8] = {0};
        if (mal_host_entropy(draw, bytes) != 0) return false;
        u64 value = 0;
        for (usize i = 0; i < bytes; i++) value = (value << 8) | draw[i];
        if (value < limit) {
            *out = value % range;
            return true;
        }
    }
}

/*
 * randomInt([min, ]max[, callback]).
 *
 * Node's shape detection is `minNotSpecified = typeof max === 'undefined' ||
 * typeof max === 'function'`, which shifts the arguments down and makes the
 * second one the callback. It then validates the callback *before* the numeric
 * bounds, so `randomInt(5, 4, 5)` is a callback TypeError, not a bounds
 * RangeError. Everything below runs before a single byte of entropy is drawn.
 */
typedef struct {
    MalValue min;
    MalValue max;
    MalValue callback;
} CryptoRandomIntArguments;

static CryptoRandomIntArguments crypto_random_int_shape(
    const MalValue *args, i32 argc) {
    MalValue first = argc >= 1 ? args[0] : mal_value_new_undefined();
    MalValue second = argc >= 2 ? args[1] : mal_value_new_undefined();
    MalValue third = argc >= 3 ? args[2] : mal_value_new_undefined();
    if (mal_value_is_undefined(second) || mal_value_is_callable(second)) {
        // `min` omitted: the second argument is the callback and the third is
        // ignored outright, exactly as Node ignores it.
        return (CryptoRandomIntArguments) {
            .min = mal_ops_number_value(0), .max = first, .callback = second};
    }
    return (CryptoRandomIntArguments) {.min = first, .max = second, .callback = third};
}

static bool crypto_random_int_bounds(
    MalVm *vm, const CryptoRandomIntArguments *shape, f64 *min_out, f64 *max_out) {
    f64 min;
    f64 max;
    if (!crypto_require_safe_integer(vm, shape->min, "min", &min)
        || !crypto_require_safe_integer(vm, shape->max, "max", &max)) {
        return false;
    }
    if (max <= min) {
        char range[96];
        char minimum[48];
        crypto_number_text(vm, mal_ops_number_value(min), minimum, sizeof(minimum));
        snprintf(range, sizeof(range),
            "greater than the value of \"min\" (%s)", minimum);
        crypto_throw_out_of_range(vm, "max", range, mal_ops_number_value(max));
        return false;
    }
    if (max - min > 281474976710655.0) {
        crypto_throw_out_of_range(vm, "max - min", "<= 281474976710655",
            mal_ops_number_value(max - min));
        return false;
    }
    *min_out = min;
    *max_out = max;
    return true;
}

/* ---------------------------------------------------------------------------
 * Asynchronous completion.
 *
 * One state list, one GC root source, and one macrotask drain serve all three
 * asynchronous entry points. The callback is unreachable from JavaScript
 * between the call returning and the drain, so without crypto_scan_roots a
 * collection in that window would free it.
 * --------------------------------------------------------------------------- */

typedef enum {
    CRYPTO_ASYNC_ARGON2,
    CRYPTO_ASYNC_RANDOM_BYTES,
    CRYPTO_ASYNC_RANDOM_INT,
    /* An operation that failed before it could be handed to a worker, carrying
     * only the reason. Shares the immediate payload and drain path below. */
    CRYPTO_ASYNC_FAILURE,
} CryptoAsyncKind;

/* Payload for the entry points that need no worker: the value is produced on
 * the main thread and posted so the callback still lands as a macrotask.
 * `failed` carries a platform entropy failure, or a transient job-start
 * failure, to the callback instead of throwing it out of a call that already
 * promised to call back. */
typedef struct {
    byte *bytes;
    usize length;
    f64 number;
    bool failed;
    /* Fixed literal only — never a parameter value, a key, or a derived tag.
     * Null falls back to the entropy message the randomness paths use. */
    const char *error;
} CryptoImmediateResult;

typedef struct MalNodeCryptoAsync {
    MalVm *vm;
    CryptoAsyncKind kind;
    MalHostHandle operation;
    MalValue callback;
    MalAsyncContext *async_context;
#if MAL_REALMS
    MalRealm *realm;
#endif
    struct MalNodeCryptoAsync *next;
} MalNodeCryptoAsync;

static MalNodeCryptoAsync *crypto_async_states;
static bool crypto_roots_installed;

/* Runs on the drain path and as the task's destructor (a payload dropped at
 * shutdown). Bytes still owned here never reached JavaScript, so they are
 * scrubbed; once ownership has transferred to a Buffer the pointer is already
 * null and the user's bytes are left alone. */
static void crypto_immediate_destroy(void *data) {
    CryptoImmediateResult *result = data;
    if (result == nullptr) return;
    crypto_scrub_free(result->bytes, result->length);
    free(result);
}

static void crypto_scan_roots(MalVm *vm, void *data) {
    (void) data;
    for (MalNodeCryptoAsync *state = crypto_async_states; state != nullptr;
        state = state->next) {
        if (state->vm != vm) continue;
        mal_gc_mark_value(state->callback);
        mal_gc_mark_value(
            mal_async_internal_value((MalHeapHeader *) state->async_context));
    }
}

static MalNodeCryptoAsync *crypto_async_new(MalVm *vm, CryptoAsyncKind kind, MalValue callback) {
    MalNodeCryptoAsync *state = calloc(1, sizeof(MalNodeCryptoAsync));
    if (state == nullptr) return nullptr;
    state->vm = vm;
    state->kind = kind;
    state->callback = callback;
    state->async_context = mal_async_context_capture(vm);
#if MAL_REALMS
    state->realm = vm->current_realm;
#endif
    return state;
}

static void crypto_async_link(MalNodeCryptoAsync *state, MalHostHandle operation) {
    state->operation = operation;
    state->next = crypto_async_states;
    crypto_async_states = state;
}

/*
 * Post an already-computed value so the callback runs as a macrotask, after the
 * microtask checkpoint — the ordering Node produces for randomBytes/randomInt.
 *
 * Returns true when a terminal task now exists for `state`, i.e. the callback
 * is guaranteed to fire exactly once (with the value, or with an error if the
 * completion had to be cancelled). It returns false only when nothing was
 * started at all, and only then does the caller still own `state` and `result`.
 *
 * The state is linked before the terminal is published, so no terminal can ever
 * reach the queue without an owner — an unowned task would sit at the head of
 * the cooperative, head-only drain and stall every later crypto callback.
 */
static bool crypto_complete_immediately(
    MalVm *vm, MalNodeCryptoAsync *state, CryptoImmediateResult *result) {
    MalHost *host = mal_host(vm);
    MalHostHandle operation = 0;
    if (host == nullptr || !mal_host_operation_start(&host->tasks, &operation)) {
        return false;
    }
    if (!mal_host_operation_activate(&host->tasks, operation)) {
        (void) mal_host_operation_abort_start(&host->tasks, operation);
        return false;
    }
    crypto_async_link(state, operation);
    if (!mal_host_operation_complete(&host->tasks, operation, MAL_HOST_TERMINAL_OK,
            result, crypto_immediate_destroy)) {
        // Ownership did not transfer, so the payload is ours to destroy; the
        // cancellation's terminal reaches the linked state as a callback error.
        crypto_immediate_destroy(result);
        (void) mal_host_operation_cancel(&host->tasks, operation);
    }
    return true;
}

/*
 * Retarget an already-allocated async state at a terminal failure, so a call
 * that has accepted a callback reports through it exactly once instead of
 * throwing out of a call that already promised to call back.
 *
 * Returns false when nothing could be queued at all (allocation or host task
 * failure), and only then does the caller still own `state` and must fall back
 * to a synchronous throw. `reason` must be a fixed literal.
 */
static bool crypto_fail_through_callback(
    MalVm *vm, MalNodeCryptoAsync *state, const char *reason) {
    CryptoImmediateResult *result = calloc(1, sizeof(CryptoImmediateResult));
    if (result == nullptr) return false;
    result->failed = true;
    result->error = reason;
    state->kind = CRYPTO_ASYNC_FAILURE;
    if (!crypto_complete_immediately(vm, state, result)) {
        crypto_immediate_destroy(result);
        return false;
    }
    return true;
}

/* Every callback form lands as a host macrotask, so an embedding without a host
 * context (the bare test262 entry, for instance) has nowhere to deliver it. */
static bool crypto_require_host(MalVm *vm) {
    if (mal_host(vm) != nullptr) return true;
    crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        "Asynchronous crypto requires a host event loop");
    return false;
}

static const char *crypto_argon2_status_message(i32 status) {
    // Fixed literals only: a status must never carry a parameter value, a key,
    // or a derived tag into a JavaScript error message.
    if (status == MAL_ARGON2_STATUS_POLICY) {
        return "Argon2 parameters exceed the host resource policy";
    }
    return status == MAL_ARGON2_STATUS_MEMORY
        ? "Argon2 memory allocation failed"
        : "Argon2 derivation failed";
}

/* Build the (error, value) callback arguments for one completed operation.
 * `args[0]` is `null` for randomBytes/argon2 and `undefined` for randomInt —
 * an asymmetry Node really has. */
static bool crypto_async_arguments(
    MalVm *vm, MalNodeCryptoAsync *state, const MalHostTask *task, void *data,
    MalValue *args) {
    args[0] = state->kind == CRYPTO_ASYNC_RANDOM_INT
        ? mal_value_new_undefined()
        : mal_value_new_null();
    args[1] = mal_value_new_undefined();
    if (task->kind != MAL_HOST_TASK_TERMINAL || task->result == MAL_HOST_TERMINAL_CANCELLED) {
        crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Crypto operation cancelled");
        return false;
    }
    if (state->kind == CRYPTO_ASYNC_ARGON2) {
        MalArgon2Result *result = data;
        i32 status = mal_argon2_result_status(result);
        if (task->result != MAL_HOST_TERMINAL_OK || status != MAL_ARGON2_STATUS_OK) {
            crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                crypto_argon2_status_message(status));
            return false;
        }
        usize length = 0;
        const byte *tag = mal_argon2_result_tag(result, &length);
        byte *owned = length == 0 ? nullptr : malloc(length);
        if (length > 0 && owned == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        if (length > 0) memcpy(owned, tag, length);
        args[1] = mal_node_buffer_from_owned_secret_bytes(vm, owned, length);
        return vm->completion.kind != MAL_COMPLETION_THROW;
    }
    CryptoImmediateResult *result = data;
    if (result == nullptr || result->failed) {
        const char *message = "Crypto operation failed";
        if (result != nullptr) {
            message = result->error != nullptr ? result->error : CRYPTO_ENTROPY_UNAVAILABLE;
        }
        crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, message);
        return false;
    }
    if (state->kind == CRYPTO_ASYNC_RANDOM_INT) {
        args[1] = mal_ops_number_value(result->number);
        return true;
    }
    // from_owned_bytes consumes the allocation on both paths, so clear the
    // payload's pointer before the destructor can double-free it.
    byte *bytes = result->bytes;
    usize length = result->length;
    result->bytes = nullptr;
    result->length = 0;
    args[1] = mal_node_buffer_from_owned_secret_bytes(vm, bytes, length);
    return vm->completion.kind != MAL_COMPLETION_THROW;
}

bool mal_node_crypto_drain(MalVm *vm) {
    MalHost *host = mal_host(vm);
    if (host == nullptr || mal_host_tasks_pending(&host->tasks) == 0) return false;
    MalHostTask peek;
    if (!mal_host_peek_task(&host->tasks, &peek)) return false;
    // Head-only, cooperative: another module's task must be left for its own
    // drain rather than consumed or skipped here.
    MalNodeCryptoAsync **link = &crypto_async_states;
    while (*link != nullptr
        && ((*link)->vm != vm || (*link)->operation != peek.operation)) {
        link = &(*link)->next;
    }
    MalNodeCryptoAsync *state = *link;
    if (state == nullptr) return false;
    MalHostTask task;
    if (!mal_host_next_task(&host->tasks, &task)) return false;
    void *data = mal_host_task_take_data(&host->tasks, &task);

#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_realm_switch(vm, state->realm);
#endif
    // The result is built while `state` is still linked, so a collection during
    // the Buffer allocation still reaches the callback through crypto_scan_roots.
    MalValue args[2];
    CryptoAsyncKind kind = state->kind;
    bool ready = crypto_async_arguments(vm, state, &task, data, args);
    if (!ready) {
        // A failed completion is delivered as the callback's first argument, not
        // rethrown: the callback must run exactly once either way.
        args[0] = vm->completion.value;
        args[1] = mal_value_new_undefined();
        vm->completion.kind = MAL_COMPLETION_NORMAL;
    }
    // take_data moved ownership out of the task, so the payload is released here.
    if (kind == CRYPTO_ASYNC_ARGON2) {
        mal_argon2_result_release(data);
    } else {
        crypto_immediate_destroy(data);
    }
    MalValue callback = state->callback;
    MalAsyncContext *async_context = state->async_context;
    *link = state->next;
    free(state);

    MalValue roots[] = {callback, args[0], args[1],
        mal_async_internal_value((MalHeapHeader *) async_context)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalAsyncContextScope scope;
    mal_async_context_scope_enter(vm, &scope, async_context);
    mal_vm_call_value(vm, roots[0], mal_value_new_undefined(), &roots[1], 2);
    mal_async_context_scope_exit(vm, &scope);
    mal_gc_unroot(&root);
#if MAL_REALMS
    mal_realm_switch(vm, saved_realm);
#endif

    mal_host_task_release(&host->tasks, &task);
    return true;
}

void mal_node_crypto_free(MalVm *vm) {
    MalNodeCryptoAsync **link = &crypto_async_states;
    while (*link != nullptr) {
        MalNodeCryptoAsync *state = *link;
        if (state->vm != vm) {
            link = &state->next;
            continue;
        }
        *link = state->next;
        free(state);
    }
}

/* ---------------------------------------------------------------------------
 * randomBytes / randomInt / randomUUID.
 * --------------------------------------------------------------------------- */

/* An absent or undefined callback selects the synchronous form; anything else
 * must be callable. */
static bool crypto_check_callback(MalVm *vm, MalValue callback) {
    if (mal_value_is_undefined(callback) || mal_value_is_callable(callback)) return true;
    crypto_throw_arg_type(vm, "callback", "of type function", callback);
    return false;
}

static MalValue mal_node_crypto_random_bytes(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    usize length;
    // Node validates `size` before `callback` here (the reverse of randomInt).
    if (!crypto_random_size(vm, argc >= 1 ? args[0] : mal_value_new_undefined(), &length)) {
        return mal_value_new_undefined();
    }
    MalValue callback = argc >= 2 ? args[1] : mal_value_new_undefined();
    // Argument errors throw synchronously even in the callback form.
    if (!crypto_check_callback(vm, callback)) return mal_value_new_undefined();
    bool async = !mal_value_is_undefined(callback);
    if (async && !crypto_require_host(vm)) return mal_value_new_undefined();

    byte *bytes = length == 0 ? nullptr : malloc(length);
    if (length > 0 && bytes == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    // The draw itself is synchronous even in the callback form; see the
    // "asynchrony" note in node_crypto.h. A platform failure must still reach
    // the callback exactly once rather than escape as a synchronous throw.
    bool drawn = mal_host_entropy(bytes, length) == 0;
    if (!async) {
        if (!drawn) {
            crypto_scrub_free(bytes, length);
            crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, CRYPTO_ENTROPY_UNAVAILABLE);
            return mal_value_new_undefined();
        }
        return mal_node_buffer_from_owned_secret_bytes(vm, bytes, length);
    }

    CryptoImmediateResult *result = calloc(1, sizeof(CryptoImmediateResult));
    MalNodeCryptoAsync *state = crypto_async_new(vm, CRYPTO_ASYNC_RANDOM_BYTES, callback);
    if (result == nullptr || state == nullptr) {
        free(result);
        free(state);
        crypto_scrub_free(bytes, length);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    result->failed = !drawn;
    if (drawn) {
        result->bytes = bytes;
        result->length = length;
    } else {
        crypto_scrub_free(bytes, length);
    }
    if (!crypto_complete_immediately(vm, state, result)) {
        crypto_immediate_destroy(result);
        free(state);
        crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Crypto operation failed");
    }
    return mal_value_new_undefined();
}

static MalValue mal_node_crypto_random_int(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    CryptoRandomIntArguments shape = crypto_random_int_shape(args, argc);
    // Callback first, then the bounds: Node's order, and it means an invalid
    // call is refused before any entropy is drawn.
    if (!crypto_check_callback(vm, shape.callback)) return mal_value_new_undefined();
    f64 min = 0;
    f64 max = 0;
    if (!crypto_random_int_bounds(vm, &shape, &min, &max)) {
        return mal_value_new_undefined();
    }
    bool async = !mal_value_is_undefined(shape.callback);
    if (async && !crypto_require_host(vm)) return mal_value_new_undefined();
    u64 drawn = 0;
    bool ok = crypto_random_below((u64) (max - min), &drawn);
    f64 value = min + (f64) drawn;
    if (!async) {
        if (!ok) {
            crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, CRYPTO_ENTROPY_UNAVAILABLE);
            return mal_value_new_undefined();
        }
        return mal_ops_number_value(value);
    }
    CryptoImmediateResult *result = calloc(1, sizeof(CryptoImmediateResult));
    MalNodeCryptoAsync *state = crypto_async_new(
        vm, CRYPTO_ASYNC_RANDOM_INT, shape.callback);
    if (result == nullptr || state == nullptr) {
        free(result);
        free(state);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    result->failed = !ok;
    result->number = value;
    if (!crypto_complete_immediately(vm, state, result)) {
        crypto_immediate_destroy(result);
        free(state);
        crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Crypto operation failed");
    }
    return mal_value_new_undefined();
}

/* RFC 4122 version 4 UUID using the engine-neutral host entropy boundary. */
static MalValue mal_node_crypto_random_uuid(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;

    bool fresh = false;
    MalValue options = argc >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_undefined(options)) {
        if (!mal_value_is_object(options)) {
            crypto_throw_arg_type(vm, "options", "of type object", options);
            return mal_value_new_undefined();
        }
        MalValue disable;
        MalKey key = mal_key_from_value(mal_value_from_string(
            mal_intrinsic_ascii(vm, (const byte *) "disableEntropyCache")));
        if (!mal_vm_get_property(vm, options, key, &disable)) {
            return mal_value_new_undefined();
        }
        if (!mal_value_is_undefined(disable)) {
            if (!mal_value_is_boolean(disable)) {
                crypto_throw_property_type(vm, "options.disableEntropyCache",
                    "of type boolean", disable);
                return mal_value_new_undefined();
            }
            fresh = mal_value_is_truthy(disable);
        }
    }

    u8 bytes[16];
    if (mal_host_entropy_uuid(bytes, fresh) != 0) {
        crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, CRYPTO_ENTROPY_UNAVAILABLE);
        return mal_value_new_undefined();
    }

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

/* ---------------------------------------------------------------------------
 * pbkdf2Sync, timingSafeEqual, hash.
 * --------------------------------------------------------------------------- */

static bool mal_node_crypto_integer(
    MalVm *vm, MalValue value, f64 minimum, f64 maximum, const char *message,
    usize *result) {
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) return false;
    if (!isfinite(number) || trunc(number) != number
        || number < minimum || number > maximum) {
        crypto_throw(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, message);
        return false;
    }
    *result = (usize) number;
    return true;
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
        crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
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
        crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "crypto.pbkdf2Sync: only sha256 is supported");
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
        crypto_scrub_free(owned_password, password.length);
        return mal_value_new_undefined();
    }
    byte *output = key_length == 0 ? nullptr : malloc(key_length);
    if (key_length > 0 && output == nullptr) {
        crypto_scrub_free(owned_password, password.length);
        crypto_scrub_free(owned_salt, salt.length);
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
        mal_node_crypto_hmac_bytes((const u8 *) password.data, password.length,
            (const u8 *) salt.data, salt.length, index, sizeof(index), value);
        memcpy(accumulated, value, sizeof(accumulated));
        for (usize round = 1; round < iterations; round++) {
            mal_node_crypto_hmac_bytes((const u8 *) password.data, password.length,
                value, sizeof(value), nullptr, 0, value);
            for (usize i = 0; i < sizeof(accumulated); i++) accumulated[i] ^= value[i];
        }
        usize offset = (block - 1) * 32;
        usize selected = key_length - offset;
        if (selected > sizeof(accumulated)) selected = sizeof(accumulated);
        // The derived block reaches `output` first; only then are the working
        // registers cleared. `value` is U_c and `accumulated` the folded block,
        // and both are key material for the block just written.
        memcpy(output + offset, accumulated, selected);
        mal_secure_scrub((byte *) value, sizeof(value));
        mal_secure_scrub((byte *) accumulated, sizeof(accumulated));
    }
    // The password is materialized by us when it arrives as a string; a borrowed
    // ArrayBufferView is the caller's and is left alone (`owned_*` is null).
    crypto_scrub_free(owned_password, password.length);
    crypto_scrub_free(owned_salt, salt.length);
    return mal_node_buffer_from_owned_secret_bytes(vm, output, key_length);
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
    if (!crypto_byte_source_span(
            vm, argc >= 1 ? args[0] : mal_value_new_undefined(), "buf1", &left)) {
        return mal_value_new_undefined();
    }
    if (!crypto_byte_source_span(
            vm, argc >= 2 ? args[1] : mal_value_new_undefined(), "buf2", &right)) {
        return mal_value_new_undefined();
    }
    if (left.length != right.length) {
        crypto_throw(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Input buffers must have the same byte length");
        return mal_value_new_undefined();
    }
    const volatile u8 *left_bytes = (const volatile u8 *) left.data;
    const volatile u8 *right_bytes = (const volatile u8 *) right.data;
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
        crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "crypto.hash: algorithm must be a string");
        return mal_value_new_undefined();
    }
    MalString *algorithm_str = mal_value_to_string(algorithm);
    if (!mal_node_crypto_str_is(algorithm_str, "sha256", 6)) {
        crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "crypto.hash: only the \"sha256\" algorithm is supported");
        return mal_value_new_undefined();
    }

    // Validate the output encoding before extracting any raw byte pointer below.
    // A non-string, non-undefined third argument is Node's `options` slot.
    if (!mal_value_is_undefined(encoding) && !mal_value_is_string(encoding)) {
        crypto_throw_arg_type(vm, "options", "of type object", encoding);
        return mal_value_new_undefined();
    }

    bool data_is_byte_source = crypto_is_byte_source(data);
    if (!mal_value_is_string(data) && !data_is_byte_source) {
        crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "crypto.hash: data must be a string or byte source");
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
            mal_sha256_update(&ctx, (const u8 *) span.data, span.length);
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
        crypto_scrub_free(bytes, byte_len);
    }

    u8 digest[32];
    mal_sha256_final(&ctx, digest);
    mal_secure_scrub((byte *) &ctx, sizeof(ctx));

    if (mal_value_is_undefined(encoding)) {
        char hex[64];
        mal_hex_encode_lower((const byte *) digest, countof(digest), hex);
        return mal_value_from_string(
            mal_string_new_ascii(&vm->heap, (const byte *) hex, 64));
    }
    if (mal_string_equals_ascii_ci(mal_value_to_string(encoding), "buffer")) {
        return mal_node_buffer_encode_secret_bytes(
            vm, (const byte *) digest, countof(digest), mal_value_new_undefined(), false);
    }
    // Unlike digest(), crypto.hash() rejects an unrecognized encoding.
    if (!mal_node_buffer_encoding_is_known(encoding)) {
        char received[128];
        crypto_copy_string(mal_value_to_string(encoding), received, sizeof(received));
        char message[CRYPTO_MESSAGE_CAPACITY];
        snprintf(message, sizeof(message),
            "The argument 'outputEncoding' is invalid. Received '%s'", received);
        crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
        return mal_value_new_undefined();
    }
    return mal_node_buffer_encode_bytes(
        vm, (const byte *) digest, countof(digest), encoding, true);
}

/* ---------------------------------------------------------------------------
 * Argon2.
 * --------------------------------------------------------------------------- */

typedef struct {
    u32 variant;
    u32 parallelism;
    u32 passes;
    u32 memory_kib;
    u32 tag_length;
    MalBufferSourceSpan message;
    MalBufferSourceSpan nonce;
    MalBufferSourceSpan secret;
    MalBufferSourceSpan associated_data;
    byte *owned_message;
    byte *owned_nonce;
    byte *owned_secret;
    byte *owned_associated_data;
} CryptoArgon2Args;

/* The owned buffers are this layer's own UTF-8 materializations of a passcode,
 * pepper, or nonce, so they are scrubbed rather than merely freed. A span whose
 * `owned` pointer is null borrows the caller's byte source and is left alone —
 * those bytes are still the user's. */
static void crypto_argon2_args_free(CryptoArgon2Args *parsed) {
    if (parsed->owned_message != nullptr) {
        crypto_scrub_free(parsed->owned_message, parsed->message.length);
    }
    if (parsed->owned_nonce != nullptr) {
        crypto_scrub_free(parsed->owned_nonce, parsed->nonce.length);
    }
    if (parsed->owned_secret != nullptr) {
        crypto_scrub_free(parsed->owned_secret, parsed->secret.length);
    }
    if (parsed->owned_associated_data != nullptr) {
        crypto_scrub_free(
            parsed->owned_associated_data, parsed->associated_data.length);
    }
    memset(parsed, 0, sizeof(*parsed));
}

static bool crypto_argon2_variant(MalVm *vm, MalValue algorithm, u32 *out) {
    if (!mal_value_is_string(algorithm)) {
        crypto_throw_arg_type(vm, "algorithm", "of type string", algorithm);
        return false;
    }
    MalString *name = mal_value_to_string(algorithm);
    if (mal_node_crypto_str_is(name, "argon2d", 7)) {
        *out = MAL_ARGON2_VARIANT_D;
        return true;
    }
    if (mal_node_crypto_str_is(name, "argon2i", 7)) {
        *out = MAL_ARGON2_VARIANT_I;
        return true;
    }
    if (mal_node_crypto_str_is(name, "argon2id", 8)) {
        *out = MAL_ARGON2_VARIANT_ID;
        return true;
    }
    char received[64];
    crypto_copy_string(name, received, sizeof(received));
    char message[CRYPTO_MESSAGE_CAPACITY];
    snprintf(message, sizeof(message),
        "The argument 'algorithm' must be one of: 'argon2d', 'argon2i', "
        "'argon2id'. Received '%s'", received);
    crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
    return false;
}

/* Materialize one byte input. Strings are measured and hashed as UTF-8; every
 * byte-source form (ArrayBuffer, Buffer, TypedArray, DataView) is accepted. */
static bool crypto_argon2_bytes(
    MalVm *vm, MalValue value, const char *name, MalBufferSourceSpan *span, byte **owned) {
    if (mal_value_is_string(value)) {
        usize length = 0;
        *owned = mal_string_to_utf8(mal_value_to_string(value), &length);
        if (*owned == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        *span = (MalBufferSourceSpan) {.data = *owned, .length = length};
        return true;
    }
    if (!crypto_is_byte_source(value)
        || mal_buffer_source_span(value, span) != MAL_BUFFER_SOURCE_SPAN_OK) {
        crypto_throw_property_type(vm, name, CRYPTO_BYTE_SOURCE_TEXT, value);
        return false;
    }
    return true;
}

/* The numeric ladder Node applies to each Argon2 parameter: primitive number,
 * then integer, then range — each with its own message shape. */
static bool crypto_argon2_number(
    MalVm *vm, MalValue value, const char *name, f64 minimum, f64 maximum, u32 *out) {
    if (!mal_ops_is_number(value)) {
        crypto_throw_property_type(vm, name, "of type number", value);
        return false;
    }
    f64 number = mal_ops_number_as_f64(value);
    if (!isfinite(number) || trunc(number) != number) {
        crypto_throw_out_of_range(vm, name, "an integer", value);
        return false;
    }
    if (number < minimum || number > maximum) {
        char range[96];
        snprintf(range, sizeof(range), ">= %.0f && <= %.0f", minimum, maximum);
        crypto_throw_out_of_range(vm, name, range, value);
        return false;
    }
    *out = (u32) number;
    return true;
}

/* Reads every property once, in Node's measured order, before validating any of
 * them, so a getter cannot observe a different sequence. */
static bool crypto_argon2_parse(
    MalVm *vm, MalValue algorithm, MalValue parameters, CryptoArgon2Args *parsed) {
    memset(parsed, 0, sizeof(*parsed));
    if (!crypto_argon2_variant(vm, algorithm, &parsed->variant)) return false;
    if (!mal_value_is_object(parameters)) {
        crypto_throw_arg_type(vm, "parameters", "of type object", parameters);
        return false;
    }

    static const char *names[] = {
        "parallelism", "tagLength", "memory", "passes",
        "message", "nonce", "secret", "associatedData",
    };
    MalValue values[countof(names)];
    for (usize i = 0; i < countof(names); i++) values[i] = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, values, countof(values));
    for (usize i = 0; i < countof(names); i++) {
        MalKey key = mal_key_from_value(
            mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) names[i])));
        if (!mal_vm_get_property(vm, parameters, key, &values[i])) {
            mal_gc_unroot(&root);
            return false;
        }
    }

    bool ok = false;
    do {
        if (!mal_value_is_string(values[4]) && !crypto_is_byte_source(values[4])) {
            crypto_throw_property_type(
                vm, "parameters.message", CRYPTO_BYTE_SOURCE_TEXT, values[4]);
            break;
        }
        if (!mal_value_is_string(values[5]) && !crypto_is_byte_source(values[5])) {
            crypto_throw_property_type(
                vm, "parameters.nonce", CRYPTO_BYTE_SOURCE_TEXT, values[5]);
            break;
        }
        if (!crypto_argon2_bytes(
                vm, values[5], "parameters.nonce", &parsed->nonce, &parsed->owned_nonce)) {
            break;
        }
        if (parsed->nonce.length < 8 || parsed->nonce.length > 4294967295u) {
            crypto_throw_out_of_range(vm, "parameters.nonce.byteLength",
                ">= 8 && <= 4294967295", mal_ops_number_value((f64) parsed->nonce.length));
            break;
        }
        if (!crypto_argon2_number(vm, values[0], "parameters.parallelism",
                1, 16777215, &parsed->parallelism)
            || !crypto_argon2_number(vm, values[1], "parameters.tagLength",
                4, 4294967295.0, &parsed->tag_length)) {
            break;
        }
        // The lower memory bound is max(8, 8 * parallelism), and Node embeds the
        // computed value in the message.
        f64 memory_floor = parsed->parallelism > 1 ? 8.0 * parsed->parallelism : 8.0;
        if (!crypto_argon2_number(vm, values[2], "parameters.memory",
                memory_floor, 4294967295.0, &parsed->memory_kib)
            || !crypto_argon2_number(vm, values[3], "parameters.passes",
                1, 4294967295.0, &parsed->passes)) {
            break;
        }
        // Node 24.14.1 raises ERR_INTERNAL_ASSERTION here for a wrongly typed
        // optional input; a proper TypeError is a deliberate divergence.
        if (!mal_value_is_undefined(values[6])
            && !crypto_argon2_bytes(vm, values[6], "parameters.secret",
                &parsed->secret, &parsed->owned_secret)) {
            break;
        }
        if (!mal_value_is_undefined(values[7])
            && !crypto_argon2_bytes(vm, values[7], "parameters.associatedData",
                &parsed->associated_data, &parsed->owned_associated_data)) {
            break;
        }
        if (!crypto_argon2_bytes(vm, values[4], "parameters.message",
                &parsed->message, &parsed->owned_message)) {
            break;
        }
        ok = true;
    } while (false);
    mal_gc_unroot(&root);
    if (!ok) crypto_argon2_args_free(parsed);
    return ok;
}

static MalArgon2Params crypto_argon2_params(const CryptoArgon2Args *parsed) {
    return (MalArgon2Params) {
        .variant = parsed->variant,
        .parallelism = parsed->parallelism,
        .passes = parsed->passes,
        .memory_kib = parsed->memory_kib,
        .tag_length = parsed->tag_length,
        .message = parsed->message.data,
        .message_len = parsed->message.length,
        .nonce = parsed->nonce.data,
        .nonce_len = parsed->nonce.length,
        .secret = parsed->secret.data,
        .secret_len = parsed->secret.length,
        .associated_data = parsed->associated_data.data,
        .associated_data_len = parsed->associated_data.length,
    };
}

static MalValue mal_node_crypto_argon2_sync(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    CryptoArgon2Args parsed;
    if (!crypto_argon2_parse(vm, argc >= 1 ? args[0] : mal_value_new_undefined(),
            argc >= 2 ? args[1] : mal_value_new_undefined(), &parsed)) {
        return mal_value_new_undefined();
    }
    MalArgon2Params params = crypto_argon2_params(&parsed);
    MalHost *host = mal_host(vm);
    MalArgon2 *argon2 = host == nullptr ? nullptr : &host->argon2;
    // The host resource policy is checked before the tag buffer exists, so a
    // `tagLength` Node accepts but this host refuses costs no allocation.
    i32 status = mal_argon2_check_policy(argon2, &params);
    if (status != MAL_ARGON2_STATUS_OK) {
        crypto_argon2_args_free(&parsed);
        crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            crypto_argon2_status_message(status));
        return mal_value_new_undefined();
    }
    byte *tag = malloc(parsed.tag_length);
    if (tag == nullptr) {
        crypto_argon2_args_free(&parsed);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    status = mal_argon2_derive_sync(argon2, &params, tag, parsed.tag_length);
    usize tag_length = parsed.tag_length;
    crypto_argon2_args_free(&parsed);
    if (status != MAL_ARGON2_STATUS_OK) {
        // A failed derivation can still have written partial key-derived state.
        crypto_scrub_free(tag, tag_length);
        crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            crypto_argon2_status_message(status));
        return mal_value_new_undefined();
    }
    return mal_node_buffer_from_owned_secret_bytes(vm, tag, tag_length);
}

static MalValue mal_node_crypto_argon2(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalValue algorithm = argc >= 1 ? args[0] : mal_value_new_undefined();
    MalValue parameters = argc >= 2 ? args[1] : mal_value_new_undefined();
    MalValue callback = argc >= 3 ? args[2] : mal_value_new_undefined();
    // algorithm, then parameters, then the callback — all synchronous throws,
    // never delivered to the callback.
    u32 variant;
    if (!crypto_argon2_variant(vm, algorithm, &variant)) return mal_value_new_undefined();
    if (!mal_value_is_object(parameters)) {
        crypto_throw_arg_type(vm, "parameters", "of type object", parameters);
        return mal_value_new_undefined();
    }
    if (!mal_value_is_callable(callback)) {
        crypto_throw_arg_type(vm, "callback", "of type function", callback);
        return mal_value_new_undefined();
    }
    if (!crypto_require_host(vm)) return mal_value_new_undefined();
    CryptoArgon2Args parsed;
    if (!crypto_argon2_parse(vm, algorithm, parameters, &parsed)) {
        return mal_value_new_undefined();
    }

    // Ownership order matters here. The state is allocated *before* the job is
    // started, because a state allocation that failed afterwards would leave a
    // queued operation whose terminal task has no entry in crypto_async_states
    // — and the drain is head-only, so that task would sit at the head forever
    // and stall every later crypto callback. crypto_async_new only callocs and
    // reads vm->async_context / vm->current_realm, so it cannot allocate on the
    // JS heap and cannot invalidate the raw spans `parsed` still holds.
    MalNodeCryptoAsync *state = crypto_async_new(vm, CRYPTO_ASYNC_ARGON2, callback);
    if (state == nullptr) {
        crypto_argon2_args_free(&parsed);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    MalArgon2Params params = crypto_argon2_params(&parsed);
    MalArgon2StartResult started = mal_argon2_start(mal_host(vm), &params, &state->operation);
    crypto_argon2_args_free(&parsed);
    if (started != MAL_ARGON2_START_OK) {
        // No argon2 operation exists on any failure path, so nothing is linked
        // yet and the state is still this function's to place or drop.
        const char *reason = "Argon2 job could not be started";
        if (started == MAL_ARGON2_START_SATURATED) reason = "Argon2 queue is full";
        if (started == MAL_ARGON2_START_SHUTDOWN) reason = "Argon2 is shutting down";
        if (started == MAL_ARGON2_START_SYSTEM_ERROR) reason = "Argon2 worker unavailable";
        if (started == MAL_ARGON2_START_POLICY) {
            reason = crypto_argon2_status_message(MAL_ARGON2_STATUS_POLICY);
        }
        // A full queue and an unavailable worker are transient host conditions,
        // not bad arguments and not a refused policy: the caller has already
        // handed over a callback and cannot also be expected to wrap the call in
        // a try/catch, so they are reported through the callback. Argument and
        // policy errors above stay synchronous, as they were before the call
        // ever reached the pool. The synchronous throw remains the last resort
        // for when even a terminal task cannot be queued.
        if ((started == MAL_ARGON2_START_SATURATED
                || started == MAL_ARGON2_START_SYSTEM_ERROR)
            && crypto_fail_through_callback(vm, state, reason)) {
            return mal_value_new_undefined();
        }
        free(state);
        crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, reason);
        return mal_value_new_undefined();
    }
    crypto_async_link(state, state->operation);
    return mal_value_new_undefined();
}

/* ---------------------------------------------------------------------------
 * Installation.
 * --------------------------------------------------------------------------- */

static MalNativeFunctionObject *mal_node_crypto_function_with_slots(
    MalVm *vm, const char *name, i32 length, MalNativeFunctionCallback callback,
    const MalValue *slots, i32 slot_count
) {
    return mal_native_function_object_new_with_slots_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), length, callback, slots, slot_count);
}

typedef struct {
    const char *name;
    i32 length;
    MalNativeFunctionCallback callback;
} CryptoExport;

/* The flat exports (everything that needs no private-symbol slot). Lengths match
 * Node's, which the fixture pins. */
static const CryptoExport CRYPTO_EXPORTS[] = {
    {"argon2", 3, mal_node_crypto_argon2},
    {"argon2Sync", 2, mal_node_crypto_argon2_sync},
    {"hash", 3, mal_node_crypto_hash},
    {"pbkdf2Sync", 5, mal_node_crypto_pbkdf2_sync},
    {"randomBytes", 2, mal_node_crypto_random_bytes},
    {"randomInt", 3, mal_node_crypto_random_int},
    {"randomUUID", 1, mal_node_crypto_random_uuid},
    {"timingSafeEqual", 0, mal_node_crypto_timing_safe_equal},
};

void mal_host_install_node_crypto(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue cached = vm->intrinsics[MAL_INTRINSIC_NODE_CRYPTO_MODULE];
    if (!mal_value_is_undefined(cached)) {
        mal_node_module_publish(vm, slots, count, cached);
        return;
    }

    MalValue roots[7];
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

    roots[6] = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalObject *module = mal_value_to_object(roots[6]);
    mal_intrinsic_define_data(vm, module, (const byte *) "createHash", roots[4], method_flags);
    mal_intrinsic_define_data(vm, module, (const byte *) "createHmac", roots[5], method_flags);
    for (usize i = 0; i < countof(CRYPTO_EXPORTS); i++) {
        const CryptoExport *export_entry = &CRYPTO_EXPORTS[i];
        MalValue function = mal_value_from_native_function_object(
            mal_native_function_object_new_arity(&vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, (const byte *) export_entry->name),
                export_entry->length, export_entry->callback));
        MalRootSpan function_root;
        mal_gc_root(&function_root, &function, 1);
        mal_intrinsic_define_data(
            vm, module, (const byte *) export_entry->name, function, method_flags);
        mal_gc_unroot(&function_root);
    }

    if (!crypto_roots_installed) {
        mal_gc_register_root_source(crypto_scan_roots, nullptr);
        mal_host_register_macrotask_drain(mal_node_crypto_drain, false);
        // This program already links the entropy boundary, so Math.random's
        // generator can be seeded from it rather than from process divergence.
        // Math.random remains non-cryptographic; see builtin_math.h.
        mal_builtin_math_set_seed_source(mal_host_entropy);
        crypto_roots_installed = true;
    }
    vm->intrinsics[MAL_INTRINSIC_NODE_CRYPTO_MODULE] = roots[6];
    mal_node_module_publish(vm, slots, count, roots[6]);
    mal_gc_unroot(&root);
}

#endif // MAL_NODE
