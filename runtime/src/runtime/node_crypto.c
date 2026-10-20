// Portions derived from Node.js lib/internal/crypto/hash.js, lib/internal/crypto/cipher.js, lib/internal/crypto/keygen.js, lib/internal/streams/lazy_transform.js (MIT); see THIRD_PARTY_NOTICES.md.
#include "node_crypto.h"

#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "ascii.h"
#include "argon2.h"
#include "array_buffer_object.h"
#include "async_context.h"
#include "base64.h"
#include "blocking_work.h"
#include "promise_object.h"
#include "array_object.h"
#include "web_events_object.h"
#include <time.h>
#include "builtin_data_view.h"
#include "builtin_math.h"
#include "function_object.h"
#include "gc.h"
#include "entropy.h"
#include "heap_bigint.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "hex.h"
#include "host.h"
#include "intrinsics.h"
#include "node_buffer.h"
#include "node_module.h"
#include "node_stream.h"
#include "object.h"
#include "object_ops.h"
#include "secure_scrub.h"
#include "sha256.h"
#include "utf8.h"
#include "typed_array_object.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"
#include "mal_crypto_x509.h"
#include "date_object.h"
#include "web_host_timer.h"

#if MAL_NODE

#include "mal_argon2.h"
#include "mal_crypto_cipher.h"
#include "mal_crypto_pkey.h"

#define MAL_ROTL(x, n) (((x) << (n)) | ((x) >> (32 - (n))))

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
    mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_TYPE");
}

/* ERR_INVALID_ARG_TYPE for an option-bag property. */
static void crypto_throw_property_type(
    MalVm *vm, const char *name, const char *expected, MalValue actual) {
    char received[CRYPTO_MESSAGE_CAPACITY / 2];
    crypto_received(vm, actual, received, sizeof(received));
    char message[CRYPTO_MESSAGE_CAPACITY];
    snprintf(message, sizeof(message), "The \"%s\" property must be %s. Received %s",
        name, expected, received);
    mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_TYPE");
}

static void crypto_throw_out_of_range(
    MalVm *vm, const char *name, const char *range, MalValue actual) {
    char received[CRYPTO_MESSAGE_CAPACITY / 2];
    crypto_received_number(vm, actual, received, sizeof(received));
    char message[CRYPTO_MESSAGE_CAPACITY];
    snprintf(message, sizeof(message),
        "The value of \"%s\" is out of range. It must be %s. Received %s",
        name, range, received);
    mal_node_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, message, "ERR_OUT_OF_RANGE");
}

/* ---------------------------------------------------------------------------
 * Shared argument helpers.
 * --------------------------------------------------------------------------- */

static void crypto_scrub_free(byte *bytes, usize length) {
    mal_secure_scrub(bytes, length);
    free(bytes);
}

// SIMD cipher backends (AVX2 on x86_64) need more than malloc's 16-byte alignment, and the
// Rust side refuses misaligned state storage.
static byte *crypto_cipher_storage(usize size) {
    usize rounded = (size + 63) & ~(usize) 63;
    byte *storage = aligned_alloc(64, rounded);
    if (storage != nullptr) memset(storage, 0, rounded);
    return storage;
}

/* True when `str` is exactly the ASCII literal `ascii` of length `n`. Used for the
 * algorithm and output-encoding checks — both must match one fixed lowercase word,
 * so a code-unit-wise compare (no allocation, no ToLower) is enough. */
static bool mal_node_crypto_str_is(const MalString *str, const char *ascii, usize n) {
    return strlen(ascii) == n && mal_string_equals_ascii(str, ascii);
}

// Validate the complete view before applying its byte offset. In particular,
// detached stores have null data, so even adding a zero offset would be undefined.
// Shared input is snapshotted so the digest never reads bytes another agent is
// writing; *owned (null for unshared spans) is freed with crypto_scrub_free.
static bool crypto_private_span(MalVm *vm, MalBufferSourceSpan *span, byte **owned) {
    *owned = nullptr;
    if (!span->shared) return true;
    const byte *data = mal_buffer_source_span_private(span, owned);
    if (span->length > 0 && data == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    *span = (MalBufferSourceSpan) {.data = *owned, .length = span->length};
    return true;
}

static bool mal_node_crypto_byte_span(
    MalVm *vm, MalValue value, MalBufferSourceSpan *out, byte **owned) {
    *owned = nullptr;
    if (mal_buffer_source_span(value, out) == MAL_BUFFER_SOURCE_SPAN_OK) {
        return crypto_private_span(vm, out, owned);
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
    MalVm *vm, MalValue value, const char *name, MalBufferSourceSpan *out, byte **owned) {
    *owned = nullptr;
    if (!crypto_is_byte_source(value)) {
        char message[CRYPTO_MESSAGE_CAPACITY];
        snprintf(message, sizeof(message),
            "The \"%s\" argument must be an instance of ArrayBuffer, Buffer, "
            "TypedArray, or DataView.", name);
        crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
        return false;
    }
    return mal_node_crypto_byte_span(vm, value, out, owned);
}

#if defined(__APPLE__)
#include <CommonCrypto/CommonDigest.h>

typedef CC_SHA512_CTX MalSha512;

static void mal_sha512_init(MalSha512 *ctx, bool sha384) {
    if (sha384) CC_SHA384_Init(ctx);
    else CC_SHA512_Init(ctx);
}

static void mal_sha512_update(MalSha512 *ctx, const u8 *data, usize length) {
    // CommonCrypto's input length is 32 bits; Node byte sources are size_t-sized.
    while (length > 0) {
        CC_LONG chunk = length > UINT32_MAX ? UINT32_MAX : (CC_LONG) length;
        CC_SHA512_Update(ctx, data, chunk);
        data += chunk;
        length -= chunk;
    }
}

static void mal_sha512_final(MalSha512 *ctx, u8 *out, usize length) {
    if (length == CC_SHA384_DIGEST_LENGTH) CC_SHA384_Final(out, ctx);
    else CC_SHA512_Final(out, ctx);
}
#else
typedef struct {
    u64 state[8];
    u64 bit_low;
    u64 bit_high;
    u8 block[128];
    usize block_len;
} MalSha512;

static const u64 MAL_SHA512_K[80] = {
    UINT64_C(0x428a2f98d728ae22), UINT64_C(0x7137449123ef65cd), UINT64_C(0xb5c0fbcfec4d3b2f), UINT64_C(0xe9b5dba58189dbbc),
    UINT64_C(0x3956c25bf348b538), UINT64_C(0x59f111f1b605d019), UINT64_C(0x923f82a4af194f9b), UINT64_C(0xab1c5ed5da6d8118),
    UINT64_C(0xd807aa98a3030242), UINT64_C(0x12835b0145706fbe), UINT64_C(0x243185be4ee4b28c), UINT64_C(0x550c7dc3d5ffb4e2),
    UINT64_C(0x72be5d74f27b896f), UINT64_C(0x80deb1fe3b1696b1), UINT64_C(0x9bdc06a725c71235), UINT64_C(0xc19bf174cf692694),
    UINT64_C(0xe49b69c19ef14ad2), UINT64_C(0xefbe4786384f25e3), UINT64_C(0x0fc19dc68b8cd5b5), UINT64_C(0x240ca1cc77ac9c65),
    UINT64_C(0x2de92c6f592b0275), UINT64_C(0x4a7484aa6ea6e483), UINT64_C(0x5cb0a9dcbd41fbd4), UINT64_C(0x76f988da831153b5),
    UINT64_C(0x983e5152ee66dfab), UINT64_C(0xa831c66d2db43210), UINT64_C(0xb00327c898fb213f), UINT64_C(0xbf597fc7beef0ee4),
    UINT64_C(0xc6e00bf33da88fc2), UINT64_C(0xd5a79147930aa725), UINT64_C(0x06ca6351e003826f), UINT64_C(0x142929670a0e6e70),
    UINT64_C(0x27b70a8546d22ffc), UINT64_C(0x2e1b21385c26c926), UINT64_C(0x4d2c6dfc5ac42aed), UINT64_C(0x53380d139d95b3df),
    UINT64_C(0x650a73548baf63de), UINT64_C(0x766a0abb3c77b2a8), UINT64_C(0x81c2c92e47edaee6), UINT64_C(0x92722c851482353b),
    UINT64_C(0xa2bfe8a14cf10364), UINT64_C(0xa81a664bbc423001), UINT64_C(0xc24b8b70d0f89791), UINT64_C(0xc76c51a30654be30),
    UINT64_C(0xd192e819d6ef5218), UINT64_C(0xd69906245565a910), UINT64_C(0xf40e35855771202a), UINT64_C(0x106aa07032bbd1b8),
    UINT64_C(0x19a4c116b8d2d0c8), UINT64_C(0x1e376c085141ab53), UINT64_C(0x2748774cdf8eeb99), UINT64_C(0x34b0bcb5e19b48a8),
    UINT64_C(0x391c0cb3c5c95a63), UINT64_C(0x4ed8aa4ae3418acb), UINT64_C(0x5b9cca4f7763e373), UINT64_C(0x682e6ff3d6b2b8a3),
    UINT64_C(0x748f82ee5defb2fc), UINT64_C(0x78a5636f43172f60), UINT64_C(0x84c87814a1f0ab72), UINT64_C(0x8cc702081a6439ec),
    UINT64_C(0x90befffa23631e28), UINT64_C(0xa4506cebde82bde9), UINT64_C(0xbef9a3f7b2c67915), UINT64_C(0xc67178f2e372532b),
    UINT64_C(0xca273eceea26619c), UINT64_C(0xd186b8c721c0c207), UINT64_C(0xeada7dd6cde0eb1e), UINT64_C(0xf57d4f7fee6ed178),
    UINT64_C(0x06f067aa72176fba), UINT64_C(0x0a637dc5a2c898a6), UINT64_C(0x113f9804bef90dae), UINT64_C(0x1b710b35131c471b),
    UINT64_C(0x28db77f523047d84), UINT64_C(0x32caab7b40c72493), UINT64_C(0x3c9ebe0a15c9bebc), UINT64_C(0x431d67c49c100d4c),
    UINT64_C(0x4cc5d4becb3e42b6), UINT64_C(0x597f299cfc657e2a), UINT64_C(0x5fcb6fab3ad6faec), UINT64_C(0x6c44198c4a475817),
};

static u64 mal_sha512_rotr(u64 value, unsigned count) {
    return (value >> count) | (value << (64 - count));
}

static void mal_sha512_init(MalSha512 *ctx, bool sha384) {
    static const u64 initial[2][8] = {
        {UINT64_C(0x6a09e667f3bcc908), UINT64_C(0xbb67ae8584caa73b),
         UINT64_C(0x3c6ef372fe94f82b), UINT64_C(0xa54ff53a5f1d36f1),
         UINT64_C(0x510e527fade682d1), UINT64_C(0x9b05688c2b3e6c1f),
         UINT64_C(0x1f83d9abfb41bd6b), UINT64_C(0x5be0cd19137e2179)},
        {UINT64_C(0xcbbb9d5dc1059ed8), UINT64_C(0x629a292a367cd507),
         UINT64_C(0x9159015a3070dd17), UINT64_C(0x152fecd8f70e5939),
         UINT64_C(0x67332667ffc00b31), UINT64_C(0x8eb44a8768581511),
         UINT64_C(0xdb0c2e0d64f98fa7), UINT64_C(0x47b5481dbefa4fa4)},
    };
    memset(ctx, 0, sizeof(*ctx));
    memcpy(ctx->state, initial[sha384 ? 1 : 0], sizeof(ctx->state));
}

static void mal_sha512_compress(MalSha512 *ctx, const u8 *data) {
    u64 w[80];
    for (usize i = 0; i < 16; i++) {
        w[i] = 0;
        for (usize j = 0; j < 8; j++) w[i] = (w[i] << 8) | data[i * 8 + j];
    }
    for (usize i = 16; i < 80; i++) {
        u64 a = w[i - 15], b = w[i - 2];
        w[i] = w[i - 16] + (mal_sha512_rotr(a, 1) ^ mal_sha512_rotr(a, 8) ^ (a >> 7))
            + w[i - 7] + (mal_sha512_rotr(b, 19) ^ mal_sha512_rotr(b, 61) ^ (b >> 6));
    }
    u64 a = ctx->state[0], b = ctx->state[1], c = ctx->state[2], d = ctx->state[3];
    u64 e = ctx->state[4], f = ctx->state[5], g = ctx->state[6], h = ctx->state[7];
    for (usize i = 0; i < 80; i++) {
        u64 t1 = h + (mal_sha512_rotr(e, 14) ^ mal_sha512_rotr(e, 18) ^ mal_sha512_rotr(e, 41))
            + ((e & f) ^ (~e & g)) + MAL_SHA512_K[i] + w[i];
        u64 t2 = (mal_sha512_rotr(a, 28) ^ mal_sha512_rotr(a, 34) ^ mal_sha512_rotr(a, 39))
            + ((a & b) ^ (a & c) ^ (b & c));
        h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    ctx->state[0] += a; ctx->state[1] += b; ctx->state[2] += c; ctx->state[3] += d;
    ctx->state[4] += e; ctx->state[5] += f; ctx->state[6] += g; ctx->state[7] += h;
}

static void mal_sha512_update(MalSha512 *ctx, const u8 *data, usize length) {
    u64 before = ctx->bit_low;
    ctx->bit_low += (u64) length << 3;
    ctx->bit_high += ((u64) length >> 61) + (ctx->bit_low < before);
    if (ctx->block_len > 0) {
        usize take = length < 128 - ctx->block_len ? length : 128 - ctx->block_len;
        if (take > 0) memcpy(ctx->block + ctx->block_len, data, take);
        ctx->block_len += take;
        data += take; length -= take;
        if (ctx->block_len < 128) return;
        mal_sha512_compress(ctx, ctx->block);
        ctx->block_len = 0;
    }
    while (length >= 128) {
        mal_sha512_compress(ctx, data);
        data += 128; length -= 128;
    }
    if (length > 0) memcpy(ctx->block, data, length);
    ctx->block_len = length;
}

static void mal_sha512_final(MalSha512 *ctx, u8 *out, usize length) {
    usize filled = ctx->block_len;
    ctx->block[filled++] = 0x80;
    if (filled > 112) {
        memset(ctx->block + filled, 0, 128 - filled);
        mal_sha512_compress(ctx, ctx->block);
        filled = 0;
    }
    memset(ctx->block + filled, 0, 112 - filled);
    for (usize i = 0; i < 8; i++) {
        ctx->block[112 + i] = (u8) (ctx->bit_high >> (56 - 8 * i));
        ctx->block[120 + i] = (u8) (ctx->bit_low >> (56 - 8 * i));
    }
    mal_sha512_compress(ctx, ctx->block);
    for (usize i = 0; i < length; i++) out[i] = (u8) (ctx->state[i / 8] >> (56 - 8 * (i % 8)));
}

#endif

typedef enum {
    MAL_NODE_CRYPTO_SHA1,
    MAL_NODE_CRYPTO_SHA256,
    MAL_NODE_CRYPTO_SHA384,
    MAL_NODE_CRYPTO_SHA512,
    MAL_NODE_CRYPTO_MD5,
    MAL_NODE_CRYPTO_SHA224,
} MalNodeCryptoStateKind;

typedef union {
    MalSha1 sha1;
    MalSha256 sha256;
    MalSha512 sha512;
    MalMd5 md5;
} MalNodeCryptoDigest;

typedef struct {
    MalNodeCryptoStateKind kind;
    bool finalized;
    /* An HMAC keeps its opad-absorbed context in `outer`; a plain hash leaves it unused. */
    bool hmac;
    MalNodeCryptoDigest digest;
    MalNodeCryptoDigest outer;
} MalNodeCryptoState;

static void crypto_digest_init(MalNodeCryptoStateKind kind, MalNodeCryptoDigest *digest) {
    if (kind == MAL_NODE_CRYPTO_SHA1) {
        mal_sha1_init(&digest->sha1);
    } else if (kind == MAL_NODE_CRYPTO_SHA256 || kind == MAL_NODE_CRYPTO_SHA224) {
        mal_sha256_init(&digest->sha256);
        if (kind == MAL_NODE_CRYPTO_SHA224) {
            static const u32 iv[8] = {0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939,
                0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4};
            memcpy(digest->sha256.state, iv, sizeof(iv));
        }
    } else if (kind == MAL_NODE_CRYPTO_MD5) {
        mal_md5_init(&digest->md5);
    } else {
        mal_sha512_init(&digest->sha512, kind == MAL_NODE_CRYPTO_SHA384);
    }
}

static usize crypto_digest_size(MalNodeCryptoStateKind kind) {
    switch (kind) {
        case MAL_NODE_CRYPTO_SHA1: return 20;
        case MAL_NODE_CRYPTO_MD5: return 16;
        case MAL_NODE_CRYPTO_SHA224: return 28;
        case MAL_NODE_CRYPTO_SHA384: return 48;
        case MAL_NODE_CRYPTO_SHA512: return 64;
        default: return 32;
    }
}

static usize crypto_digest_block_size(MalNodeCryptoStateKind kind) {
    return kind == MAL_NODE_CRYPTO_SHA384 || kind == MAL_NODE_CRYPTO_SHA512 ? 128 : 64;
}

static void crypto_digest_absorb(
    MalNodeCryptoStateKind kind, MalNodeCryptoDigest *digest, const u8 *data, usize length) {
    if (kind == MAL_NODE_CRYPTO_SHA1) mal_sha1_update(&digest->sha1, data, length);
    else if (kind == MAL_NODE_CRYPTO_SHA256 || kind == MAL_NODE_CRYPTO_SHA224) {
        mal_sha256_update(&digest->sha256, data, length);
    } else if (kind == MAL_NODE_CRYPTO_MD5) mal_md5_update(&digest->md5, data, length);
    else mal_sha512_update(&digest->sha512, data, length);
}

static void crypto_digest_emit(MalNodeCryptoStateKind kind, MalNodeCryptoDigest *digest, u8 *out) {
    if (kind == MAL_NODE_CRYPTO_SHA1) {
        mal_sha1_final(&digest->sha1, out);
    } else if (kind == MAL_NODE_CRYPTO_SHA256) {
        mal_sha256_final(&digest->sha256, out);
    } else if (kind == MAL_NODE_CRYPTO_SHA224) {
        u8 full[32];
        mal_sha256_final(&digest->sha256, full);
        memcpy(out, full, 28);
        mal_secure_scrub((byte *) full, sizeof(full));
    } else if (kind == MAL_NODE_CRYPTO_MD5) {
        mal_md5_final(&digest->md5, out);
    } else {
        mal_sha512_final(&digest->sha512, out, crypto_digest_size(kind));
    }
}

static void crypto_digest_start(MalNodeCryptoState *state, MalNodeCryptoStateKind kind) {
    state->kind = kind;
    state->finalized = false;
    state->hmac = false;
    crypto_digest_init(kind, &state->digest);
}

/* Writes crypto_digest_size(state->kind) bytes; an HMAC runs its outer pass here. */
static void crypto_digest_finish(MalNodeCryptoState *state, u8 *out) {
    if (!state->hmac) {
        crypto_digest_emit(state->kind, &state->digest, out);
        return;
    }
    u8 inner[64];
    crypto_digest_emit(state->kind, &state->digest, inner);
    crypto_digest_absorb(state->kind, &state->outer, inner, crypto_digest_size(state->kind));
    crypto_digest_emit(state->kind, &state->outer, out);
    mal_secure_scrub((byte *) inner, sizeof(inner));
}

static bool crypto_digest_kind(const MalString *name, MalNodeCryptoStateKind *kind) {
    static const struct { const char *name; MalNodeCryptoStateKind kind; } digests[] = {
        {"sha1", MAL_NODE_CRYPTO_SHA1}, {"sha224", MAL_NODE_CRYPTO_SHA224},
        {"sha256", MAL_NODE_CRYPTO_SHA256}, {"sha384", MAL_NODE_CRYPTO_SHA384},
        {"sha512", MAL_NODE_CRYPTO_SHA512}, {"md5", MAL_NODE_CRYPTO_MD5},
        {"sha-1", MAL_NODE_CRYPTO_SHA1}, {"sha-224", MAL_NODE_CRYPTO_SHA224},
        {"sha-256", MAL_NODE_CRYPTO_SHA256}, {"sha-384", MAL_NODE_CRYPTO_SHA384},
        {"sha-512", MAL_NODE_CRYPTO_SHA512}, {"rsa-sha1", MAL_NODE_CRYPTO_SHA1},
        {"rsa-sha256", MAL_NODE_CRYPTO_SHA256}, {"rsa-sha384", MAL_NODE_CRYPTO_SHA384},
        {"rsa-sha512", MAL_NODE_CRYPTO_SHA512}, {"rsa-md5", MAL_NODE_CRYPTO_MD5},
    };
    for (usize i = 0; i < countof(digests); i++) {
        if (mal_string_equals_ascii_ci(name, digests[i].name)) {
            *kind = digests[i].kind;
            return true;
        }
    }
    return false;
}

/* Absorbs both pads once, so each later MAC costs only the message and two finals. */
static void crypto_hmac_init(MalNodeCryptoState *state, MalNodeCryptoStateKind kind, const u8 *key, usize length) {
    usize block_size = crypto_digest_block_size(kind);
    u8 block[128] = {0};
    if (length > block_size) {
        MalNodeCryptoDigest digest;
        crypto_digest_init(kind, &digest);
        crypto_digest_absorb(kind, &digest, key, length);
        crypto_digest_emit(kind, &digest, block);
        mal_secure_scrub((byte *) &digest, sizeof(digest));
    } else if (length > 0) {
        memcpy(block, key, length);
    }
    u8 pad[128];
    crypto_digest_start(state, kind);
    state->hmac = true;
    crypto_digest_init(kind, &state->outer);
    for (usize i = 0; i < block_size; i++) pad[i] = block[i] ^ 0x36;
    crypto_digest_absorb(kind, &state->digest, pad, block_size);
    for (usize i = 0; i < block_size; i++) pad[i] = block[i] ^ 0x5c;
    crypto_digest_absorb(kind, &state->outer, pad, block_size);
    mal_secure_scrub((byte *) block, sizeof(block));
    mal_secure_scrub((byte *) pad, sizeof(pad));
}

typedef MalNodeCryptoState CryptoHmac;

static void crypto_hmac(const CryptoHmac *hmac, const u8 *a, usize a_length, const u8 *b,
    usize b_length, const u8 *c, usize c_length, u8 *out) {
    MalNodeCryptoState context = *hmac;
    if (a_length > 0) crypto_digest_absorb(context.kind, &context.digest, a, a_length);
    if (b_length > 0) crypto_digest_absorb(context.kind, &context.digest, b, b_length);
    if (c_length > 0) crypto_digest_absorb(context.kind, &context.digest, c, c_length);
    crypto_digest_finish(&context, out);
    mal_secure_scrub((byte *) &context, sizeof(context));
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
    crypto_digest_absorb(state->kind, &state->digest, data, length);
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
    byte *owned;
    if (!crypto_byte_source_span(vm, data, "data", &span, &owned)) {
        return mal_value_new_undefined();
    }
    if (span.length > 0) {
        mal_node_crypto_state_update(state, (const u8 *) span.data, span.length);
    }
    crypto_scrub_free(owned, span.length);
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
    u8 result[64];
    usize length = crypto_digest_size(state->kind);
    crypto_digest_finish(state, result);
    // `result` already holds the digest, so the absorbing state is spent. For
    // HMAC it is the outer pad — the key XOR 0x5c, and so the key — which
    // otherwise outlived the object in the freed backing store. Only the union
    // is cleared: `kind` and `finalized` must survive to keep refusing a second
    // digest() on this receiver.
    mal_secure_scrub((byte *) &state->digest, sizeof(state->digest));
    mal_secure_scrub((byte *) &state->outer, sizeof(state->outer));
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
    MalNodeCryptoState state = {0};
    MalNodeCryptoStateKind kind;
    if (!crypto_digest_kind(mal_value_to_string(args[0]), &kind)) {
        crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "crypto.createHash: unsupported algorithm");
        return mal_value_new_undefined();
    }
    crypto_digest_start(&state, kind);
    return mal_node_crypto_new_state(vm, callee, &state);
}

/* Secret KeyObjects keep their bytes in a sensitive ArrayBuffer behind a
 * private symbol, so only this module can read them back. */
static MAL_ISOLATE_LOCAL MalValue crypto_key_symbol;
static MAL_ISOLATE_LOCAL MalValue crypto_key_object_constructor;
static MAL_ISOLATE_LOCAL MalValue crypto_secret_key_prototype;
static MAL_ISOLATE_LOCAL MalValue crypto_crypto_key_symbol;
static MAL_ISOLATE_LOCAL MalValue crypto_crypto_key_prototype;
static MAL_ISOLATE_LOCAL MalValue crypto_cipher_symbol;
static MAL_ISOLATE_LOCAL MalValue crypto_cipheriv_prototype;
static MAL_ISOLATE_LOCAL MalValue crypto_decipheriv_prototype;
static MAL_ISOLATE_LOCAL MalValue crypto_pkey_symbol;
static MAL_ISOLATE_LOCAL MalValue crypto_x509_symbol;
static MAL_ISOLATE_LOCAL MalValue crypto_x509_info_symbol;
static MAL_ISOLATE_LOCAL bool crypto_x509_ready;
static MAL_ISOLATE_LOCAL MalValue crypto_signer_meta_symbol;
static MAL_ISOLATE_LOCAL MalValue crypto_asymmetric_key_prototype;
static MAL_ISOLATE_LOCAL MalValue crypto_public_key_prototype;
static MAL_ISOLATE_LOCAL MalValue crypto_private_key_prototype;
static MAL_ISOLATE_LOCAL MalValue crypto_sign_prototype;
static MAL_ISOLATE_LOCAL MalValue crypto_verify_prototype;
static MAL_ISOLATE_LOCAL bool crypto_keys_ready;

static bool crypto_secret_key_bytes(MalValue value, const byte **data, usize *length) {
    if (!crypto_keys_ready || !mal_value_is_object(value)) return false;
    MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(value),
        (MalKey) {.kind = MAL_KEY_SYMBOL, .value = crypto_key_symbol});
    if (!lookup.present || !mal_value_is_array_buffer_object(lookup.desc.value)) return false;
    MalArrayBufferObject *buffer = mal_value_to_array_buffer_object(lookup.desc.value);
    *data = buffer->data;
    *length = buffer->byte_length;
    return true;
}

static bool mal_node_crypto_hmac_init(
    MalVm *vm, MalNodeCryptoState *state, MalNodeCryptoStateKind kind, MalValue key
) {
    const byte *key_data;
    usize key_length;
    if (crypto_secret_key_bytes(key, &key_data, &key_length)) {
        crypto_hmac_init(state, kind, (const u8 *) key_data, key_length);
        return true;
    }
    if (mal_value_is_string(key)) {
        MalString *string = mal_value_to_string(key);
        usize length;
        byte *bytes = mal_string_to_utf8(string, &length);
        if (bytes == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        crypto_hmac_init(state, kind, (const u8 *) bytes, length);
        // This is the HMAC key, materialized by us from a JavaScript string.
        crypto_scrub_free(bytes, length);
        return true;
    }
    MalBufferSourceSpan span;
    byte *owned;
    if (!crypto_byte_source_span(vm, key, "key", &span, &owned)) return false;
    crypto_hmac_init(state, kind, (const u8 *) span.data, span.length);
    crypto_scrub_free(owned, span.length);
    return true;
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
    MalNodeCryptoStateKind kind;
    if (!crypto_digest_kind(mal_value_to_string(args[0]), &kind)) {
        char name[64];
        crypto_copy_string(mal_value_to_string(args[0]), name, sizeof(name));
        char message[CRYPTO_MESSAGE_CAPACITY];
        snprintf(message, sizeof(message), "Invalid digest: %s", name);
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_CRYPTO_INVALID_DIGEST");
        return mal_value_new_undefined();
    }
    if (argc < 2) {
        crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "crypto.createHmac: key is required");
        return mal_value_new_undefined();
    }
    MalNodeCryptoState state = {0};
    if (!mal_node_crypto_hmac_init(vm, &state, kind, args[1])) {
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
 * Key derivation (pbkdf2, scrypt, hkdf), randomFill, getRandomValues, UUIDv7.
 * --------------------------------------------------------------------------- */

static void crypto_pbkdf2(MalNodeCryptoStateKind kind, const u8 *password, usize password_length,
    const u8 *salt, usize salt_length, u64 iterations, u8 *out, usize length) {
    CryptoHmac hmac;
    crypto_hmac_init(&hmac, kind, password, password_length);
    usize digest_size = crypto_digest_size(kind);
    for (usize block = 1, offset = 0; offset < length; block++, offset += digest_size) {
        u8 index[4] = {(u8) (block >> 24), (u8) (block >> 16), (u8) (block >> 8), (u8) block};
        u8 value[64];
        u8 folded[64];
        crypto_hmac(&hmac, salt, salt_length, index, sizeof(index), nullptr, 0, value);
        memcpy(folded, value, digest_size);
        for (u64 round = 1; round < iterations; round++) {
            crypto_hmac(&hmac, value, digest_size, nullptr, 0, nullptr, 0, value);
            for (usize i = 0; i < digest_size; i++) folded[i] ^= value[i];
        }
        memcpy(out + offset, folded, length - offset < digest_size ? length - offset : digest_size);
        mal_secure_scrub((byte *) value, sizeof(value));
        mal_secure_scrub((byte *) folded, sizeof(folded));
    }
    mal_secure_scrub((byte *) &hmac, sizeof(hmac));
}

static inline u32 crypto_load32_le(const u8 *p) {
    return (u32) p[0] | ((u32) p[1] << 8) | ((u32) p[2] << 16) | ((u32) p[3] << 24);
}

static inline void crypto_store32_le(u8 *p, u32 v) {
    p[0] = (u8) v; p[1] = (u8) (v >> 8); p[2] = (u8) (v >> 16); p[3] = (u8) (v >> 24);
}

static void crypto_salsa20_8(u32 b[16]) {
    u32 x[16];
    memcpy(x, b, sizeof(x));
    for (int i = 0; i < 8; i += 2) {
#define CRYPTO_R(a, n) (((a) << (n)) | ((a) >> (32 - (n))))
        x[4] ^= CRYPTO_R(x[0] + x[12], 7);  x[8] ^= CRYPTO_R(x[4] + x[0], 9);
        x[12] ^= CRYPTO_R(x[8] + x[4], 13); x[0] ^= CRYPTO_R(x[12] + x[8], 18);
        x[9] ^= CRYPTO_R(x[5] + x[1], 7);   x[13] ^= CRYPTO_R(x[9] + x[5], 9);
        x[1] ^= CRYPTO_R(x[13] + x[9], 13); x[5] ^= CRYPTO_R(x[1] + x[13], 18);
        x[14] ^= CRYPTO_R(x[10] + x[6], 7); x[2] ^= CRYPTO_R(x[14] + x[10], 9);
        x[6] ^= CRYPTO_R(x[2] + x[14], 13); x[10] ^= CRYPTO_R(x[6] + x[2], 18);
        x[3] ^= CRYPTO_R(x[15] + x[11], 7); x[7] ^= CRYPTO_R(x[3] + x[15], 9);
        x[11] ^= CRYPTO_R(x[7] + x[3], 13); x[15] ^= CRYPTO_R(x[11] + x[7], 18);
        x[1] ^= CRYPTO_R(x[0] + x[3], 7);   x[2] ^= CRYPTO_R(x[1] + x[0], 9);
        x[3] ^= CRYPTO_R(x[2] + x[1], 13);  x[0] ^= CRYPTO_R(x[3] + x[2], 18);
        x[6] ^= CRYPTO_R(x[5] + x[4], 7);   x[7] ^= CRYPTO_R(x[6] + x[5], 9);
        x[4] ^= CRYPTO_R(x[7] + x[6], 13);  x[5] ^= CRYPTO_R(x[4] + x[7], 18);
        x[11] ^= CRYPTO_R(x[10] + x[9], 7); x[8] ^= CRYPTO_R(x[11] + x[10], 9);
        x[9] ^= CRYPTO_R(x[8] + x[11], 13); x[10] ^= CRYPTO_R(x[9] + x[8], 18);
        x[12] ^= CRYPTO_R(x[15] + x[14], 7); x[13] ^= CRYPTO_R(x[12] + x[15], 9);
        x[14] ^= CRYPTO_R(x[13] + x[12], 13); x[15] ^= CRYPTO_R(x[14] + x[13], 18);
#undef CRYPTO_R
    }
    for (int i = 0; i < 16; i++) b[i] += x[i];
}

/* scrypt BlockMix over 2r 64-byte words held as u32 little-endian lanes. */
static void crypto_scrypt_block_mix(const u32 *in, u32 *out, u32 *x, u64 r) {
    memcpy(x, &in[(2 * r - 1) * 16], 64);
    for (u64 i = 0; i < 2 * r; i++) {
        for (int j = 0; j < 16; j++) x[j] ^= in[i * 16 + (u64) j];
        crypto_salsa20_8(x);
        memcpy(&out[((i & 1) * r + i / 2) * 16], x, 64);
    }
}

/* RFC 7914; `v` holds N blocks of 128r bytes and `xy` three more. */
static void crypto_scrypt_ro_mix(u8 *block, u64 r, u64 n, u32 *v, u32 *xy) {
    u64 words = 32 * r;
    u32 *x = xy;
    u32 *y = xy + words;
    u32 *t = xy + 2 * words;
    for (u64 k = 0; k < words; k++) x[k] = crypto_load32_le(block + 4 * k);
    for (u64 i = 0; i < n; i++) {
        memcpy(&v[i * words], x, words * 4);
        crypto_scrypt_block_mix(x, y, t, r);
        memcpy(x, y, words * 4);
    }
    for (u64 i = 0; i < n; i++) {
        u64 j = x[(2 * r - 1) * 16] & (n - 1);
        for (u64 k = 0; k < words; k++) x[k] ^= v[j * words + k];
        crypto_scrypt_block_mix(x, y, t, r);
        memcpy(x, y, words * 4);
    }
    for (u64 k = 0; k < words; k++) crypto_store32_le(block + 4 * k, x[k]);
}

static bool crypto_scrypt(const u8 *password, usize password_length, const u8 *salt,
    usize salt_length, u64 n, u64 r, u64 p, u8 *out, usize length) {
    usize block_bytes = (usize) (128 * r);
    u8 *b = malloc(block_bytes * p);
    u32 *v = malloc(block_bytes * n);
    u32 *xy = malloc(block_bytes * 2 + 64);
    bool ok = b != nullptr && v != nullptr && xy != nullptr;
    if (ok) {
        crypto_pbkdf2(MAL_NODE_CRYPTO_SHA256, password, password_length, salt, salt_length, 1, b, block_bytes * p);
        for (u64 i = 0; i < p; i++) crypto_scrypt_ro_mix(b + i * block_bytes, r, n, v, xy);
        crypto_pbkdf2(MAL_NODE_CRYPTO_SHA256, password, password_length, b, block_bytes * p, 1, out, length);
    }
    if (b != nullptr) crypto_scrub_free((byte *) b, block_bytes * p);
    if (v != nullptr) crypto_scrub_free((byte *) v, block_bytes * n);
    if (xy != nullptr) crypto_scrub_free((byte *) xy, block_bytes * 2 + 64);
    return ok;
}

/* RFC 5869 extract-then-expand. */
static void crypto_hkdf(MalNodeCryptoStateKind kind, const u8 *key, usize key_length,
    const u8 *salt, usize salt_length, const u8 *info, usize info_length, u8 *out, usize length) {
    CryptoHmac hmac;
    u8 zero_salt[64] = {0};
    usize digest_size = crypto_digest_size(kind);
    crypto_hmac_init(&hmac, kind, salt_length > 0 ? salt : zero_salt, salt_length > 0 ? salt_length : digest_size);
    u8 prk[64];
    crypto_hmac(&hmac, key, key_length, nullptr, 0, nullptr, 0, prk);
    crypto_hmac_init(&hmac, kind, prk, digest_size);
    u8 t[64];
    usize t_length = 0;
    for (usize offset = 0, counter = 1; offset < length; counter++, offset += digest_size) {
        u8 c = (u8) counter;
        crypto_hmac(&hmac, t, t_length, info, info_length, &c, 1, t);
        t_length = digest_size;
        memcpy(out + offset, t, length - offset < digest_size ? length - offset : digest_size);
    }
    mal_secure_scrub(prk, sizeof(prk));
    mal_secure_scrub(t, sizeof(t));
    mal_secure_scrub((byte *) &hmac, sizeof(hmac));
}

typedef enum { CRYPTO_KDF_PBKDF2, CRYPTO_KDF_SCRYPT, CRYPTO_KDF_HKDF } CryptoKdfKind;

typedef struct {
    CryptoKdfKind kind;
    MalNodeCryptoStateKind digest;
    u8 *password;
    usize password_length;
    u8 *salt;
    usize salt_length;
    u8 *info;
    usize info_length;
    u64 iterations;
    u64 n;
    u64 r;
    u64 p;
    u8 *output;
    usize length;
    bool ok;
} CryptoKdfJob;

static void crypto_kdf_job_free(void *data) {
    CryptoKdfJob *job = data;
    if (job == nullptr) return;
    crypto_scrub_free((byte *) job->password, job->password_length);
    crypto_scrub_free((byte *) job->salt, job->salt_length);
    crypto_scrub_free((byte *) job->info, job->info_length);
    crypto_scrub_free((byte *) job->output, job->length);
    free(job);
}

static void crypto_kdf_run(void *data) {
    CryptoKdfJob *job = data;
    if (job->kind == CRYPTO_KDF_PBKDF2) {
        crypto_pbkdf2(job->digest, job->password, job->password_length, job->salt, job->salt_length,
            job->iterations, job->output, job->length);
        job->ok = true;
    } else if (job->kind == CRYPTO_KDF_SCRYPT) {
        job->ok = crypto_scrypt(job->password, job->password_length, job->salt, job->salt_length,
            job->n, job->r, job->p, job->output, job->length);
    } else {
        crypto_hkdf(job->digest, job->password, job->password_length, job->salt, job->salt_length,
            job->info, job->info_length, job->output, job->length);
        job->ok = true;
    }
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
    CRYPTO_ASYNC_RANDOM_FILL,
    /* generateKeyPair: `value` holds the generated pair, delivered as two callback arguments. */
    CRYPTO_ASYNC_KEY_PAIR,
    /* pbkdf2/scrypt/hkdf on the blocking-work pool; the payload stays host-owned. */
    CRYPTO_ASYNC_KDF,
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
    /* The randomFill target handed back to the callback. */
    MalValue value;
    MalAsyncContext *async_context;
#if MAL_REALMS
    MalRealm *realm;
#endif
    struct MalNodeCryptoAsync *next;
} MalNodeCryptoAsync;

// Pending callbacks and their root registration belong to this mutator's isolate.
static MAL_ISOLATE_LOCAL MalNodeCryptoAsync *crypto_async_states;
static MAL_ISOLATE_LOCAL bool crypto_roots_installed;

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
    if (crypto_keys_ready) {
        mal_gc_mark_value(crypto_key_symbol);
        mal_gc_mark_value(crypto_key_object_constructor);
        mal_gc_mark_value(crypto_secret_key_prototype);
        mal_gc_mark_value(crypto_crypto_key_symbol);
        mal_gc_mark_value(crypto_crypto_key_prototype);
        mal_gc_mark_value(crypto_cipher_symbol);
        mal_gc_mark_value(crypto_cipheriv_prototype);
        mal_gc_mark_value(crypto_decipheriv_prototype);
        mal_gc_mark_value(crypto_pkey_symbol);
        mal_gc_mark_value(crypto_signer_meta_symbol);
        mal_gc_mark_value(crypto_asymmetric_key_prototype);
        mal_gc_mark_value(crypto_public_key_prototype);
        mal_gc_mark_value(crypto_private_key_prototype);
        mal_gc_mark_value(crypto_sign_prototype);
        mal_gc_mark_value(crypto_verify_prototype);
    }
    if (crypto_x509_ready) {
        mal_gc_mark_value(crypto_x509_symbol);
        mal_gc_mark_value(crypto_x509_info_symbol);
    }
    for (MalNodeCryptoAsync *state = crypto_async_states; state != nullptr;
        state = state->next) {
        if (state->vm != vm) continue;
        mal_gc_mark_value(state->callback);
        mal_gc_mark_value(state->value);
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
    state->value = mal_value_new_undefined();
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
    args[2] = mal_value_new_undefined();
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
    if (state->kind == CRYPTO_ASYNC_KDF) {
        CryptoKdfJob *job = mal_blocking_work_result_data(data);
        if (task->result != MAL_HOST_TERMINAL_OK || job == nullptr || !job->ok) {
            mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Crypto operation failed",
                "ERR_CRYPTO_OPERATION_FAILED");
            return false;
        }
        byte *output = (byte *) job->output;
        job->output = nullptr;
        if (job->kind == CRYPTO_KDF_HKDF) {
            args[1] = mal_value_from_array_buffer_object(mal_array_buffer_object_adopt(&vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
                output, (u32) job->length, true));
        } else {
            args[1] = mal_node_buffer_from_owned_secret_bytes(vm, output, job->length);
        }
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
    if (state->kind == CRYPTO_ASYNC_RANDOM_FILL) {
        args[1] = state->value;
        return true;
    }
    if (state->kind == CRYPTO_ASYNC_KEY_PAIR) {
        MalObject *pair = mal_value_to_object(state->value);
        MalPropertyLookup public_key = mal_object_get_own(pair,
            mal_intrinsic_string_key(vm, (const byte *) "publicKey"));
        MalPropertyLookup private_key = mal_object_get_own(pair,
            mal_intrinsic_string_key(vm, (const byte *) "privateKey"));
        args[0] = mal_value_new_null();
        args[1] = public_key.present ? public_key.desc.value : mal_value_new_undefined();
        args[2] = private_key.present ? private_key.desc.value : mal_value_new_undefined();
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
    // A blocking-work wrapper is borrowed until release; taking it strands its reservation.
    void *data = state->kind == CRYPTO_ASYNC_KDF ? task.data : mal_host_task_take_data(&host->tasks, &task);

#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_realm_switch(vm, state->realm);
#endif
    // The result is built while `state` is still linked, so a collection during
    // the Buffer allocation still reaches the callback through crypto_scan_roots.
    MalValue args[3];
    CryptoAsyncKind kind = state->kind;
    bool ready = crypto_async_arguments(vm, state, &task, data, args);
    if (!ready) {
        // A failed completion is delivered as the callback's first argument, not
        // rethrown: the callback must run exactly once either way.
        args[0] = vm->completion.value;
        args[1] = mal_value_new_undefined();
        args[2] = mal_value_new_undefined();
        vm->completion.kind = MAL_COMPLETION_NORMAL;
    }
    // take_data moved ownership out of the task, so the payload is released here.
    if (kind == CRYPTO_ASYNC_ARGON2) {
        mal_argon2_result_release(data);
    } else if (kind != CRYPTO_ASYNC_KDF) {
        crypto_immediate_destroy(data);
    }
    MalValue callback = state->callback;
    MalAsyncContext *async_context = state->async_context;
    *link = state->next;
    free(state);

    MalValue roots[] = {callback, args[0], args[1], args[2],
        mal_async_internal_value((MalHeapHeader *) async_context)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalAsyncContextScope scope;
    mal_async_context_scope_enter(vm, &scope, async_context);
    mal_vm_call_value(vm, roots[0], mal_value_new_undefined(), &roots[1], kind == CRYPTO_ASYNC_KEY_PAIR ? 3 : 2);
    mal_async_context_scope_exit(vm, &scope);
    mal_gc_unroot(&root);
#if MAL_REALMS
    mal_realm_switch(vm, saved_realm);
#endif

    mal_host_task_release(&host->tasks, &task);
    return true;
}

static void mal_node_crypto_free(MalVm *vm) {
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
    return mal_node_crypto_byte_span(vm, value, span, owned);
}

static bool crypto_digest_arg(MalVm *vm, MalValue value, MalNodeCryptoStateKind *kind);

static MalValue mal_node_crypto_pbkdf2_sync(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalNodeCryptoStateKind digest;
    if (!crypto_digest_arg(vm, argc > 4 ? args[4] : mal_value_new_undefined(), &digest)) {
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
    crypto_pbkdf2(digest, (const u8 *) password.data, password.length, (const u8 *) salt.data,
        salt.length, iterations, (u8 *) output, key_length);
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
    byte *owned_left;
    byte *owned_right;
    if (!crypto_byte_source_span(
            vm, argc >= 1 ? args[0] : mal_value_new_undefined(), "buf1", &left, &owned_left)) {
        return mal_value_new_undefined();
    }
    if (!crypto_byte_source_span(
            vm, argc >= 2 ? args[1] : mal_value_new_undefined(), "buf2", &right, &owned_right)) {
        crypto_scrub_free(owned_left, left.length);
        return mal_value_new_undefined();
    }
    if (left.length != right.length) {
        crypto_scrub_free(owned_left, left.length);
        crypto_scrub_free(owned_right, right.length);
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
    crypto_scrub_free(owned_left, left.length);
    crypto_scrub_free(owned_right, right.length);
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

    if (!mal_value_is_string(algorithm)) {
        crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "crypto.hash: algorithm must be a string");
        return mal_value_new_undefined();
    }
    MalString *name = mal_value_to_string(algorithm);
    MalNodeCryptoState state = {0};
    MalNodeCryptoStateKind kind;
    if (!crypto_digest_kind(name, &kind)) {
        crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "crypto.hash: unsupported algorithm");
        return mal_value_new_undefined();
    }
    crypto_digest_start(&state, kind);
    usize digest_length = crypto_digest_size(kind);

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

    // No VM allocation occurs while an input view is borrowed.
    if (data_is_byte_source) {
        MalBufferSourceSpan span;
        byte *owned;
        if (!mal_node_crypto_byte_span(vm, data, &span, &owned)) {
            return mal_value_new_undefined();
        }
        if (span.length > 0) {
            mal_node_crypto_state_update(&state, (const u8 *) span.data, span.length);
        }
        crypto_scrub_free(owned, span.length);
    } else {
        MalString *data_str = mal_value_to_string(data);
        usize byte_len;
        byte *bytes = mal_string_to_utf8(data_str, &byte_len);
        if (bytes == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        mal_node_crypto_state_update(&state, (const u8 *) bytes, byte_len);
        crypto_scrub_free(bytes, byte_len);
    }

    u8 digest[64];
    crypto_digest_finish(&state, digest);
    mal_secure_scrub((byte *) &state, sizeof(state));

    if (mal_value_is_undefined(encoding)) {
        char hex[128];
        mal_hex_encode_lower((const byte *) digest, digest_length, hex);
        MalValue result = mal_value_from_string(
            mal_string_new_ascii(&vm->heap, (const byte *) hex, digest_length * 2));
        mal_secure_scrub(digest, sizeof(digest));
        mal_secure_scrub((byte *) hex, sizeof(hex));
        return result;
    }
    if (mal_string_equals_ascii_ci(mal_value_to_string(encoding), "buffer")) {
        MalValue result = mal_node_buffer_encode_secret_bytes(
            vm, (const byte *) digest, digest_length, mal_value_new_undefined(), false);
        mal_secure_scrub(digest, sizeof(digest));
        return result;
    }
    // Unlike digest(), crypto.hash() rejects an unrecognized encoding.
    if (!mal_node_buffer_encoding_is_known(encoding)) {
        char received[128];
        crypto_copy_string(mal_value_to_string(encoding), received, sizeof(received));
        char message[CRYPTO_MESSAGE_CAPACITY];
        snprintf(message, sizeof(message),
            "The argument 'outputEncoding' is invalid. Received '%s'", received);
        crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
        mal_secure_scrub(digest, sizeof(digest));
        return mal_value_new_undefined();
    }
    MalValue result = mal_node_buffer_encode_bytes(
        vm, (const byte *) digest, digest_length, encoding, true);
    mal_secure_scrub(digest, sizeof(digest));
    return result;
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
    return crypto_private_span(vm, span, owned);
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

/* Copies one string or buffer-source input; the worker must not touch GC memory. */
static bool crypto_kdf_copy(MalVm *vm, MalValue value, const char *name, u8 **result, usize *length) {
    byte **out = (byte **) result;
    MalBufferSourceSpan span;
    byte *owned = nullptr;
    const byte *key_data;
    if (crypto_secret_key_bytes(value, &key_data, length)) {
        *out = malloc(*length > 0 ? *length : 1);
        if (*out == nullptr) { mal_vm_throw_allocation_error(vm); return false; }
        if (*length > 0) memcpy(*out, key_data, *length);
        return true;
    }
    if (mal_value_is_string(value)) {
        *out = mal_string_to_utf8(mal_value_to_string(value), length);
        if (*out == nullptr) { mal_vm_throw_allocation_error(vm); return false; }
        return true;
    }
    if (!crypto_is_byte_source(value)) {
        crypto_throw_arg_type(vm, name, "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView", value);
        return false;
    }
    if (!crypto_byte_source_span(vm, value, name, &span, &owned)) return false;
    if (owned != nullptr) {
        *out = owned;
    } else {
        *out = malloc(span.length > 0 ? span.length : 1);
        if (*out == nullptr) { mal_vm_throw_allocation_error(vm); return false; }
        if (span.length > 0) memcpy(*out, span.data, span.length);
    }
    *length = span.length;
    return true;
}

static bool crypto_int32_arg(MalVm *vm, MalValue value, const char *name, f64 minimum, u64 *out) {
    if (!mal_ops_is_number(value)) {
        crypto_throw_arg_type(vm, name, "of type number", value);
        return false;
    }
    f64 number = mal_ops_number_as_f64(value);
    if (trunc(number) != number) {
        char message[CRYPTO_MESSAGE_CAPACITY];
        char received[64];
        crypto_number_text(vm, value, received, sizeof(received));
        snprintf(message, sizeof(message),
            "The value of \"%s\" is out of range. It must be an integer. Received %s", name, received);
        mal_node_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, message, "ERR_OUT_OF_RANGE");
        return false;
    }
    if (number < minimum || number > 2147483647.0) {
        char range[64];
        snprintf(range, sizeof(range), ">= %.0f && <= 2147483647", minimum);
        crypto_throw_out_of_range(vm, name, range, value);
        return false;
    }
    *out = (u64) number;
    return true;
}

/* Finishes a sync derivation or queues the job; the job is consumed either way. */
static MalValue crypto_kdf_finish(MalVm *vm, CryptoKdfJob *job, MalValue callback) {
    if (job->length > 0 && job->output == nullptr) {
        job->output = malloc(job->length);
        if (job->output == nullptr) {
            crypto_kdf_job_free(job);
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
    }
    if (mal_value_is_undefined(callback)) {
        crypto_kdf_run(job);
        if (!job->ok) {
            crypto_kdf_job_free(job);
            mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Crypto operation failed",
                "ERR_CRYPTO_OPERATION_FAILED");
            return mal_value_new_undefined();
        }
        byte *output = (byte *) job->output;
        usize length = job->length;
        bool array_buffer = job->kind == CRYPTO_KDF_HKDF;
        job->output = nullptr;
        crypto_kdf_job_free(job);
        if (array_buffer) {
            return mal_value_from_array_buffer_object(mal_array_buffer_object_adopt(&vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
                output, (u32) length, true));
        }
        return mal_node_buffer_from_owned_secret_bytes(vm, output, length);
    }
    if (!crypto_require_host(vm)) { crypto_kdf_job_free(job); return mal_value_new_undefined(); }
    MalNodeCryptoAsync *state = crypto_async_new(vm, CRYPTO_ASYNC_KDF, callback);
    MalBlockingWorkReservation reservation = {0};
    MalHostHandle operation = 0;
    if (state == nullptr
        || !mal_blocking_work_reserve(mal_host(vm), sizeof(*job) + job->length, &reservation)
        || !mal_blocking_work_start(mal_host(vm), crypto_kdf_run, job, crypto_kdf_job_free,
            &reservation, &operation)) {
        mal_blocking_work_reservation_release(&reservation);
        crypto_kdf_job_free(job);
        free(state);
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "crypto work could not be scheduled", "EAGAIN");
        return mal_value_new_undefined();
    }
    crypto_async_link(state, operation);
    return mal_value_new_undefined();
}

static MalValue crypto_kdf_callback_arg(MalVm *vm, const MalValue *args, i32 argc, i32 index, bool *ok) {
    MalValue callback = argc > index ? args[index] : mal_value_new_undefined();
    *ok = mal_value_is_callable(callback);
    if (!*ok) crypto_throw_arg_type(vm, "callback", "of type function", callback);
    return callback;
}

static bool crypto_digest_arg(MalVm *vm, MalValue value, MalNodeCryptoStateKind *kind) {
    if (!mal_value_is_string(value)) {
        crypto_throw_arg_type(vm, "digest", "of type string", value);
        return false;
    }
    if (crypto_digest_kind(mal_value_to_string(value), kind)) return true;
    char name[64];
    crypto_copy_string(mal_value_to_string(value), name, sizeof(name));
    char message[CRYPTO_MESSAGE_CAPACITY];
    snprintf(message, sizeof(message), "Invalid digest: %s", name);
    mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_CRYPTO_INVALID_DIGEST");
    return false;
}

static MalValue mal_node_crypto_pbkdf2(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    bool ok;
    MalValue callback = crypto_kdf_callback_arg(vm, args, argc, 5, &ok);
    if (!ok) return mal_value_new_undefined();
    CryptoKdfJob *job = calloc(1, sizeof(*job));
    if (job == nullptr) { mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
    job->kind = CRYPTO_KDF_PBKDF2;
    u64 length = 0;
    MalValue undefined = mal_value_new_undefined();
    if (!crypto_kdf_copy(vm, argc > 0 ? args[0] : undefined, "password", &job->password, &job->password_length)
        || !crypto_kdf_copy(vm, argc > 1 ? args[1] : undefined, "salt", &job->salt, &job->salt_length)
        || !crypto_int32_arg(vm, argc > 2 ? args[2] : undefined, "iterations", 1, &job->iterations)
        || !crypto_int32_arg(vm, argc > 3 ? args[3] : undefined, "keylen", 0, &length)
        || !crypto_digest_arg(vm, argc > 4 ? args[4] : undefined, &job->digest)) {
        crypto_kdf_job_free(job);
        return mal_value_new_undefined();
    }
    job->length = (usize) length;
    return crypto_kdf_finish(vm, job, callback);
}

static MalValue crypto_scrypt_entry(MalVm *vm, const MalValue *args, i32 argc, bool async) {
    MalValue undefined = mal_value_new_undefined();
    MalValue callback = undefined;
    MalValue options = argc > 3 ? args[3] : undefined;
    if (async) {
        i32 index = argc > 3 && mal_value_is_callable(args[3]) ? 3 : 4;
        if (index == 3) options = undefined;
        bool ok;
        callback = crypto_kdf_callback_arg(vm, args, argc, index, &ok);
        if (!ok) return undefined;
    }
    CryptoKdfJob *job = calloc(1, sizeof(*job));
    if (job == nullptr) { mal_vm_throw_allocation_error(vm); return undefined; }
    job->kind = CRYPTO_KDF_SCRYPT;
    job->n = 16384;
    job->r = 8;
    job->p = 1;
    u64 maxmem = 32ull << 20;
    u64 length = 0;
    if (!crypto_kdf_copy(vm, argc > 0 ? args[0] : undefined, "password", &job->password, &job->password_length)
        || !crypto_kdf_copy(vm, argc > 1 ? args[1] : undefined, "salt", &job->salt, &job->salt_length)
        || !crypto_int32_arg(vm, argc > 2 ? args[2] : undefined, "keylen", 0, &length)) {
        crypto_kdf_job_free(job);
        return undefined;
    }
    if (mal_value_is_object(options)) {
        static const struct { const char *name; const char *alias; int slot; } names[] = {
            {"N", "cost", 0}, {"r", "blockSize", 1}, {"p", "parallelization", 2}, {"maxmem", nullptr, 3}};
        u64 *slots[] = {&job->n, &job->r, &job->p, &maxmem};
        for (usize i = 0; i < countof(names); i++) {
            for (int pass = 0; pass < 2; pass++) {
                const char *name = pass == 0 ? names[i].name : names[i].alias;
                if (name == nullptr) continue;
                MalValue value;
                if (!mal_vm_get_property(vm, options, mal_key_from_value(mal_value_from_string(
                        mal_intrinsic_ascii(vm, (const byte *) name))), &value)) {
                    crypto_kdf_job_free(job);
                    return undefined;
                }
                if (mal_value_is_undefined(value)) continue;
                if (!mal_ops_is_number(value) || mal_ops_number_as_f64(value) < 0
                    || trunc(mal_ops_number_as_f64(value)) != mal_ops_number_as_f64(value)) {
                    crypto_kdf_job_free(job);
                    mal_node_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                        "Invalid scrypt params: invalid parameter", "ERR_CRYPTO_INVALID_SCRYPT_PARAMS");
                    return undefined;
                }
                *slots[names[i].slot] = (u64) mal_ops_number_as_f64(value);
            }
        }
    }
    bool valid = job->n > 1 && (job->n & (job->n - 1)) == 0 && job->r > 0 && job->p > 0
        && job->r * job->p < (1u << 30) && job->n < (1ull << 32) && job->r < (1u << 24);
    if (!valid) {
        crypto_kdf_job_free(job);
        mal_node_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Invalid scrypt params",
            "ERR_CRYPTO_INVALID_SCRYPT_PARAMS");
        return undefined;
    }
    if (128 * job->n * job->r + 128 * job->r * job->p > maxmem) {
        crypto_kdf_job_free(job);
        mal_node_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Invalid scrypt params: error:030000AC:digital envelope routines::memory limit exceeded",
            "ERR_CRYPTO_INVALID_SCRYPT_PARAMS");
        return undefined;
    }
    job->length = (usize) length;
    return crypto_kdf_finish(vm, job, callback);
}

static MalValue mal_node_crypto_scrypt_sync(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    return crypto_scrypt_entry(vm, args, argc, false);
}

static MalValue mal_node_crypto_scrypt(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    return crypto_scrypt_entry(vm, args, argc, true);
}

static MalValue crypto_hkdf_entry(MalVm *vm, const MalValue *args, i32 argc, bool async) {
    MalValue undefined = mal_value_new_undefined();
    MalValue callback = undefined;
    if (async) {
        bool ok;
        callback = crypto_kdf_callback_arg(vm, args, argc, 5, &ok);
        if (!ok) return undefined;
    }
    CryptoKdfJob *job = calloc(1, sizeof(*job));
    if (job == nullptr) { mal_vm_throw_allocation_error(vm); return undefined; }
    job->kind = CRYPTO_KDF_HKDF;
    u64 length = 0;
    if (!crypto_digest_arg(vm, argc > 0 ? args[0] : undefined, &job->digest)
        || !crypto_kdf_copy(vm, argc > 1 ? args[1] : undefined, "ikm", &job->password, &job->password_length)
        || !crypto_kdf_copy(vm, argc > 2 ? args[2] : undefined, "salt", &job->salt, &job->salt_length)
        || !crypto_kdf_copy(vm, argc > 3 ? args[3] : undefined, "info", &job->info, &job->info_length)
        || !crypto_int32_arg(vm, argc > 4 ? args[4] : undefined, "length", 0, &length)) {
        crypto_kdf_job_free(job);
        return undefined;
    }
    if (job->info_length > 1024) {
        crypto_kdf_job_free(job);
        char message[CRYPTO_MESSAGE_CAPACITY];
        snprintf(message, sizeof(message),
            "The value of \"info\" is out of range. It must be <= 1024. Received %zu", job->info_length);
        mal_node_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, message, "ERR_OUT_OF_RANGE");
        return undefined;
    }
    if (length > 255 * crypto_digest_size(job->digest)) {
        crypto_kdf_job_free(job);
        mal_node_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid key length",
            "ERR_CRYPTO_INVALID_KEYLEN");
        return undefined;
    }
    job->length = (usize) length;
    return crypto_kdf_finish(vm, job, callback);
}

static MalValue mal_node_crypto_hkdf_sync(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    return crypto_hkdf_entry(vm, args, argc, false);
}

static MalValue mal_node_crypto_hkdf(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    return crypto_hkdf_entry(vm, args, argc, true);
}

/* The writable byte window of an ArrayBuffer or view, in elements of the view. */
static bool crypto_fill_target(MalVm *vm, MalValue buffer, byte **data, usize *length, usize *element) {
    *element = 1;
    if (mal_value_is_array_buffer_object(buffer)) {
        MalArrayBufferObject *array_buffer = mal_value_to_array_buffer_object(buffer);
        *data = array_buffer->data;
        *length = array_buffer->byte_length;
        return true;
    }
    if (mal_value_is_typed_array_object(buffer) || mal_value_is_data_view_object(buffer)) {
        MalBufferSourceSpan span;
        if (mal_buffer_source_span(buffer, &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
            crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot fill a detached buffer");
            return false;
        }
        *data = (byte *) span.data;
        *length = span.length;
        if (mal_value_is_typed_array_object(buffer)) {
            *element = mal_typed_array_element_size(mal_value_to_typed_array_object(buffer)->kind);
        }
        return true;
    }
    crypto_throw_arg_type(vm, "buf", "an instance of ArrayBuffer or ArrayBufferView", buffer);
    return false;
}

/* Node's randomFill offset/size checks, in elements of the target view. */
static bool crypto_fill_window(MalVm *vm, MalValue offset_value, MalValue size_value, usize length,
    usize element, usize *start, usize *count) {
    usize elements = length / element;
    f64 offset = 0;
    if (!mal_value_is_undefined(offset_value)) {
        if (!crypto_require_number(vm, offset_value, "offset", &offset)) return false;
        if (!(offset >= 0 && offset <= (f64) elements) || trunc(offset) != offset) {
            char range[64];
            snprintf(range, sizeof(range), ">= 0 && <= %zu", elements);
            crypto_throw_out_of_range(vm, "offset", range, offset_value);
            return false;
        }
    }
    f64 count_value = (f64) elements - offset;
    if (!mal_value_is_undefined(size_value)) {
        if (!crypto_require_number(vm, size_value, "size", &count_value)) return false;
        if (!(count_value >= 0 && count_value <= 2147483647.0) || trunc(count_value) != count_value) {
            crypto_throw_out_of_range(vm, "size", ">= 0 && <= 2147483647", size_value);
            return false;
        }
        if (count_value + offset > (f64) elements) {
            char range[64];
            snprintf(range, sizeof(range), "<= %zu", elements);
            crypto_throw_out_of_range(vm, "size + offset", range, mal_ops_number_value(count_value + offset));
            return false;
        }
    }
    *start = (usize) offset * element;
    *count = (usize) count_value * element;
    return true;
}

static MalValue mal_node_crypto_random_fill_sync(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue undefined = mal_value_new_undefined();
    MalValue buffer = argc > 0 ? args[0] : undefined;
    byte *data;
    usize length, element, start, count;
    if (!crypto_fill_target(vm, buffer, &data, &length, &element)
        || !crypto_fill_window(vm, argc > 1 ? args[1] : undefined, argc > 2 ? args[2] : undefined,
            length, element, &start, &count)) {
        return undefined;
    }
    if (count > 0 && mal_host_entropy(data + start, count) != 0) {
        crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, CRYPTO_ENTROPY_UNAVAILABLE);
        return undefined;
    }
    return buffer;
}

/* Fills in place at once and posts the callback, matching randomBytes' delivery. */
static MalValue mal_node_crypto_random_fill(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue undefined = mal_value_new_undefined();
    MalValue buffer = argc > 0 ? args[0] : undefined;
    MalValue callback = argc > 1 ? args[argc - 1] : undefined;
    byte *data;
    usize length, element, start, count;
    if (!crypto_fill_target(vm, buffer, &data, &length, &element)) return undefined;
    if (!mal_value_is_callable(callback)) {
        crypto_throw_arg_type(vm, "callback", "of type function", callback);
        return undefined;
    }
    MalValue offset = argc > 2 ? args[1] : undefined;
    MalValue requested = argc > 3 ? args[2] : undefined;
    if (!crypto_fill_window(vm, offset, requested, length, element, &start, &count)) return undefined;
    if (!crypto_require_host(vm)) return undefined;
    bool drawn = count == 0 || mal_host_entropy(data + start, count) == 0;
    CryptoImmediateResult *result = calloc(1, sizeof(CryptoImmediateResult));
    MalNodeCryptoAsync *state = crypto_async_new(vm, CRYPTO_ASYNC_RANDOM_FILL, callback);
    if (result == nullptr || state == nullptr) {
        free(result);
        free(state);
        mal_vm_throw_allocation_error(vm);
        return undefined;
    }
    state->value = buffer;
    result->failed = !drawn;
    if (!crypto_complete_immediately(vm, state, result)) {
        crypto_immediate_destroy(result);
        free(state);
        crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Crypto operation failed");
    }
    return undefined;
}

static MalValue mal_node_crypto_get_random_values(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue array = argc > 0 ? args[0] : mal_value_new_undefined();
    bool integer = false;
    if (mal_value_is_typed_array_object(array)) {
        MalTypedArrayKind kind = mal_value_to_typed_array_object(array)->kind;
        integer = kind != MAL_TA_FLOAT32 && kind != MAL_TA_FLOAT64;
    }
    if (!integer) {
        mal_dom_exception_throw(vm, (const byte *) "The data argument must be an integer-type TypedArray",
            (const byte *) "TypeMismatchError");
        return mal_value_new_undefined();
    }
    MalBufferSourceSpan span;
    if (mal_buffer_source_span(array, &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
        crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot fill a detached buffer");
        return mal_value_new_undefined();
    }
    if (span.length > 65536) {
        mal_dom_exception_throw(vm, (const byte *) "The requested length exceeds 65,536 bytes",
            (const byte *) "QuotaExceededError");
        return mal_value_new_undefined();
    }
    if (span.length > 0 && mal_host_entropy((byte *) span.data, span.length) != 0) {
        crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, CRYPTO_ENTROPY_UNAVAILABLE);
        return mal_value_new_undefined();
    }
    return array;
}

/* RFC 9562 version 7: 48-bit Unix milliseconds, then random bits. */
static MalValue mal_node_crypto_random_uuid_v7(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target; (void) callee;
    u8 bytes[16];
    if (mal_host_entropy(bytes + 6, 10) != 0) {
        crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, CRYPTO_ENTROPY_UNAVAILABLE);
        return mal_value_new_undefined();
    }
    struct timespec now;
    clock_gettime(CLOCK_REALTIME, &now);
    u64 ms = (u64) now.tv_sec * 1000u + (u64) now.tv_nsec / 1000000u;
    for (int i = 0; i < 6; i++) bytes[i] = (u8) (ms >> (40 - 8 * i));
    bytes[6] = (u8) (0x70 | (bytes[6] & 0x0f));
    bytes[8] = (u8) (0x80 | (bytes[8] & 0x3f));
    char uuid[36];
    usize out = 0;
    for (usize i = 0; i < countof(bytes); i++) {
        if (i == 4 || i == 6 || i == 8 || i == 10) uuid[out++] = '-';
        mal_hex_encode_byte_lower((byte) bytes[i], uuid + out);
        out += 2;
    }
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, (const byte *) uuid, out));
}

static MalValue crypto_name_list(MalVm *vm, const char *const *names, usize count) {
    MalValue *values = calloc(count > 0 ? count : 1, sizeof(MalValue));
    if (values == nullptr) { mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
    MalRootSpan root;
    mal_gc_root(&root, values, (i32) count);
    for (usize i = 0; i < count; i++) {
        values[i] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) names[i]));
    }
    MalValue array = mal_value_from_array_object(mal_array_object_new_from_values(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), values, (u32) count));
    mal_gc_unroot(&root);
    free(values);
    return array;
}

static MalValue mal_node_crypto_get_hashes(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target; (void) callee;
    static const char *const names[] = {"md5", "sha1", "sha224", "sha256", "sha384", "sha512"};
    return crypto_name_list(vm, names, countof(names));
}


static MalValue mal_node_crypto_get_curves(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target; (void) callee;
    return crypto_name_list(vm, nullptr, 0);
}

/* OpenSSL-derived values Node 26 publishes; the TLS layer here is rustls, so they are informational. */
static const struct { const char *name; f64 value; } CRYPTO_NUMERIC_CONSTANTS[] = {
    {"OPENSSL_VERSION_NUMBER", 810549376},
    {"SSL_OP_ALL", 2147485776},
    {"SSL_OP_ALLOW_NO_DHE_KEX", 1024},
    {"SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION", 262144},
    {"SSL_OP_CIPHER_SERVER_PREFERENCE", 4194304},
    {"SSL_OP_CISCO_ANYCONNECT", 32768},
    {"SSL_OP_COOKIE_EXCHANGE", 8192},
    {"SSL_OP_CRYPTOPRO_TLSEXT_BUG", 2147483648},
    {"SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS", 2048},
    {"SSL_OP_LEGACY_SERVER_CONNECT", 4},
    {"SSL_OP_NO_COMPRESSION", 131072},
    {"SSL_OP_NO_ENCRYPT_THEN_MAC", 524288},
    {"SSL_OP_NO_QUERY_MTU", 4096},
    {"SSL_OP_NO_RENEGOTIATION", 1073741824},
    {"SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION", 65536},
    {"SSL_OP_NO_SSLv2", 0},
    {"SSL_OP_NO_SSLv3", 33554432},
    {"SSL_OP_NO_TICKET", 16384},
    {"SSL_OP_NO_TLSv1", 67108864},
    {"SSL_OP_NO_TLSv1_1", 268435456},
    {"SSL_OP_NO_TLSv1_2", 134217728},
    {"SSL_OP_NO_TLSv1_3", 536870912},
    {"SSL_OP_PRIORITIZE_CHACHA", 2097152},
    {"SSL_OP_TLS_ROLLBACK_BUG", 8388608},
    {"ENGINE_METHOD_RSA", 1},
    {"ENGINE_METHOD_DSA", 2},
    {"ENGINE_METHOD_DH", 4},
    {"ENGINE_METHOD_RAND", 8},
    {"ENGINE_METHOD_EC", 2048},
    {"ENGINE_METHOD_CIPHERS", 64},
    {"ENGINE_METHOD_DIGESTS", 128},
    {"ENGINE_METHOD_PKEY_METHS", 512},
    {"ENGINE_METHOD_PKEY_ASN1_METHS", 1024},
    {"ENGINE_METHOD_ALL", 65535},
    {"ENGINE_METHOD_NONE", 0},
    {"DH_CHECK_P_NOT_SAFE_PRIME", 2},
    {"DH_CHECK_P_NOT_PRIME", 1},
    {"DH_UNABLE_TO_CHECK_GENERATOR", 4},
    {"DH_NOT_SUITABLE_GENERATOR", 8},
    {"RSA_PKCS1_PADDING", 1},
    {"RSA_SSLV23_PADDING", 2},
    {"RSA_NO_PADDING", 3},
    {"RSA_PKCS1_OAEP_PADDING", 4},
    {"RSA_X931_PADDING", 5},
    {"RSA_PKCS1_PSS_PADDING", 6},
    {"RSA_PSS_SALTLEN_DIGEST", -1},
    {"RSA_PSS_SALTLEN_MAX_SIGN", -2},
    {"RSA_PSS_SALTLEN_AUTO", -2},
    {"TLS1_VERSION", 769},
    {"TLS1_1_VERSION", 770},
    {"TLS1_2_VERSION", 771},
    {"TLS1_3_VERSION", 772},
    {"POINT_CONVERSION_COMPRESSED", 2},
    {"POINT_CONVERSION_UNCOMPRESSED", 4},
    {"POINT_CONVERSION_HYBRID", 6},
};
static const char CRYPTO_DEFAULT_CIPHER_LIST[] = "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA";
/* Insertion order matches Node so Object.keys(constants) agrees. */
static const char *const CRYPTO_CONSTANT_ORDER[] = {"OPENSSL_VERSION_NUMBER", "SSL_OP_ALL", "SSL_OP_ALLOW_NO_DHE_KEX", "SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION", "SSL_OP_CIPHER_SERVER_PREFERENCE", "SSL_OP_CISCO_ANYCONNECT", "SSL_OP_COOKIE_EXCHANGE", "SSL_OP_CRYPTOPRO_TLSEXT_BUG", "SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS", "SSL_OP_LEGACY_SERVER_CONNECT", "SSL_OP_NO_COMPRESSION", "SSL_OP_NO_ENCRYPT_THEN_MAC", "SSL_OP_NO_QUERY_MTU", "SSL_OP_NO_RENEGOTIATION", "SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION", "SSL_OP_NO_SSLv2", "SSL_OP_NO_SSLv3", "SSL_OP_NO_TICKET", "SSL_OP_NO_TLSv1", "SSL_OP_NO_TLSv1_1", "SSL_OP_NO_TLSv1_2", "SSL_OP_NO_TLSv1_3", "SSL_OP_PRIORITIZE_CHACHA", "SSL_OP_TLS_ROLLBACK_BUG", "ENGINE_METHOD_RSA", "ENGINE_METHOD_DSA", "ENGINE_METHOD_DH", "ENGINE_METHOD_RAND", "ENGINE_METHOD_EC", "ENGINE_METHOD_CIPHERS", "ENGINE_METHOD_DIGESTS", "ENGINE_METHOD_PKEY_METHS", "ENGINE_METHOD_PKEY_ASN1_METHS", "ENGINE_METHOD_ALL", "ENGINE_METHOD_NONE", "DH_CHECK_P_NOT_SAFE_PRIME", "DH_CHECK_P_NOT_PRIME", "DH_UNABLE_TO_CHECK_GENERATOR", "DH_NOT_SUITABLE_GENERATOR", "RSA_PKCS1_PADDING", "RSA_SSLV23_PADDING", "RSA_NO_PADDING", "RSA_PKCS1_OAEP_PADDING", "RSA_X931_PADDING", "RSA_PKCS1_PSS_PADDING", "RSA_PSS_SALTLEN_DIGEST", "RSA_PSS_SALTLEN_MAX_SIGN", "RSA_PSS_SALTLEN_AUTO", "defaultCoreCipherList", "TLS1_VERSION", "TLS1_1_VERSION", "TLS1_2_VERSION", "TLS1_3_VERSION", "POINT_CONVERSION_COMPRESSED", "POINT_CONVERSION_UNCOMPRESSED", "POINT_CONVERSION_HYBRID", "defaultCipherList"};

static MalValue crypto_constants_object(MalVm *vm) {
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalPropertyFlags flags = MAL_PROPERTY_ENUMERABLE;
    for (usize i = 0; i < countof(CRYPTO_CONSTANT_ORDER); i++) {
        const char *name = CRYPTO_CONSTANT_ORDER[i];
        roots[1] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) CRYPTO_DEFAULT_CIPHER_LIST));
        for (usize j = 0; j < countof(CRYPTO_NUMERIC_CONSTANTS); j++) {
            if (strcmp(CRYPTO_NUMERIC_CONSTANTS[j].name, name) == 0) {
                roots[1] = mal_ops_number_value(CRYPTO_NUMERIC_CONSTANTS[j].value);
                break;
            }
        }
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) name, roots[1], flags);
    }
    mal_gc_unroot(&root);
    return roots[0];
}


static MalValue crypto_new_secret_key(MalVm *vm, byte *bytes, usize length) {
    MalValue roots[] = {mal_value_from_object(mal_object_new(&vm->heap,
        mal_value_to_object(crypto_secret_key_prototype))), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_array_buffer_object(mal_array_buffer_object_adopt(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]), bytes, (u32) length, true));
    mal_object_set(mal_value_to_object(roots[0]),
        (MalKey) {.kind = MAL_KEY_SYMBOL, .value = crypto_key_symbol}, roots[1]);
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue mal_node_crypto_create_secret_key(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue key = argc > 0 ? args[0] : mal_value_new_undefined();
    byte *bytes = nullptr;
    usize length = 0;
    if (mal_value_is_string(key)) {
        bytes = mal_node_buffer_decode_string(vm, key, argc > 1 ? args[1] : mal_value_new_undefined(), &length);
        if (bytes == nullptr) { mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
    } else if (crypto_is_byte_source(key)) {
        MalBufferSourceSpan span;
        byte *owned = nullptr;
        if (!crypto_byte_source_span(vm, key, "key", &span, &owned)) return mal_value_new_undefined();
        length = span.length;
        bytes = owned;
        if (bytes == nullptr) {
            bytes = malloc(length > 0 ? length : 1);
            if (bytes == nullptr) { mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
            if (length > 0) memcpy(bytes, span.data, length);
        }
    } else {
        crypto_throw_arg_type(vm, "key",
            "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView", key);
        return mal_value_new_undefined();
    }
    return crypto_new_secret_key(vm, bytes, length);
}

static bool crypto_receiver_key(MalVm *vm, MalValue receiver, const byte **data, usize *length) {
    if (crypto_secret_key_bytes(receiver, data, length)) return true;
    crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Illegal invocation");
    return false;
}

static bool crypto_pkey_der(MalValue value, const byte **data, usize *length);

static bool crypto_is_private_pkey(MalValue value) {
    return mal_object_prototype(mal_value_to_object(value)) == mal_value_to_object(crypto_private_key_prototype);
}

static MalValue mal_node_crypto_key_type(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    const byte *data;
    usize length;
    if (crypto_pkey_der(receiver, &data, &length)) {
        return mal_value_from_string(mal_intrinsic_ascii(vm,
            (const byte *) (crypto_is_private_pkey(receiver) ? "private" : "public")));
    }
    if (!crypto_receiver_key(vm, receiver, &data, &length)) return mal_value_new_undefined();
    return mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "secret"));
}

static MalValue mal_node_crypto_key_size(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    const byte *data;
    usize length;
    if (!crypto_receiver_key(vm, receiver, &data, &length)) return mal_value_new_undefined();
    return mal_ops_number_value((f64) length);
}

static MalValue mal_node_crypto_key_export(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    const byte *data;
    usize length;
    if (!crypto_receiver_key(vm, receiver, &data, &length)) return mal_value_new_undefined();
    MalValue options = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue format = mal_value_new_undefined();
    if (mal_value_is_object(options) && !mal_vm_get_property(vm, options, mal_key_from_value(
            mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "format"))), &format)) {
        return mal_value_new_undefined();
    }
    if (mal_value_is_string(format) && mal_string_equals_ascii(mal_value_to_string(format), "jwk")) {
        MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined()};
        MalRootSpan root;
        mal_gc_root(&root, roots, countof(roots));
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "kty",
            mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "oct")),
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
        roots[1] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "base64url"));
        if (!crypto_secret_key_bytes(receiver, &data, &length)) { mal_gc_unroot(&root); return mal_value_new_undefined(); }
        roots[1] = mal_node_buffer_encode_bytes(vm, data, length, roots[1], false);
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "k", roots[1],
                MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
        }
        mal_gc_unroot(&root);
        return roots[0];
    }
    if (!mal_value_is_undefined(format) && !(mal_value_is_string(format)
            && mal_string_equals_ascii(mal_value_to_string(format), "buffer"))) {
        crypto_throw_property_type(vm, "options.format", "one of: 'buffer', 'jwk'", format);
        return mal_value_new_undefined();
    }
    byte *copy = malloc(length > 0 ? length : 1);
    if (copy == nullptr) { mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
    if (length > 0) memcpy(copy, data, length);
    return mal_node_buffer_from_owned_secret_bytes(vm, copy, length);
}

static MalValue mal_node_crypto_key_equals(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    const byte *data;
    usize length;
    const byte *other;
    usize other_length;
    if (crypto_pkey_der(receiver, &data, &length)) {
        if (argc < 1 || (!crypto_pkey_der(args[0], &other, &other_length)
                && !crypto_secret_key_bytes(args[0], &other, &other_length))) {
            crypto_throw_arg_type(vm, "otherKeyObject", "an instance of KeyObject",
                argc > 0 ? args[0] : mal_value_new_undefined());
            return mal_value_new_undefined();
        }
        // Canonical DER makes byte equality key equality.
        return mal_value_new_boolean(crypto_pkey_der(args[0], &other, &other_length)
            && crypto_is_private_pkey(receiver) == crypto_is_private_pkey(args[0]) && length == other_length
            && memcmp(data, other, length) == 0);
    }
    if (!crypto_receiver_key(vm, receiver, &data, &length)) return mal_value_new_undefined();
    if (argc < 1 || !crypto_secret_key_bytes(args[0], &other, &other_length)) {
        crypto_throw_arg_type(vm, "otherKeyObject", "an instance of KeyObject",
            argc > 0 ? args[0] : mal_value_new_undefined());
        return mal_value_new_undefined();
    }
    u8 difference = (u8) (length != other_length);
    for (usize i = 0; i < length && i < other_length; i++) difference |= (u8) (data[i] ^ other[i]);
    return mal_value_new_boolean(difference == 0);
}

static MalValue mal_node_crypto_key_object_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue type = argc > 0 ? args[0] : mal_value_new_undefined();
    char received[CRYPTO_MESSAGE_CAPACITY / 2];
    crypto_received(vm, type, received, sizeof(received));
    char message[CRYPTO_MESSAGE_CAPACITY];
    snprintf(message, sizeof(message), "The argument 'type' is invalid. Received %s", received);
    // Only createSecretKey mints keys: Node's constructor needs an internal handle.
    mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_VALUE");
    return mal_value_new_undefined();
}

static void crypto_define_getter(MalVm *vm, MalObject *object, const char *name, MalNativeFunctionCallback getter) {
    char getter_name[64];
    snprintf(getter_name, sizeof(getter_name), "get %s", name);
    mal_intrinsic_define_accessor_n(vm, object, mal_intrinsic_string_key(vm, (const byte *) name),
        (const byte *) getter_name, 0, getter, nullptr, 0, nullptr, MAL_PROPERTY_CONFIGURABLE);
}

/* KeyObject and its secret subclass; prototypes stay rooted through crypto_scan_roots. */
static void crypto_install_key_objects(MalVm *vm, MalObject *module) {
    MalValue roots[] = {mal_value_from_symbol(mal_symbol_new_private(&vm->heap)), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalPropertyFlags hidden = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE;
    roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "KeyObject"), 2, mal_node_crypto_key_object_constructor);
    mal_native_function_object_set_constructor(constructor);
    roots[2] = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype", roots[1], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), (const byte *) "constructor", roots[2], hidden);
    MalObject *key_prototype = mal_value_to_object(roots[1]);
    crypto_define_getter(vm, key_prototype, "type", mal_node_crypto_key_type);
    mal_intrinsic_define_method_n(vm, key_prototype, (const byte *) "equals", 1, mal_node_crypto_key_equals);
    MalValue tag_key = vm->intrinsics[MAL_INTRINSIC_SYMBOL_TO_STRING_TAG];
    if (mal_value_is_symbol(tag_key)) {
        MalPropertyDesc tag = {
            .value = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "KeyObject")),
            .flags = MAL_PROPERTY_CONFIGURABLE};
        mal_object_define_own(key_prototype, mal_key_from_value(tag_key), &tag);
    }
    roots[3] = mal_value_from_object(mal_object_new(&vm->heap, key_prototype));
    MalNativeFunctionObject *secret = mal_native_function_object_new_arity(&vm->heap,
        mal_value_to_object(roots[2]), mal_intrinsic_ascii(vm, (const byte *) "SecretKeyObject"), 1,
        mal_node_crypto_key_object_constructor);
    mal_native_function_object_set_constructor(secret);
    roots[4] = mal_value_from_native_function_object(secret);
    mal_intrinsic_define_data(vm, (MalObject *) secret, (const byte *) "prototype", roots[3], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[3]), (const byte *) "constructor", roots[4], hidden);
    MalObject *secret_prototype = mal_value_to_object(roots[3]);
    crypto_define_getter(vm, secret_prototype, "symmetricKeySize", mal_node_crypto_key_size);
    mal_intrinsic_define_method_n(vm, secret_prototype, (const byte *) "export", 1, mal_node_crypto_key_export);
    crypto_key_symbol = roots[0];
    crypto_key_object_constructor = roots[2];
    crypto_secret_key_prototype = roots[3];
    crypto_crypto_key_symbol = mal_value_new_undefined();
    crypto_crypto_key_prototype = mal_value_new_undefined();
    crypto_cipher_symbol = mal_value_new_undefined();
    crypto_cipheriv_prototype = mal_value_new_undefined();
    crypto_decipheriv_prototype = mal_value_new_undefined();
    crypto_pkey_symbol = mal_value_new_undefined();
    crypto_signer_meta_symbol = mal_value_new_undefined();
    crypto_asymmetric_key_prototype = mal_value_new_undefined();
    crypto_public_key_prototype = mal_value_new_undefined();
    crypto_private_key_prototype = mal_value_new_undefined();
    crypto_sign_prototype = mal_value_new_undefined();
    crypto_verify_prototype = mal_value_new_undefined();
    crypto_keys_ready = true;
    mal_intrinsic_define_data(vm, module, (const byte *) "KeyObject", roots[2],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&root);
}


static void crypto_settle_with_completion(MalVm *vm, MalValue promise) {
    MalValue error = vm->completion.value;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, &error, 1);
    mal_promise_reject(vm, mal_value_to_promise_object(promise), error);
    mal_gc_unroot(&root);
}

/* WebCrypto digest: computed on the calling thread, delivered through a promise. */
static MalValue mal_node_crypto_subtle_digest(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue roots[] = {mal_value_from_promise_object(mal_promise_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]))),
        argc > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_object(roots[1]) && !mal_vm_get_property(vm, roots[1], mal_key_from_value(
            mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "name"))), &roots[1])) {
        crypto_settle_with_completion(vm, roots[0]);
        goto done;
    }
    MalNodeCryptoStateKind kind = MAL_NODE_CRYPTO_MD5;
    static const struct { const char *name; MalNodeCryptoStateKind kind; } names[] = {
        {"SHA-1", MAL_NODE_CRYPTO_SHA1}, {"SHA-256", MAL_NODE_CRYPTO_SHA256},
        {"SHA-384", MAL_NODE_CRYPTO_SHA384}, {"SHA-512", MAL_NODE_CRYPTO_SHA512}};
    for (usize i = 0; mal_value_is_string(roots[1]) && i < countof(names); i++) {
        if (mal_string_equals_ascii_ci(mal_value_to_string(roots[1]), names[i].name)) kind = names[i].kind;
    }
    if (kind == MAL_NODE_CRYPTO_MD5) {
        mal_dom_exception_throw(vm, (const byte *) "Unrecognized algorithm name", (const byte *) "NotSupportedError");
        crypto_settle_with_completion(vm, roots[0]);
        goto done;
    }
    MalValue data = argc > 1 ? args[1] : mal_value_new_undefined();
    MalBufferSourceSpan span;
    if (!crypto_is_byte_source(data) || mal_buffer_source_span(data, &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Failed to execute 'digest' on 'SubtleCrypto': 2nd argument is not instance of ArrayBuffer, Buffer, TypedArray, or DataView.",
            "ERR_INVALID_ARG_TYPE");
        crypto_settle_with_completion(vm, roots[0]);
        goto done;
    }
    MalNodeCryptoState state;
    crypto_digest_start(&state, kind);
    if (span.length > 0) mal_node_crypto_state_update(&state, (const u8 *) span.data, span.length);
    usize length = crypto_digest_size(kind);
    byte *out = malloc(length);
    if (out == nullptr) {
        mal_vm_throw_allocation_error(vm);
        crypto_settle_with_completion(vm, roots[0]);
        goto done;
    }
    crypto_digest_finish(&state, (u8 *) out);
    roots[2] = mal_value_from_array_buffer_object(mal_array_buffer_object_adopt(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]), out, (u32) length, false));
    mal_promise_fulfill(vm, mal_value_to_promise_object(roots[0]), roots[2]);
done:
    mal_gc_unroot(&root);
    return roots[0];
}



static MalValue crypto_get(MalVm *vm, MalValue object, const char *name, bool *ok) {
    MalValue value = mal_value_new_undefined();
    *ok = !mal_value_is_object(object) || mal_vm_get_property(vm, object, mal_key_from_value(
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) name))), &value);
    return value;
}

static void crypto_set(MalVm *vm, MalValue object, const char *name, MalValue value) {
    mal_intrinsic_define_data(vm, mal_value_to_object(object), (const byte *) name, value,
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
}

/* The WebCrypto hash names, matched case-insensitively. */
static bool crypto_web_hash(MalValue name, MalNodeCryptoStateKind *kind) {
    static const struct { const char *name; MalNodeCryptoStateKind kind; } names[] = {
        {"SHA-1", MAL_NODE_CRYPTO_SHA1}, {"SHA-256", MAL_NODE_CRYPTO_SHA256},
        {"SHA-384", MAL_NODE_CRYPTO_SHA384}, {"SHA-512", MAL_NODE_CRYPTO_SHA512}};
    for (usize i = 0; mal_value_is_string(name) && i < countof(names); i++) {
        if (mal_string_equals_ascii_ci(mal_value_to_string(name), names[i].name)) {
            *kind = names[i].kind;
            return true;
        }
    }
    return false;
}

static const char *crypto_web_hash_name(MalNodeCryptoStateKind kind) {
    switch (kind) {
        case MAL_NODE_CRYPTO_SHA1: return "SHA-1";
        case MAL_NODE_CRYPTO_SHA384: return "SHA-384";
        case MAL_NODE_CRYPTO_SHA512: return "SHA-512";
        default: return "SHA-256";
    }
}

/* `algorithm` as a string or `{name}`; true when it names HMAC. */
static bool crypto_web_is_hmac(MalVm *vm, MalValue algorithm, bool *ok) {
    MalValue name = mal_value_is_object(algorithm) ? crypto_get(vm, algorithm, "name", ok) : algorithm;
    if (!mal_value_is_object(algorithm)) *ok = true;
    return *ok && mal_value_is_string(name) && mal_string_equals_ascii_ci(mal_value_to_string(name), "HMAC");
}

static MalValue crypto_web_reject_dom(MalVm *vm, MalValue promise, const char *message, const char *name) {
    mal_dom_exception_throw(vm, (const byte *) message, (const byte *) name);
    crypto_settle_with_completion(vm, promise);
    return promise;
}

static MalValue crypto_new_promise(MalVm *vm) {
    return mal_value_from_promise_object(mal_promise_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
}


/* Byte 0 of a stored CryptoKey: an HMAC hash kind, or this marker for AES-GCM. */
#define CRYPTO_WEB_AES_GCM 0x80

static bool crypto_web_is_aes_gcm(MalVm *vm, MalValue algorithm, bool *ok) {
    MalValue name = mal_value_is_object(algorithm) ? crypto_get(vm, algorithm, "name", ok) : algorithm;
    if (!mal_value_is_object(algorithm)) *ok = true;
    return *ok && mal_value_is_string(name) && mal_string_equals_ascii_ci(mal_value_to_string(name), "AES-GCM");
}

static MalValue crypto_web_new_key(MalVm *vm, byte *stored, usize stored_length, MalValue algorithm,
    bool extractable, MalValue usages) {
    MalValue roots[] = {mal_value_from_object(mal_object_new(&vm->heap, mal_value_to_object(crypto_crypto_key_prototype))),
        algorithm, usages, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[3] = mal_value_from_array_buffer_object(mal_array_buffer_object_adopt(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]), stored, (u32) stored_length, true));
    mal_object_set(mal_value_to_object(roots[0]), (MalKey) {.kind = MAL_KEY_SYMBOL, .value = crypto_crypto_key_symbol}, roots[3]);
    crypto_set(vm, roots[0], "type", mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "secret")));
    crypto_set(vm, roots[0], "extractable", mal_value_new_boolean(extractable));
    crypto_set(vm, roots[0], "algorithm", roots[1]);
    crypto_set(vm, roots[0], "usages", mal_value_is_array_object(roots[2]) ? roots[2]
        : mal_value_from_array_object(mal_array_object_new_from_values(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), nullptr, 0)));
    mal_gc_unroot(&root);
    return roots[0];
}

static void crypto_web_import_aes(MalVm *vm, MalValue promise, const MalValue *args, i32 argc) {
    MalValue format = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_string(format) || !mal_string_equals_ascii(mal_value_to_string(format), "raw")) {
        crypto_web_reject_dom(vm, promise, "Unable to import AES-GCM key with format", "NotSupportedError");
        return;
    }
    MalValue data = argc > 1 ? args[1] : mal_value_new_undefined();
    MalBufferSourceSpan span;
    if (!crypto_is_byte_source(data) || mal_buffer_source_span(data, &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Failed to execute 'importKey' on 'SubtleCrypto': 2nd argument is not instance of ArrayBuffer, Buffer, TypedArray, or DataView.",
            "ERR_INVALID_ARG_TYPE");
        crypto_settle_with_completion(vm, promise);
        return;
    }
    if (span.length != 16 && span.length != 24 && span.length != 32) {
        crypto_web_reject_dom(vm, promise, "Invalid key length", "DataError");
        return;
    }
    byte *stored = malloc(span.length + 1);
    if (stored == nullptr) { mal_vm_throw_allocation_error(vm); crypto_settle_with_completion(vm, promise); return; }
    stored[0] = (byte) CRYPTO_WEB_AES_GCM;
    memcpy(stored + 1, span.data, span.length);
    usize key_length = span.length;
    MalValue algorithm = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &algorithm, 1);
    crypto_set(vm, algorithm, "name", mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "AES-GCM")));
    crypto_set(vm, algorithm, "length", mal_ops_number_value((f64) key_length * 8));
    MalValue key = crypto_web_new_key(vm, stored, key_length + 1, algorithm, argc > 3 && mal_value_is_truthy(args[3]),
        argc > 4 ? args[4] : mal_value_new_undefined());
    mal_gc_unroot(&root);
    mal_promise_fulfill(vm, mal_value_to_promise_object(promise), key);
}

/* An optional BufferSource dictionary member, resolved after every getter has run. */
static bool crypto_web_bytes_member(MalVm *vm, MalValue value, const char *name, MalBufferSourceSpan *span,
    bool *present) {
    *present = false;
    if (mal_value_is_undefined(value)) return true;
    if (!crypto_is_byte_source(value) || mal_buffer_source_span(value, span) != MAL_BUFFER_SOURCE_SPAN_OK) {
        char message[128];
        snprintf(message, sizeof(message), "The \"algorithm.%s\" property must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.", name);
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_TYPE");
        return false;
    }
    *present = true;
    return true;
}

static MalValue crypto_web_aes_gcm(MalVm *vm, const MalValue *args, i32 argc, bool encrypt) {
    MalValue roots[] = {crypto_new_promise(vm), argc > 0 ? args[0] : mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    byte *storage = nullptr;
    usize storage_size = mal_cipher_state_size();
    u8 *out = nullptr;
    bool ok = true;
    if (!crypto_web_is_aes_gcm(vm, roots[1], &ok)) {
        if (!ok) crypto_settle_with_completion(vm, roots[0]);
        else crypto_web_reject_dom(vm, roots[0], "Unrecognized algorithm name", "NotSupportedError");
        goto done;
    }
    MalValue key = argc > 1 ? args[1] : mal_value_new_undefined();
    MalPropertyLookup lookup = {0};
    if (mal_value_is_object(key)) {
        lookup = mal_object_get_own(mal_value_to_object(key),
            (MalKey) {.kind = MAL_KEY_SYMBOL, .value = crypto_crypto_key_symbol});
    }
    if (!lookup.present || !mal_value_is_array_buffer_object(lookup.desc.value)) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The \"key\" argument must be an instance of CryptoKey.", "ERR_INVALID_ARG_TYPE");
        crypto_settle_with_completion(vm, roots[0]);
        goto done;
    }
    MalArrayBufferObject *stored = mal_value_to_array_buffer_object(lookup.desc.value);
    if ((u8) stored->data[0] != CRYPTO_WEB_AES_GCM) {
        crypto_web_reject_dom(vm, roots[0], "Key algorithm mismatch", "InvalidAccessError");
        goto done;
    }
    MalValue tag_value = crypto_get(vm, roots[1], "tagLength", &ok);
    if (!ok) { crypto_settle_with_completion(vm, roots[0]); goto done; }
    f64 tag_bits = mal_ops_is_number(tag_value) ? mal_ops_number_as_f64(tag_value) : 128;
    if (!(tag_bits == 32 || tag_bits == 64 || tag_bits == 96 || tag_bits == 104 || tag_bits == 112
            || tag_bits == 120 || tag_bits == 128)) {
        char text[64];
        crypto_number_text(vm, tag_value, text, sizeof(text));
        char message[96];
        snprintf(message, sizeof(message), "%s is not a valid AES-GCM tag length", text);
        crypto_web_reject_dom(vm, roots[0], message, "OperationError");
        goto done;
    }
    usize tag_length = (usize) tag_bits / 8;
    MalBufferSourceSpan iv, aad, data;
    bool has_iv, has_aad;
    roots[3] = crypto_get(vm, roots[1], "iv", &ok);
    if (ok) roots[4] = crypto_get(vm, roots[1], "additionalData", &ok);
    if (!ok || !crypto_web_bytes_member(vm, roots[3], "iv", &iv, &has_iv)
        || !crypto_web_bytes_member(vm, roots[4], "additionalData", &aad, &has_aad)) {
        crypto_settle_with_completion(vm, roots[0]);
        goto done;
    }
    roots[2] = argc > 2 ? args[2] : mal_value_new_undefined();
    if (!crypto_is_byte_source(roots[2]) || mal_buffer_source_span(roots[2], &data) != MAL_BUFFER_SOURCE_SPAN_OK) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The \"data\" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.",
            "ERR_INVALID_ARG_TYPE");
        crypto_settle_with_completion(vm, roots[0]);
        goto done;
    }
    if (!has_iv || (!encrypt && data.length < tag_length)) {
        crypto_web_reject_dom(vm, roots[0], "The operation failed for an operation-specific reason", "OperationError");
        goto done;
    }
    // All member getters have run, so the borrowed spans stay valid through the cipher calls.
    usize key_length = stored->byte_length - 1;
    u32 kind = key_length == 16 ? 7 : key_length == 24 ? 8 : 9;
    usize body = encrypt ? data.length : data.length - tag_length;
    storage = crypto_cipher_storage(storage_size);
    // The result ArrayBuffer has a u32 length; a longer output would silently lose its tag.
    out = body <= UINT32_MAX - 32 ? malloc(body + 32) : nullptr;
    if (storage == nullptr || out == nullptr) {
        mal_vm_throw_allocation_error(vm);
        crypto_settle_with_completion(vm, roots[0]);
        goto done;
    }
    MalCipher *cipher = (MalCipher *) storage;
    usize written = 0, tail = 0;
    i32 status = mal_cipher_init((u8 *) storage, storage_size, kind, encrypt, (const u8 *) stored->data + 1,
        key_length, (const u8 *) iv.data, iv.length);
    if (status == MAL_CIPHER_OK && has_aad) status = mal_cipher_set_aad(cipher, (const u8 *) aad.data, aad.length);
    if (status == MAL_CIPHER_OK && !encrypt) {
        status = mal_cipher_set_tag(cipher, (const u8 *) data.data + body, tag_length);
    }
    if (status == MAL_CIPHER_OK) status = mal_cipher_update(cipher, (const u8 *) data.data, body, out, body + 32, &written);
    if (status == MAL_CIPHER_OK) status = mal_cipher_final(cipher, out + written, 16, &tail);
    if (status == MAL_CIPHER_OK && encrypt) {
        status = mal_cipher_get_tag(cipher, out + written + tail, tag_length);
        tail += tag_length;
    }
    if (status != MAL_CIPHER_OK) {
        crypto_web_reject_dom(vm, roots[0], "The operation failed for an operation-specific reason", "OperationError");
        goto done;
    }
    roots[2] = mal_value_from_array_buffer_object(mal_array_buffer_object_adopt(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]), (byte *) out, (u32) (written + tail),
        false));
    out = nullptr;
    mal_promise_fulfill(vm, mal_value_to_promise_object(roots[0]), roots[2]);
done:
    if (storage != nullptr) crypto_scrub_free(storage, storage_size);
    free(out);
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue mal_node_crypto_subtle_encrypt(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    return crypto_web_aes_gcm(vm, args, argc, true);
}

static MalValue mal_node_crypto_subtle_decrypt(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    return crypto_web_aes_gcm(vm, args, argc, false);
}

typedef enum { CRYPTO_WEB_NONE, CRYPTO_WEB_RSASSA, CRYPTO_WEB_RSA_PSS, CRYPTO_WEB_ECDSA, CRYPTO_WEB_ED25519 } CryptoWebAsym;

static CryptoWebAsym crypto_web_asym(MalVm *vm, MalValue algorithm, bool *ok);
static void crypto_web_import_asym(MalVm *vm, MalValue promise, CryptoWebAsym algorithm, const MalValue *args,
    i32 argc);
static void crypto_web_sign_asym(MalVm *vm, MalValue promise, CryptoWebAsym algorithm, MalValue parameters,
    MalValue key_value, MalValue data, MalValue signature);
static bool crypto_web_is_asym_key(MalValue key);

static MalValue mal_node_crypto_subtle_import_key(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue undefined = mal_value_new_undefined();
    MalValue roots[] = {crypto_new_promise(vm), argc > 2 ? args[2] : undefined, undefined, undefined, undefined};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool ok = true;
    MalValue format = argc > 0 ? args[0] : undefined;
    MalNodeCryptoStateKind hash = MAL_NODE_CRYPTO_SHA256;
    CryptoWebAsym asymmetric = crypto_web_asym(vm, roots[1], &ok);
    if (asymmetric != CRYPTO_WEB_NONE) {
        crypto_web_import_asym(vm, roots[0], asymmetric, args, argc);
        goto done;
    }
    if (crypto_web_is_aes_gcm(vm, roots[1], &ok)) {
        crypto_web_import_aes(vm, roots[0], args, argc);
        goto done;
    }
    if (!ok) { crypto_settle_with_completion(vm, roots[0]); goto done; }
    if (!crypto_web_is_hmac(vm, roots[1], &ok)) {
        if (!ok) crypto_settle_with_completion(vm, roots[0]);
        else crypto_web_reject_dom(vm, roots[0], "Unrecognized algorithm name", "NotSupportedError");
        goto done;
    }
    roots[2] = crypto_get(vm, roots[1], "hash", &ok);
    if (ok && mal_value_is_object(roots[2])) roots[2] = crypto_get(vm, roots[2], "name", &ok);
    if (!ok) { crypto_settle_with_completion(vm, roots[0]); goto done; }
    if (!crypto_web_hash(roots[2], &hash)) {
        crypto_web_reject_dom(vm, roots[0], "Unrecognized algorithm name", "NotSupportedError");
        goto done;
    }
    if (!mal_value_is_string(format) || !mal_string_equals_ascii(mal_value_to_string(format), "raw")) {
        crypto_web_reject_dom(vm, roots[0], "Unable to import HMAC key with format", "NotSupportedError");
        goto done;
    }
    MalValue data = argc > 1 ? args[1] : undefined;
    MalBufferSourceSpan span;
    if (!crypto_is_byte_source(data) || mal_buffer_source_span(data, &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Failed to execute 'importKey' on 'SubtleCrypto': 2nd argument is not instance of ArrayBuffer, Buffer, TypedArray, or DataView.",
            "ERR_INVALID_ARG_TYPE");
        crypto_settle_with_completion(vm, roots[0]);
        goto done;
    }
    if (span.length == 0) {
        crypto_web_reject_dom(vm, roots[0], "Zero-length key is not supported", "DataError");
        goto done;
    }
    // Byte 0 records the hash so sign/verify need no second lookup.
    byte *stored = malloc(span.length + 1);
    if (stored == nullptr) { mal_vm_throw_allocation_error(vm); crypto_settle_with_completion(vm, roots[0]); goto done; }
    stored[0] = (byte) hash;
    memcpy(stored + 1, span.data, span.length);
    usize key_length = span.length;
    roots[3] = mal_value_from_object(mal_object_new(&vm->heap, mal_value_to_object(crypto_crypto_key_prototype)));
    roots[4] = mal_value_from_array_buffer_object(mal_array_buffer_object_adopt(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]), stored, (u32) (key_length + 1), true));
    mal_object_set(mal_value_to_object(roots[3]), (MalKey) {.kind = MAL_KEY_SYMBOL, .value = crypto_crypto_key_symbol}, roots[4]);
    crypto_set(vm, roots[3], "type", mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "secret")));
    crypto_set(vm, roots[3], "extractable", mal_value_new_boolean(argc > 3 && mal_value_is_truthy(args[3])));
    roots[4] = mal_value_from_object(mal_intrinsic_new_object(vm));
    crypto_set(vm, roots[4], "name", mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "HMAC")));
    crypto_set(vm, roots[4], "length", mal_ops_number_value((f64) key_length * 8));
    roots[2] = mal_value_from_object(mal_intrinsic_new_object(vm));
    crypto_set(vm, roots[2], "name", mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) crypto_web_hash_name(hash))));
    crypto_set(vm, roots[4], "hash", roots[2]);
    crypto_set(vm, roots[3], "algorithm", roots[4]);
    crypto_set(vm, roots[3], "usages", argc > 4 && mal_value_is_array_object(args[4]) ? args[4]
        : mal_value_from_array_object(mal_array_object_new_from_values(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), nullptr, 0)));
    mal_promise_fulfill(vm, mal_value_to_promise_object(roots[0]), roots[3]);
done:
    mal_gc_unroot(&root);
    return roots[0];
}

/* HMAC tag for sign/verify, or false with the promise already rejected. */
static bool crypto_web_hmac(MalVm *vm, MalValue promise, const MalValue *args, i32 argc, i32 data_index,
    u8 tag[64], usize *tag_length) {
    bool ok = true;
    if (!crypto_web_is_hmac(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &ok)) {
        if (!ok) crypto_settle_with_completion(vm, promise);
        else crypto_web_reject_dom(vm, promise, "Unrecognized algorithm name", "NotSupportedError");
        return false;
    }
    MalValue key = argc > 1 ? args[1] : mal_value_new_undefined();
    MalPropertyLookup lookup = {0};
    if (mal_value_is_object(key)) {
        lookup = mal_object_get_own(mal_value_to_object(key),
            (MalKey) {.kind = MAL_KEY_SYMBOL, .value = crypto_crypto_key_symbol});
    }
    if (!lookup.present || !mal_value_is_array_buffer_object(lookup.desc.value)) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The \"key\" argument must be an instance of CryptoKey.", "ERR_INVALID_ARG_TYPE");
        crypto_settle_with_completion(vm, promise);
        return false;
    }
    MalValue data = argc > data_index ? args[data_index] : mal_value_new_undefined();
    MalBufferSourceSpan span;
    if (!crypto_is_byte_source(data) || mal_buffer_source_span(data, &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The \"data\" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.",
            "ERR_INVALID_ARG_TYPE");
        crypto_settle_with_completion(vm, promise);
        return false;
    }
    MalArrayBufferObject *stored = mal_value_to_array_buffer_object(lookup.desc.value);
    if ((u8) stored->data[0] == CRYPTO_WEB_AES_GCM) {
        crypto_web_reject_dom(vm, promise, "Key algorithm mismatch", "InvalidAccessError");
        return false;
    }
    MalNodeCryptoStateKind kind = (MalNodeCryptoStateKind) (u8) stored->data[0];
    CryptoHmac hmac;
    crypto_hmac_init(&hmac, kind, (const u8 *) stored->data + 1, stored->byte_length - 1);
    crypto_hmac(&hmac, (const u8 *) span.data, span.length, nullptr, 0, nullptr, 0, tag);
    *tag_length = crypto_digest_size(hmac.kind);
    mal_secure_scrub((byte *) &hmac, sizeof(hmac));
    return true;
}

static MalValue mal_node_crypto_subtle_sign(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue roots[] = {crypto_new_promise(vm), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool ok = true;
    CryptoWebAsym asymmetric = crypto_web_asym(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &ok);
    if (asymmetric != CRYPTO_WEB_NONE && argc > 1 && crypto_web_is_asym_key(args[1])) {
        crypto_web_sign_asym(vm, roots[0], asymmetric, args[0], args[1], argc > 2 ? args[2] : mal_value_new_undefined(),
            mal_value_new_undefined());
        mal_gc_unroot(&root);
        return roots[0];
    }
    u8 tag[64];
    usize length = 0;
    if (crypto_web_hmac(vm, roots[0], args, argc, 2, tag, &length)) {
        byte *out = malloc(length);
        if (out == nullptr) {
            mal_vm_throw_allocation_error(vm);
            crypto_settle_with_completion(vm, roots[0]);
        } else {
            memcpy(out, tag, length);
            roots[1] = mal_value_from_array_buffer_object(mal_array_buffer_object_adopt(&vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]), out, (u32) length, false));
            mal_promise_fulfill(vm, mal_value_to_promise_object(roots[0]), roots[1]);
        }
    }
    mal_secure_scrub((byte *) tag, sizeof(tag));
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue mal_node_crypto_subtle_verify(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue roots[] = {crypto_new_promise(vm)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool ok = true;
    CryptoWebAsym asymmetric = crypto_web_asym(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &ok);
    if (asymmetric != CRYPTO_WEB_NONE && argc > 1 && crypto_web_is_asym_key(args[1])) {
        crypto_web_sign_asym(vm, roots[0], asymmetric, args[0], args[1], argc > 3 ? args[3] : mal_value_new_undefined(),
            argc > 2 ? args[2] : mal_value_new_null());
        mal_gc_unroot(&root);
        return roots[0];
    }
    u8 tag[64];
    usize length = 0;
    MalValue signature = argc > 2 ? args[2] : mal_value_new_undefined();
    MalBufferSourceSpan expected;
    if (!crypto_is_byte_source(signature) || mal_buffer_source_span(signature, &expected) != MAL_BUFFER_SOURCE_SPAN_OK) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The \"signature\" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.",
            "ERR_INVALID_ARG_TYPE");
        crypto_settle_with_completion(vm, roots[0]);
    } else if (crypto_web_hmac(vm, roots[0], args, argc, 3, tag, &length)) {
        u8 difference = (u8) (expected.length != length);
        for (usize i = 0; i < length && i < expected.length; i++) {
            difference |= (u8) (tag[i] ^ (u8) expected.data[i]);
        }
        mal_promise_fulfill(vm, mal_value_to_promise_object(roots[0]), mal_value_new_boolean(difference == 0));
    }
    mal_secure_scrub((byte *) tag, sizeof(tag));
    mal_gc_unroot(&root);
    return roots[0];
}

/* crypto.webcrypto and crypto.subtle: digest, raw HMAC sign/verify and AES-GCM encrypt/decrypt. */
static void crypto_install_webcrypto(MalVm *vm, MalObject *module) {
    MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[0]), (const byte *) "digest", 2,
        mal_node_crypto_subtle_digest);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[0]), (const byte *) "importKey", 5,
        mal_node_crypto_subtle_import_key);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[0]), (const byte *) "sign", 3,
        mal_node_crypto_subtle_sign);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[0]), (const byte *) "verify", 4,
        mal_node_crypto_subtle_verify);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[0]), (const byte *) "encrypt", 3,
        mal_node_crypto_subtle_encrypt);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[0]), (const byte *) "decrypt", 3,
        mal_node_crypto_subtle_decrypt);
    crypto_crypto_key_symbol = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    crypto_crypto_key_prototype = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalValue tag_key = vm->intrinsics[MAL_INTRINSIC_SYMBOL_TO_STRING_TAG];
    if (mal_value_is_symbol(tag_key)) {
        MalPropertyDesc tag = {
            .value = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "CryptoKey")),
            .flags = MAL_PROPERTY_CONFIGURABLE};
        mal_object_define_own(mal_value_to_object(crypto_crypto_key_prototype), mal_key_from_value(tag_key), &tag);
    }
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), (const byte *) "subtle", roots[0], flags);
    static const char *const shared[] = {"getRandomValues", "randomUUID"};
    for (usize i = 0; i < countof(shared); i++) {
        if (mal_vm_get_property(vm, mal_value_from_object(module), mal_key_from_value(mal_value_from_string(
                mal_intrinsic_ascii(vm, (const byte *) shared[i]))), &roots[2])) {
            mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), (const byte *) shared[i], roots[2], flags);
        }
    }
    mal_intrinsic_define_data(vm, module, (const byte *) "subtle", roots[0], flags);
    mal_intrinsic_define_data(vm, module, (const byte *) "webcrypto", roots[1], flags);
    mal_gc_unroot(&root);
}


/* ---------------------------------------------------------------------------
 * Cipheriv / Decipheriv over the streaming Rust ciphers.
 * --------------------------------------------------------------------------- */

typedef struct {
    const char *name;
    const char *info_name;
    const char *mode;
    u32 kind;
    u8 key_length;
    u8 iv_length;
    u8 block_size;
    i32 nid;
} CryptoCipherSpec;

/* Sorted as Node's getCiphers() lists them. */
static const CryptoCipherSpec CRYPTO_CIPHERS[] = {
    {"aes-128-cbc", "aes-128-cbc", "cbc", 1, 16, 16, 16, 419},
    {"aes-128-ctr", "aes-128-ctr", "ctr", 4, 16, 16, 1, 904},
    {"aes-128-gcm", "id-aes128-gcm", "gcm", 7, 16, 12, 1, 895},
    {"aes-192-cbc", "aes-192-cbc", "cbc", 2, 24, 16, 16, 423},
    {"aes-192-ctr", "aes-192-ctr", "ctr", 5, 24, 16, 1, 905},
    {"aes-192-gcm", "id-aes192-gcm", "gcm", 8, 24, 12, 1, 898},
    {"aes-256-cbc", "aes-256-cbc", "cbc", 3, 32, 16, 16, 427},
    {"aes-256-ctr", "aes-256-ctr", "ctr", 6, 32, 16, 1, 906},
    {"aes-256-gcm", "id-aes256-gcm", "gcm", 9, 32, 12, 1, 901},
    {"chacha20-poly1305", "chacha20-poly1305", "stream", 10, 32, 12, 0, 1018},
};

static const CryptoCipherSpec *crypto_cipher_spec(MalValue name) {
    if (!mal_value_is_string(name)) return nullptr;
    for (usize i = 0; i < countof(CRYPTO_CIPHERS); i++) {
        if (mal_string_equals_ascii_ci(mal_value_to_string(name), CRYPTO_CIPHERS[i].name)
            || mal_string_equals_ascii_ci(mal_value_to_string(name), CRYPTO_CIPHERS[i].info_name)) {
            return &CRYPTO_CIPHERS[i];
        }
    }
    return nullptr;
}

static bool crypto_cipher_is_aead(const CryptoCipherSpec *spec) {
    return spec->kind >= 7;
}

/* Precedes the Rust state inside one sensitive ArrayBuffer; 64 keeps it aligned. */
typedef struct {
    const CryptoCipherSpec *spec;
    bool encrypt;
    bool finalized;
    bool tag_ready;
    bool tag_set;
    u8 tag_length;
    u8 tag[16];
    /* Output bytes held back so string encodings concatenate like Node's StringDecoder. */
    u8 carry[4];
    u8 carry_length;
} CryptoCipherHeader;

#define CRYPTO_CIPHER_HEADER_BYTES 64
static_assert(sizeof(CryptoCipherHeader) <= CRYPTO_CIPHER_HEADER_BYTES, "cipher header outgrew its slot");

static CryptoCipherHeader *crypto_cipher_header(MalVm *vm, MalValue receiver) {
    if (crypto_keys_ready && mal_value_is_object(receiver)) {
        MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(receiver),
            (MalKey) {.kind = MAL_KEY_SYMBOL, .value = crypto_cipher_symbol});
        if (lookup.present && mal_value_is_array_buffer_object(lookup.desc.value)) {
            return (CryptoCipherHeader *) mal_value_to_array_buffer_object(lookup.desc.value)->data;
        }
    }
    crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Illegal invocation");
    return nullptr;
}

static MalCipher *crypto_cipher_state(CryptoCipherHeader *header) {
    return (MalCipher *) ((byte *) header + CRYPTO_CIPHER_HEADER_BYTES);
}

static void crypto_throw_coded(MalVm *vm, MalIntrinsic prototype, const char *message, const char *code) {
    if (code == nullptr) crypto_throw(vm, prototype, message);
    else mal_node_throw_code(vm, prototype, message, code);
}

static void crypto_cipher_throw_status(MalVm *vm, i32 status) {
    switch (status) {
        case MAL_CIPHER_INVALID_KEY:
            crypto_throw_coded(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid key length", "ERR_CRYPTO_INVALID_KEYLEN");
            break;
        case MAL_CIPHER_INVALID_IV:
            crypto_throw_coded(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid initialization vector", "ERR_CRYPTO_INVALID_IV");
            break;
        case MAL_CIPHER_BAD_DECRYPT:
            crypto_throw_coded(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "error:1C800064:Provider routines::bad decrypt",
                "ERR_OSSL_BAD_DECRYPT");
            break;
        case MAL_CIPHER_WRONG_FINAL_BLOCK_LENGTH:
            crypto_throw_coded(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                "error:1C80006B:Provider routines::wrong final block length", "ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH");
            break;
        case MAL_CIPHER_AUTH_FAILED:
            crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Unsupported state or unable to authenticate data");
            break;
        default:
            crypto_throw_coded(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Invalid state", "ERR_CRYPTO_INVALID_STATE");
            break;
    }
}

/* Key, IV and data share Node's accepted shapes: strings, buffer sources, secret KeyObjects. */
static bool crypto_cipher_bytes(MalVm *vm, MalValue value, MalValue encoding, const char *name,
    MalBufferSourceSpan *span, byte **owned) {
    *owned = nullptr;
    const byte *key_data;
    usize key_length;
    if (crypto_secret_key_bytes(value, &key_data, &key_length)) {
        *span = (MalBufferSourceSpan) {.data = (byte *) key_data, .length = key_length};
        return true;
    }
    if (mal_value_is_string(value)) {
        usize length;
        *owned = mal_node_buffer_decode_string(vm, value, encoding, &length);
        if (*owned == nullptr) { mal_vm_throw_allocation_error(vm); return false; }
        *span = (MalBufferSourceSpan) {.data = *owned, .length = length};
        return true;
    }
    if (!crypto_is_byte_source(value)) {
        crypto_throw_arg_type(vm, name,
            "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView", value);
        return false;
    }
    return crypto_byte_source_span(vm, value, name, span, owned);
}

static bool crypto_gcm_tag_length_valid(u32 length) {
    return length == 4 || length == 8 || (length >= 12 && length <= 16);
}

static MalValue crypto_cipher_create(MalVm *vm, const MalValue *args, i32 argc, bool encrypt) {
    MalValue undefined = mal_value_new_undefined();
    const CryptoCipherSpec *spec = crypto_cipher_spec(argc > 0 ? args[0] : undefined);
    if (spec == nullptr) {
        if (argc < 1 || !mal_value_is_string(args[0])) {
            crypto_throw_arg_type(vm, "cipher", "of type string", argc > 0 ? args[0] : undefined);
        } else {
            crypto_throw_coded(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Unknown cipher", "ERR_CRYPTO_UNKNOWN_CIPHER");
        }
        return undefined;
    }
    u32 tag_length = 16;
    MalValue options = argc > 3 ? args[3] : undefined;
    if (mal_value_is_object(options)) {
        bool ok;
        MalValue requested = crypto_get(vm, options, "authTagLength", &ok);
        if (!ok) return undefined;
        if (!mal_value_is_undefined(requested) && crypto_cipher_is_aead(spec)) {
            f64 number = mal_ops_is_number(requested) ? mal_ops_number_as_f64(requested) : -1;
            bool valid = number >= 1 && number <= 16 && trunc(number) == number
                && (spec->kind == 10 || crypto_gcm_tag_length_valid((u32) number));
            if (!valid) {
                char text[64];
                crypto_number_text(vm, requested, text, sizeof(text));
                char message[CRYPTO_MESSAGE_CAPACITY];
                snprintf(message, sizeof(message), "Invalid authentication tag length: %s", text);
                crypto_throw_coded(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_CRYPTO_INVALID_AUTH_TAG");
                return undefined;
            }
            tag_length = (u32) number;
        }
    }
    MalBufferSourceSpan key;
    MalBufferSourceSpan iv;
    byte *owned_key = nullptr;
    byte *owned_iv = nullptr;
    if (!crypto_cipher_bytes(vm, argc > 1 ? args[1] : undefined, undefined, "key", &key, &owned_key)) return undefined;
    MalValue iv_value = argc > 2 ? args[2] : undefined;
    if (mal_value_is_nil(iv_value)) {
        crypto_scrub_free(owned_key, key.length);
        crypto_throw_coded(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid initialization vector", "ERR_CRYPTO_INVALID_IV");
        return undefined;
    }
    if (!crypto_cipher_bytes(vm, iv_value, undefined, "iv", &iv, &owned_iv)) {
        crypto_scrub_free(owned_key, key.length);
        return undefined;
    }
    usize storage_size = CRYPTO_CIPHER_HEADER_BYTES + mal_cipher_state_size();
    byte *storage = crypto_cipher_storage(storage_size);
    if (storage == nullptr) {
        crypto_scrub_free(owned_key, key.length);
        crypto_scrub_free(owned_iv, iv.length);
        mal_vm_throw_allocation_error(vm);
        return undefined;
    }
    CryptoCipherHeader *header = (CryptoCipherHeader *) storage;
    *header = (CryptoCipherHeader) {.spec = spec, .encrypt = encrypt, .tag_length = (u8) tag_length};
    // Node checks the key before the IV; the Rust side reports whichever fails first the same way.
    i32 status = key.length != spec->key_length ? MAL_CIPHER_INVALID_KEY
        : mal_cipher_init((u8 *) storage + CRYPTO_CIPHER_HEADER_BYTES, mal_cipher_state_size(), spec->kind,
            encrypt, (const u8 *) key.data, key.length, (const u8 *) iv.data, iv.length);
    crypto_scrub_free(owned_key, key.length);
    crypto_scrub_free(owned_iv, iv.length);
    if (status != MAL_CIPHER_OK) {
        crypto_scrub_free(storage, storage_size);
        crypto_cipher_throw_status(vm, status);
        return undefined;
    }
    MalValue roots[] = {mal_value_from_object(mal_object_new(&vm->heap, mal_value_to_object(
        encrypt ? crypto_cipheriv_prototype : crypto_decipheriv_prototype))), undefined};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_array_buffer_object(mal_array_buffer_object_adopt(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]), storage, (u32) storage_size, true));
    mal_object_set(mal_value_to_object(roots[0]), (MalKey) {.kind = MAL_KEY_SYMBOL, .value = crypto_cipher_symbol},
        roots[1]);
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue mal_node_crypto_create_cipheriv(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    return crypto_cipher_create(vm, args, argc, true);
}

static MalValue mal_node_crypto_create_decipheriv(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    return crypto_cipher_create(vm, args, argc, false);
}

typedef enum { CRYPTO_CARRY_NONE, CRYPTO_CARRY_BASE64, CRYPTO_CARRY_UTF8 } CryptoCarryKind;

static CryptoCarryKind crypto_carry_kind(MalValue encoding) {
    if (!mal_value_is_string(encoding)) return CRYPTO_CARRY_NONE;
    MalString *name = mal_value_to_string(encoding);
    if (mal_string_equals_ascii_ci(name, "base64") || mal_string_equals_ascii_ci(name, "base64url")) {
        return CRYPTO_CARRY_BASE64;
    }
    if (mal_string_equals_ascii_ci(name, "utf8") || mal_string_equals_ascii_ci(name, "utf-8")) {
        return CRYPTO_CARRY_UTF8;
    }
    return CRYPTO_CARRY_NONE;
}

/* Bytes of an incomplete UTF-8 sequence at the end of `data`. */
static usize crypto_utf8_tail(const u8 *data, usize length) {
    for (usize back = 1; back <= 3 && back <= length; back++) {
        u8 byte_value = data[length - back];
        if ((byte_value & 0xc0) == 0x80) continue;
        usize need = byte_value >= 0xf0 ? 4 : byte_value >= 0xe0 ? 3 : byte_value >= 0xc0 ? 2 : 1;
        return need > back ? back : 0;
    }
    return 0;
}

/* Encodes `out` (which begins with any carried bytes) per Node's output encoding. */
static MalValue crypto_cipher_output(MalVm *vm, CryptoCipherHeader *header, u8 *out, usize length,
    MalValue encoding, bool last) {
    if (!mal_value_is_string(encoding) || !mal_node_buffer_encoding_is_known(encoding)
        || mal_string_equals_ascii_ci(mal_value_to_string(encoding), "buffer")) {
        return mal_node_buffer_from_owned_bytes(vm, (byte *) out, length);
    }
    usize keep = 0;
    CryptoCarryKind carry = crypto_carry_kind(encoding);
    if (!last && carry == CRYPTO_CARRY_BASE64) keep = length % 3;
    if (!last && carry == CRYPTO_CARRY_UTF8) keep = crypto_utf8_tail(out, length);
    memcpy(header->carry, out + length - keep, keep);
    header->carry_length = (u8) keep;
    MalValue result = mal_node_buffer_encode_bytes(vm, (const byte *) out, length - keep, encoding, false);
    free(out);
    return result;
}

static MalValue mal_node_crypto_cipher_update(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    CryptoCipherHeader *header = crypto_cipher_header(vm, receiver);
    if (header == nullptr) return mal_value_new_undefined();
    if (header->finalized) {
        crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Trying to add data in unsupported state");
        return mal_value_new_undefined();
    }
    MalValue data = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_string(data) && !crypto_is_byte_source(data)) {
        crypto_throw_arg_type(vm, "data",
            "of type string or an instance of Buffer, TypedArray, or DataView", data);
        return mal_value_new_undefined();
    }
    MalBufferSourceSpan span;
    byte *owned = nullptr;
    if (!crypto_cipher_bytes(vm, data, argc > 1 ? args[1] : mal_value_new_undefined(), "data", &span, &owned)) {
        return mal_value_new_undefined();
    }
    usize carried = header->carry_length;
    usize capacity = carried + span.length + 16;
    u8 *out = malloc(capacity);
    if (out == nullptr) {
        free(owned);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    memcpy(out, header->carry, carried);
    usize written = 0;
    i32 status = mal_cipher_update(crypto_cipher_state(header), (const u8 *) span.data, span.length,
        out + carried, capacity - carried, &written);
    free(owned);
    if (status != MAL_CIPHER_OK) {
        free(out);
        crypto_cipher_throw_status(vm, status);
        return mal_value_new_undefined();
    }
    return crypto_cipher_output(vm, header, out, carried + written, argc > 2 ? args[2] : mal_value_new_undefined(),
        false);
}

static MalValue mal_node_crypto_cipher_final(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    CryptoCipherHeader *header = crypto_cipher_header(vm, receiver);
    if (header == nullptr) return mal_value_new_undefined();
    if (header->finalized) {
        crypto_throw_coded(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Unsupported state", "ERR_CRYPTO_INVALID_STATE");
        return mal_value_new_undefined();
    }
    header->finalized = true;
    usize carried = header->carry_length;
    u8 *out = malloc(carried + 16);
    if (out == nullptr) { mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
    memcpy(out, header->carry, carried);
    header->carry_length = 0;
    usize written = 0;
    MalCipher *state = crypto_cipher_state(header);
    i32 status = crypto_cipher_is_aead(header->spec) && !header->encrypt && !header->tag_set
        ? MAL_CIPHER_AUTH_FAILED : mal_cipher_final(state, out + carried, 16, &written);
    if (status == MAL_CIPHER_OK && header->encrypt && crypto_cipher_is_aead(header->spec)) {
        status = mal_cipher_get_tag(state, header->tag, header->tag_length);
        header->tag_ready = status == MAL_CIPHER_OK;
    }
    if (status != MAL_CIPHER_OK) {
        free(out);
        crypto_cipher_throw_status(vm, status);
        return mal_value_new_undefined();
    }
    return crypto_cipher_output(vm, header, out, carried + written, argc > 0 ? args[0] : mal_value_new_undefined(),
        true);
}

static void crypto_cipher_invalid_state(MalVm *vm, const char *operation) {
    char message[96];
    snprintf(message, sizeof(message), "Invalid state for operation %s", operation);
    crypto_throw_coded(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, message, "ERR_CRYPTO_INVALID_STATE");
}

static MalValue mal_node_crypto_cipher_set_auto_padding(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    CryptoCipherHeader *header = crypto_cipher_header(vm, receiver);
    if (header == nullptr) return mal_value_new_undefined();
    bool padding = argc < 1 || mal_value_is_undefined(args[0]) || mal_value_is_truthy(args[0]);
    if (header->finalized || mal_cipher_set_padding(crypto_cipher_state(header), padding) != MAL_CIPHER_OK) {
        crypto_cipher_invalid_state(vm, "setAutoPadding");
        return mal_value_new_undefined();
    }
    return receiver;
}

static MalValue mal_node_crypto_cipher_set_aad(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    CryptoCipherHeader *header = crypto_cipher_header(vm, receiver);
    if (header == nullptr) return mal_value_new_undefined();
    MalValue data = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!crypto_is_byte_source(data)) {
        crypto_throw_arg_type(vm, "buffer", "an instance of ArrayBuffer, Buffer, TypedArray, or DataView", data);
        return mal_value_new_undefined();
    }
    MalBufferSourceSpan span;
    byte *owned = nullptr;
    if (!crypto_byte_source_span(vm, data, "buffer", &span, &owned)) return mal_value_new_undefined();
    i32 status = header->finalized || !crypto_cipher_is_aead(header->spec) ? MAL_CIPHER_INVALID_STATE
        : mal_cipher_set_aad(crypto_cipher_state(header), (const u8 *) span.data, span.length);
    free(owned);
    if (status != MAL_CIPHER_OK) {
        crypto_cipher_invalid_state(vm, "setAAD");
        return mal_value_new_undefined();
    }
    return receiver;
}

static MalValue mal_node_crypto_cipher_get_auth_tag(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    CryptoCipherHeader *header = crypto_cipher_header(vm, receiver);
    if (header == nullptr) return mal_value_new_undefined();
    if (!header->tag_ready) {
        crypto_cipher_invalid_state(vm, "getAuthTag");
        return mal_value_new_undefined();
    }
    byte *tag = malloc(header->tag_length);
    if (tag == nullptr) { mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
    memcpy(tag, header->tag, header->tag_length);
    return mal_node_buffer_from_owned_bytes(vm, tag, header->tag_length);
}

static MalValue mal_node_crypto_cipher_set_auth_tag(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    CryptoCipherHeader *header = crypto_cipher_header(vm, receiver);
    if (header == nullptr) return mal_value_new_undefined();
    MalValue data = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!crypto_is_byte_source(data)) {
        crypto_throw_arg_type(vm, "buffer", "an instance of Buffer, TypedArray, or DataView", data);
        return mal_value_new_undefined();
    }
    MalBufferSourceSpan span;
    byte *owned = nullptr;
    if (!crypto_byte_source_span(vm, data, "buffer", &span, &owned)) return mal_value_new_undefined();
    bool valid_length = header->spec->kind == 10 ? span.length >= 1 && span.length <= 16
        : crypto_gcm_tag_length_valid((u32) span.length);
    if (crypto_cipher_is_aead(header->spec) && !header->finalized && !header->tag_set && !valid_length) {
        free(owned);
        char message[96];
        snprintf(message, sizeof(message), "Invalid authentication tag length: %zu", span.length);
        crypto_throw_coded(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_CRYPTO_INVALID_AUTH_TAG");
        return mal_value_new_undefined();
    }
    i32 status = header->finalized || header->tag_set || !crypto_cipher_is_aead(header->spec)
        ? MAL_CIPHER_INVALID_STATE
        : mal_cipher_set_tag(crypto_cipher_state(header), (const u8 *) span.data, span.length);
    free(owned);
    if (status != MAL_CIPHER_OK) {
        crypto_cipher_invalid_state(vm, "setAuthTag");
        return mal_value_new_undefined();
    }
    header->tag_set = true;
    return receiver;
}

static MalValue mal_node_crypto_get_cipher_info(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue query = argc > 0 ? args[0] : mal_value_new_undefined();
    const CryptoCipherSpec *spec = crypto_cipher_spec(query);
    for (usize i = 0; spec == nullptr && mal_ops_is_number(query) && i < countof(CRYPTO_CIPHERS); i++) {
        if (mal_ops_number_as_f64(query) == (f64) CRYPTO_CIPHERS[i].nid) spec = &CRYPTO_CIPHERS[i];
    }
    if (spec == nullptr) return mal_value_new_undefined();
    MalValue info = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &info, 1);
    crypto_set(vm, info, "mode", mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) spec->mode)));
    crypto_set(vm, info, "name", mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) spec->info_name)));
    crypto_set(vm, info, "nid", mal_value_from_i32(spec->nid));
    crypto_set(vm, info, "keyLength", mal_value_from_i32(spec->key_length));
    if (spec->block_size > 0) crypto_set(vm, info, "blockSize", mal_value_from_i32(spec->block_size));
    crypto_set(vm, info, "ivLength", mal_value_from_i32(spec->iv_length));
    mal_gc_unroot(&root);
    return info;
}

static MalValue crypto_cipher_class(MalVm *vm, MalObject *module, const char *name,
    MalNativeFunctionCallback construct, bool encrypt) {
    MalPropertyFlags hidden = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE;
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), 4, construct);
    mal_native_function_object_set_constructor(constructor);
    roots[1] = mal_value_from_native_function_object(constructor);
    MalObject *prototype = mal_value_to_object(roots[0]);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype", roots[0], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, (const byte *) "constructor", roots[1], hidden);
    mal_intrinsic_define_method_n(vm, prototype, (const byte *) "update", 3, mal_node_crypto_cipher_update);
    mal_intrinsic_define_method_n(vm, prototype, (const byte *) "final", 1, mal_node_crypto_cipher_final);
    mal_intrinsic_define_method_n(vm, prototype, (const byte *) "setAutoPadding", 1,
        mal_node_crypto_cipher_set_auto_padding);
    if (encrypt) {
        mal_intrinsic_define_method_n(vm, prototype, (const byte *) "getAuthTag", 0,
            mal_node_crypto_cipher_get_auth_tag);
    } else {
        mal_intrinsic_define_method_n(vm, prototype, (const byte *) "setAuthTag", 1,
            mal_node_crypto_cipher_set_auth_tag);
    }
    mal_intrinsic_define_method_n(vm, prototype, (const byte *) "setAAD", 2, mal_node_crypto_cipher_set_aad);
    mal_intrinsic_define_data(vm, module, (const byte *) name, roots[1],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&root);
    return roots[0];
}

static void crypto_install_ciphers(MalVm *vm, MalObject *module) {
    crypto_cipher_symbol = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    crypto_cipheriv_prototype = mal_value_new_undefined();
    crypto_decipheriv_prototype = mal_value_new_undefined();
    crypto_cipheriv_prototype = crypto_cipher_class(vm, module, "Cipheriv", mal_node_crypto_create_cipheriv, true);
    crypto_decipheriv_prototype = crypto_cipher_class(vm, module, "Decipheriv", mal_node_crypto_create_decipheriv,
        false);
}

static MalValue mal_node_crypto_get_ciphers(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target; (void) callee;
    const char *names[countof(CRYPTO_CIPHERS)];
    for (usize i = 0; i < countof(CRYPTO_CIPHERS); i++) names[i] = CRYPTO_CIPHERS[i].name;
    return crypto_name_list(vm, names, countof(names));
}

/* Asymmetric KeyObjects hold canonical PKCS#8 (private) or SPKI (public) DER
 * behind a private symbol and re-import it per operation, so the GC owns no
 * Rust handle and no finalizer is needed. */
static bool crypto_option(MalVm *vm, MalValue object, const char *name, MalValue *out) {
    *out = mal_value_new_undefined();
    if (!mal_value_is_object(object)) return true;
    return mal_vm_get_property(vm, object, mal_key_from_value(
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) name))), out);
}

static bool crypto_string_is(MalValue value, const char *ascii) {
    return mal_value_is_string(value) && mal_string_equals_ascii(mal_value_to_string(value), ascii);
}

static void crypto_throw_pkey_status(MalVm *vm, i32 status) {
    switch (status) {
    case MAL_PKEY_ENCRYPTED:
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            "Encrypted private keys are not supported by this host", "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM");
        return;
    case MAL_PKEY_UNSUPPORTED:
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Unsupported crypto operation",
            "ERR_CRYPTO_UNSUPPORTED_OPERATION");
        return;
    case MAL_PKEY_NOT_PRIVATE:
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Invalid key object type public, expected private.", "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE");
        return;
    default:
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "error:1E08010C:DECODER routines::unsupported",
            "ERR_OSSL_UNSUPPORTED");
        return;
    }
}

/* A malloc'd copy of a string (decoded with `encoding`) or byte source. */
static bool crypto_input_bytes(MalVm *vm, MalValue value, MalValue encoding, const char *name, byte **out,
    usize *length) {
    *out = nullptr;
    *length = 0;
    if (mal_value_is_string(value)) {
        *out = mal_node_buffer_decode_string(vm, value, encoding, length);
        if (*out == nullptr) { mal_vm_throw_allocation_error(vm); return false; }
        return true;
    }
    if (!crypto_is_byte_source(value)) {
        crypto_throw_arg_type(vm, name,
            "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView", value);
        return false;
    }
    MalBufferSourceSpan span;
    byte *owned;
    if (!mal_node_crypto_byte_span(vm, value, &span, &owned)) return false;
    if (owned == nullptr) {
        owned = malloc(span.length > 0 ? span.length : 1);
        if (owned == nullptr) { mal_vm_throw_allocation_error(vm); return false; }
        if (span.length > 0) memcpy(owned, span.data, span.length);
    }
    *out = owned;
    *length = span.length;
    return true;
}

static bool crypto_pkey_der(MalValue value, const byte **data, usize *length) {
    if (!crypto_keys_ready || !mal_value_is_object(value)) return false;
    MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(value),
        (MalKey) {.kind = MAL_KEY_SYMBOL, .value = crypto_pkey_symbol});
    if (!lookup.present || !mal_value_is_array_buffer_object(lookup.desc.value)) return false;
    MalArrayBufferObject *buffer = mal_value_to_array_buffer_object(lookup.desc.value);
    *data = buffer->data;
    *length = buffer->byte_length;
    return true;
}

static MalPkey *crypto_pkey_from_object(MalValue value) {
    const byte *der;
    usize length;
    if (!crypto_pkey_der(value, &der, &length)) return nullptr;
    bool private_key = crypto_is_private_pkey(value);
    MalPkey *key = nullptr;
    if (mal_pkey_import((const u8 *) der, length, MAL_PKEY_FORMAT_DER,
            private_key ? MAL_PKEY_TYPE_PKCS8 : MAL_PKEY_TYPE_SPKI, private_key, &key) != MAL_PKEY_OK) return nullptr;
    return key;
}

static bool crypto_pkey_export_bytes(MalVm *vm, const MalPkey *key, u32 format, u32 type, bool private_key,
    byte **out, usize *length) {
    usize needed = 0;
    i32 status = mal_pkey_export(key, format, type, private_key, nullptr, 0, &needed);
    if (status != MAL_PKEY_BUFFER_TOO_SMALL) { crypto_throw_pkey_status(vm, status); return false; }
    *out = malloc(needed > 0 ? needed : 1);
    if (*out == nullptr) { mal_vm_throw_allocation_error(vm); return false; }
    status = mal_pkey_export(key, format, type, private_key, (u8 *) *out, needed, length);
    if (status != MAL_PKEY_OK) { crypto_scrub_free(*out, needed); crypto_throw_pkey_status(vm, status); return false; }
    return true;
}

/* Consumes `key`. */
static MalValue crypto_new_pkey_object(MalVm *vm, MalPkey *key) {
    bool private_key = mal_pkey_is_private(key);
    byte *der;
    usize length;
    bool exported = crypto_pkey_export_bytes(vm, key, MAL_PKEY_FORMAT_DER,
        private_key ? MAL_PKEY_TYPE_PKCS8 : MAL_PKEY_TYPE_SPKI, private_key, &der, &length);
    mal_pkey_free(key);
    if (!exported) return mal_value_new_undefined();
    MalValue roots[] = {mal_value_from_object(mal_object_new(&vm->heap, mal_value_to_object(
        private_key ? crypto_private_key_prototype : crypto_public_key_prototype))), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_array_buffer_object(mal_array_buffer_object_adopt(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]), der, (u32) length, true));
    mal_object_set(mal_value_to_object(roots[0]),
        (MalKey) {.kind = MAL_KEY_SYMBOL, .value = crypto_pkey_symbol}, roots[1]);
    mal_gc_unroot(&root);
    return roots[0];
}

static bool crypto_jwk_part(MalVm *vm, MalValue jwk, const char *name, byte **out, usize *length) {
    MalValue value;
    *out = nullptr;
    *length = 0;
    if (!crypto_option(vm, jwk, name, &value)) return false;
    if (mal_value_is_undefined(value)) return true;
    if (!mal_value_is_string(value)) {
        char property[32];
        snprintf(property, sizeof(property), "key.%s", name);
        crypto_throw_property_type(vm, property, "of type string", value);
        return false;
    }
    MalValue roots[] = {value, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "base64url"));
    bool ok = crypto_input_bytes(vm, roots[0], roots[1], name, out, length);
    mal_gc_unroot(&root);
    return ok;
}

static MalPkey *crypto_pkey_from_jwk(MalVm *vm, MalValue jwk, bool private_key) {
    static const char *const RSA_FIELDS[] = {"n", "e", "d", "p", "q", "dp", "dq", "qi"};
    static const char *const EC_FIELDS[] = {"x", "y", "d"};
    MalValue kty, crv;
    if (!crypto_option(vm, jwk, "kty", &kty) || !crypto_option(vm, jwk, "crv", &crv)) return nullptr;
    u32 kind;
    const char *const *fields;
    usize field_count;
    if (crypto_string_is(kty, "RSA")) {
        kind = MAL_PKEY_RSA; fields = RSA_FIELDS; field_count = countof(RSA_FIELDS);
    } else if (crypto_string_is(kty, "EC") && (crypto_string_is(crv, "P-256") || crypto_string_is(crv, "P-384"))) {
        kind = crypto_string_is(crv, "P-256") ? MAL_PKEY_EC_P256 : MAL_PKEY_EC_P384;
        fields = EC_FIELDS; field_count = countof(EC_FIELDS);
    } else if (crypto_string_is(kty, "OKP") && crypto_string_is(crv, "Ed25519")) {
        kind = MAL_PKEY_ED25519; fields = EC_FIELDS; field_count = countof(EC_FIELDS);
    } else {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The \"key.kty\" property must be one of: 'RSA', 'EC', 'OKP'.", "ERR_INVALID_ARG_VALUE");
        return nullptr;
    }
    byte *parts[8] = {0};
    usize lengths[8] = {0};
    bool ok = true;
    for (usize i = 0; i < field_count && ok; i++) {
        if (kind == MAL_PKEY_ED25519 && i == 1) continue;
        if (!private_key && strcmp(fields[i], "d") == 0) continue;
        if (!private_key && kind == MAL_PKEY_RSA && i >= 2) break;
        ok = crypto_jwk_part(vm, jwk, fields[i], &parts[i], &lengths[i]);
    }
    MalPkey *key = nullptr;
    if (ok) {
        i32 status = mal_pkey_import_jwk(kind, (const u8 *const *) parts, lengths, 8, private_key, &key);
        if (status != MAL_PKEY_OK) {
            mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid JWK data", "ERR_CRYPTO_INVALID_JWK");
            key = nullptr;
        }
    }
    for (usize i = 0; i < 8; i++) if (parts[i] != nullptr) crypto_scrub_free(parts[i], lengths[i]);
    return key;
}

/* Node's prepareAsymmetricKey: KeyObjects, PEM text/bytes and `{ key, format, type }`. */
static MalPkey *crypto_pkey_from_input(MalVm *vm, MalValue input, bool private_key) {
    MalValue key = input, format = mal_value_new_undefined(), type = mal_value_new_undefined();
    if (mal_value_is_object(input) && !crypto_is_byte_source(input) && !crypto_pkey_der(input, &(const byte *) {0},
            &(usize) {0})) {
        if (!crypto_option(vm, input, "key", &key) || !crypto_option(vm, input, "format", &format)
            || !crypto_option(vm, input, "type", &type)) return nullptr;
    }
    const byte *der;
    usize der_length;
    if (crypto_pkey_der(key, &der, &der_length)) {
        bool stored_private = crypto_is_private_pkey(key);
        if (private_key && !stored_private) {
            crypto_throw_pkey_status(vm, MAL_PKEY_NOT_PRIVATE);
            return nullptr;
        }
        MalPkey *handle = crypto_pkey_from_object(key);
        if (handle == nullptr) { crypto_throw_pkey_status(vm, MAL_PKEY_INVALID_KEY); return nullptr; }
        if (private_key || !stored_private) return handle;
        MalPkey *public_key = nullptr;
        i32 status = mal_pkey_public(handle, &public_key);
        mal_pkey_free(handle);
        if (status != MAL_PKEY_OK) { crypto_throw_pkey_status(vm, status); return nullptr; }
        return public_key;
    }
    if (crypto_string_is(format, "jwk")) {
        if (!mal_value_is_object(key)) {
            crypto_throw_property_type(vm, "key.key", "of type object", key);
            return nullptr;
        }
        return crypto_pkey_from_jwk(vm, key, private_key);
    }
    u32 format_code = MAL_PKEY_FORMAT_PEM;
    u32 type_code = 0;
    if (crypto_string_is(format, "der")) {
        format_code = MAL_PKEY_FORMAT_DER;
        if (crypto_string_is(type, "pkcs1")) type_code = MAL_PKEY_TYPE_PKCS1;
        else if (crypto_string_is(type, "pkcs8")) type_code = MAL_PKEY_TYPE_PKCS8;
        else if (crypto_string_is(type, "spki")) type_code = MAL_PKEY_TYPE_SPKI;
        else if (crypto_string_is(type, "sec1")) type_code = MAL_PKEY_TYPE_SEC1;
        else {
            crypto_throw_property_type(vm, "key.type", "one of: 'pkcs1', 'pkcs8', 'spki', 'sec1'", type);
            return nullptr;
        }
    } else if (!mal_value_is_undefined(format) && !crypto_string_is(format, "pem")) {
        crypto_throw_property_type(vm, "key.format", "one of: 'pem', 'der', 'jwk'", format);
        return nullptr;
    }
    byte *bytes;
    usize length;
    if (!crypto_input_bytes(vm, key, mal_value_new_undefined(), "key", &bytes, &length)) return nullptr;
    MalPkey *handle = nullptr;
    i32 status = mal_pkey_import((const u8 *) bytes, length, format_code, type_code, private_key, &handle);
    crypto_scrub_free(bytes, length);
    if (status != MAL_PKEY_OK) { crypto_throw_pkey_status(vm, status); return nullptr; }
    return handle;
}

static MalValue mal_node_crypto_create_private_key(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue input = argc > 0 ? args[0] : mal_value_new_undefined();
    const byte *der;
    usize length;
    if (crypto_pkey_der(input, &der, &length)) {
        crypto_throw_arg_type(vm, "key",
            "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, or URL", input);
        return mal_value_new_undefined();
    }
    MalPkey *key = crypto_pkey_from_input(vm, input, true);
    return key == nullptr ? mal_value_new_undefined() : crypto_new_pkey_object(vm, key);
}

static MalValue mal_node_crypto_create_public_key(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalPkey *key = crypto_pkey_from_input(vm, argc > 0 ? args[0] : mal_value_new_undefined(), false);
    return key == nullptr ? mal_value_new_undefined() : crypto_new_pkey_object(vm, key);
}

static MalPkey *crypto_receiver_pkey(MalVm *vm, MalValue receiver) {
    MalPkey *key = crypto_pkey_from_object(receiver);
    if (key == nullptr) crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Illegal invocation");
    return key;
}

static MalValue mal_node_crypto_pkey_type(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    MalPkey *key = crypto_receiver_pkey(vm, receiver);
    if (key == nullptr) return mal_value_new_undefined();
    u32 kind = mal_pkey_kind(key);
    mal_pkey_free(key);
    const char *name = kind == MAL_PKEY_RSA ? "rsa" : kind == MAL_PKEY_ED25519 ? "ed25519" : "ec";
    return mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) name));
}

static MalValue mal_node_crypto_pkey_details(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    MalPkey *key = crypto_receiver_pkey(vm, receiver);
    if (key == nullptr) return mal_value_new_undefined();
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
    u32 kind = mal_pkey_kind(key);
    if (kind == MAL_PKEY_RSA) {
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "modulusLength",
            mal_ops_number_value((f64) mal_pkey_modulus_bits(key)), flags);
        u8 exponent[16];
        usize length = 0;
        if (mal_pkey_jwk_field(key, 1, exponent, sizeof(exponent), &length) == MAL_PKEY_OK) {
            u64 value = 0;
            for (usize i = 0; i < length; i++) value = (value << 8) | exponent[i];
            roots[1] = mal_value_from_bigint(mal_bigint_new(&vm->heap, (i128) value));
            mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "publicExponent", roots[1],
                flags);
        }
    } else if (kind != MAL_PKEY_ED25519) {
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "namedCurve",
            mal_value_from_string(mal_intrinsic_ascii(vm,
                (const byte *) (kind == MAL_PKEY_EC_P256 ? "prime256v1" : "secp384r1"))), flags);
    }
    mal_pkey_free(key);
    mal_gc_unroot(&root);
    return roots[0];
}

static void crypto_define_ascii(MalVm *vm, MalObject *object, const char *name, const char *value) {
    mal_intrinsic_define_data(vm, object, (const byte *) name,
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) value)),
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
}

static MalValue crypto_pkey_jwk(MalVm *vm, const MalPkey *key) {
    static const char *const RSA_FIELDS[] = {"n", "e", "d", "p", "q", "dp", "dq", "qi"};
    static const char *const EC_FIELDS[] = {"x", "y", "d"};
    u32 kind = mal_pkey_kind(key);
    bool private_key = mal_pkey_is_private(key);
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[2] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "base64url"));
    MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
    MalObject *jwk = mal_value_to_object(roots[0]);
    const char *kty = kind == MAL_PKEY_RSA ? "RSA" : kind == MAL_PKEY_ED25519 ? "OKP" : "EC";
    const char *crv = kind == MAL_PKEY_EC_P256 ? "P-256" : kind == MAL_PKEY_EC_P384 ? "P-384" : "Ed25519";
    const char *const *fields = kind == MAL_PKEY_RSA ? RSA_FIELDS : EC_FIELDS;
    usize count = kind == MAL_PKEY_RSA ? (private_key ? 8 : 2) : (private_key ? 3 : 2);
    // Node orders EC members x, y, crv, d and OKP members crv, x, d.
    usize crv_before = kind == MAL_PKEY_RSA ? SIZE_MAX : kind == MAL_PKEY_ED25519 ? 0 : 2;
    crypto_define_ascii(vm, jwk, "kty", kty);
    for (usize i = 0; i <= count; i++) {
        if (i == crv_before) crypto_define_ascii(vm, jwk, "crv", crv);
        if (i == count || (kind == MAL_PKEY_ED25519 && i == 1)) continue;
        u8 buffer[1024];
        usize length = 0;
        if (mal_pkey_jwk_field(key, (u32) i, buffer, sizeof(buffer), &length) != MAL_PKEY_OK) continue;
        roots[1] = mal_node_buffer_encode_bytes(vm, (const byte *) buffer, length, roots[2], false);
        mal_secure_scrub((byte *) buffer, sizeof(buffer));
        if (vm->completion.kind == MAL_COMPLETION_THROW) break;
        mal_intrinsic_define_data(vm, jwk, (const byte *) fields[i], roots[1], flags);
    }
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue mal_node_crypto_pkey_export(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    MalValue options = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_object(options)) {
        crypto_throw_arg_type(vm, "options", "of type object", options);
        return mal_value_new_undefined();
    }
    MalValue format, type, cipher;
    if (!crypto_option(vm, options, "format", &format) || !crypto_option(vm, options, "type", &type)
        || !crypto_option(vm, options, "cipher", &cipher)) return mal_value_new_undefined();
    MalPkey *key = crypto_receiver_pkey(vm, receiver);
    if (key == nullptr) return mal_value_new_undefined();
    bool private_key = mal_pkey_is_private(key);
    if (crypto_string_is(format, "jwk")) {
        MalValue result = crypto_pkey_jwk(vm, key);
        mal_pkey_free(key);
        return result;
    }
    if (!mal_value_is_undefined(cipher)) {
        mal_pkey_free(key);
        crypto_throw_pkey_status(vm, MAL_PKEY_ENCRYPTED);
        return mal_value_new_undefined();
    }
    u32 format_code;
    if (crypto_string_is(format, "pem")) format_code = MAL_PKEY_FORMAT_PEM;
    else if (crypto_string_is(format, "der")) format_code = MAL_PKEY_FORMAT_DER;
    else {
        mal_pkey_free(key);
        crypto_throw_property_type(vm, "options.format", "one of: 'pem', 'der', 'jwk'", format);
        return mal_value_new_undefined();
    }
    u32 type_code;
    if (crypto_string_is(type, "pkcs1")) type_code = MAL_PKEY_TYPE_PKCS1;
    else if (crypto_string_is(type, "pkcs8") && private_key) type_code = MAL_PKEY_TYPE_PKCS8;
    else if (crypto_string_is(type, "spki") && !private_key) type_code = MAL_PKEY_TYPE_SPKI;
    else if (crypto_string_is(type, "sec1") && private_key) type_code = MAL_PKEY_TYPE_SEC1;
    else {
        mal_pkey_free(key);
        crypto_throw_property_type(vm, "options.type",
            private_key ? "one of: 'pkcs1', 'pkcs8', 'sec1'" : "one of: 'pkcs1', 'spki'", type);
        return mal_value_new_undefined();
    }
    byte *bytes;
    usize length;
    bool exported = crypto_pkey_export_bytes(vm, key, format_code, type_code, private_key, &bytes, &length);
    mal_pkey_free(key);
    if (!exported) return mal_value_new_undefined();
    if (format_code == MAL_PKEY_FORMAT_DER) {
        return private_key ? mal_node_buffer_from_owned_secret_bytes(vm, bytes, length)
                           : mal_node_buffer_from_owned_bytes(vm, bytes, length);
    }
    MalValue text = mal_value_from_string(mal_string_new_ascii(&vm->heap, bytes, length));
    crypto_scrub_free(bytes, length);
    return text;
}

static bool crypto_sign_hash(MalVm *vm, MalValue algorithm, u32 *hash) {
    MalNodeCryptoStateKind kind;
    if (!mal_value_is_string(algorithm) || !crypto_digest_kind(mal_value_to_string(algorithm), &kind)) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid digest", "ERR_CRYPTO_INVALID_DIGEST");
        return false;
    }
    switch (kind) {
    case MAL_NODE_CRYPTO_SHA256: *hash = MAL_PKEY_HASH_SHA256; return true;
    case MAL_NODE_CRYPTO_SHA384: *hash = MAL_PKEY_HASH_SHA384; return true;
    case MAL_NODE_CRYPTO_SHA512: *hash = MAL_PKEY_HASH_SHA512; return true;
    default:
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            "This digest is not supported for signatures by this host", "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM");
        return false;
    }
}

typedef struct {
    u32 padding;
    i32 salt;
    bool p1363;
} CryptoSignOptions;

static bool crypto_sign_options(MalVm *vm, MalValue input, u32 hash, CryptoSignOptions *options) {
    options->padding = MAL_PKEY_PADDING_PKCS1;
    options->salt = -1;
    options->p1363 = false;
    if (!mal_value_is_object(input) || crypto_is_byte_source(input)) return true;
    MalValue padding, salt, encoding;
    if (!crypto_option(vm, input, "padding", &padding) || !crypto_option(vm, input, "saltLength", &salt)
        || !crypto_option(vm, input, "dsaEncoding", &encoding)) return false;
    if (mal_ops_is_number(padding)) options->padding = (u32) mal_ops_number_as_f64(padding);
    if (mal_ops_is_number(salt)) options->salt = (i32) mal_ops_number_as_f64(salt);
    if (crypto_string_is(encoding, "ieee-p1363")) options->p1363 = true;
    else if (!mal_value_is_undefined(encoding) && !crypto_string_is(encoding, "der")) {
        crypto_throw_property_type(vm, "options.dsaEncoding", "one of: 'der', 'ieee-p1363'", encoding);
        return false;
    }
    // RSA_PSS_SALTLEN_DIGEST, and ring's only PSS salt length, so it doubles as the sign default.
    static const i32 HASH_LENGTHS[] = {0, 32, 48, 64};
    if (options->salt < 0) options->salt = options->salt == -1 || options->salt == -2 ? (i32) HASH_LENGTHS[hash] : -1;
    return true;
}

/* A null algorithm means SHA-256 for RSA and ECDSA keys, as OpenSSL's default digest. */
static u32 crypto_default_hash(const MalPkey *key, u32 hash) {
    return hash == MAL_PKEY_HASH_NONE && mal_pkey_kind(key) != MAL_PKEY_ED25519 ? MAL_PKEY_HASH_SHA256 : hash;
}

static MalValue crypto_sign_with(MalVm *vm, u32 hash, const byte *message, usize length, MalValue key_input,
    MalValue encoding) {
    MalPkey *key = crypto_pkey_from_input(vm, key_input, true);
    if (key == nullptr) return mal_value_new_undefined();
    hash = crypto_default_hash(key, hash);
    CryptoSignOptions options;
    if (!crypto_sign_options(vm, key_input, hash, &options)) { mal_pkey_free(key); return mal_value_new_undefined(); }
    u8 signature[1024];
    usize written = 0;
    i32 status = mal_pkey_sign(key, hash, options.padding, options.salt, options.p1363, (const u8 *) message, length,
        signature, sizeof(signature), &written);
    mal_pkey_free(key);
    if (status != MAL_PKEY_OK) { crypto_throw_pkey_status(vm, status); return mal_value_new_undefined(); }
    return mal_node_buffer_encode_bytes(vm, (const byte *) signature, written, encoding, false);
}

static MalValue crypto_verify_with(MalVm *vm, u32 hash, const byte *message, usize length, MalValue key_input,
    MalValue signature, MalValue encoding) {
    byte *sig;
    usize sig_length;
    if (!crypto_input_bytes(vm, signature, encoding, "signature", &sig, &sig_length)) return mal_value_new_undefined();
    MalPkey *key = crypto_pkey_from_input(vm, key_input, false);
    if (key == nullptr) { free(sig); return mal_value_new_undefined(); }
    hash = crypto_default_hash(key, hash);
    CryptoSignOptions options;
    if (!crypto_sign_options(vm, key_input, hash, &options)) {
        mal_pkey_free(key);
        free(sig);
        return mal_value_new_undefined();
    }
    i32 status = mal_pkey_verify(key, hash, options.padding, options.salt, options.p1363, (const u8 *) message, length,
        (const u8 *) sig, sig_length);
    mal_pkey_free(key);
    free(sig);
    if (status == MAL_PKEY_OK || status == MAL_PKEY_BAD_SIGNATURE) return mal_value_new_boolean(status == MAL_PKEY_OK);
    crypto_throw_pkey_status(vm, status);
    return mal_value_new_undefined();
}

/* Sign/Verify buffer the message in an ArrayBuffer (ring signs whole messages)
 * whose capacity grows geometrically; the used length and digest sit in a meta
 * number as used * 4 + hash. */
static bool crypto_signer_state(MalVm *vm, MalValue receiver, MalArrayBufferObject **buffer, usize *used,
    u32 *hash) {
    if (!crypto_keys_ready || !mal_value_is_object(receiver)) goto illegal;
    MalPropertyLookup data = mal_object_get_own(mal_value_to_object(receiver),
        (MalKey) {.kind = MAL_KEY_SYMBOL, .value = crypto_pkey_symbol});
    MalPropertyLookup meta = mal_object_get_own(mal_value_to_object(receiver),
        (MalKey) {.kind = MAL_KEY_SYMBOL, .value = crypto_signer_meta_symbol});
    if (!data.present || !meta.present || !mal_value_is_array_buffer_object(data.desc.value)
        || !mal_ops_is_number(meta.desc.value)) goto illegal;
    *buffer = mal_value_to_array_buffer_object(data.desc.value);
    f64 packed = mal_ops_number_as_f64(meta.desc.value);
    if (packed < 0) {
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Not initialised", "ERR_CRYPTO_INVALID_STATE");
        return false;
    }
    *used = (usize) (packed / 4);
    *hash = (u32) (packed - (f64) *used * 4);
    return true;
illegal:
    crypto_throw(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Illegal invocation");
    return false;
}

static void crypto_signer_set(MalVm *vm, MalValue receiver, MalValue symbol, MalValue value) {
    (void) vm;
    mal_object_set(mal_value_to_object(receiver), (MalKey) {.kind = MAL_KEY_SYMBOL, .value = symbol}, value);
}

static MalValue mal_node_crypto_signer_update(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee);

/* Sign and Verify are node:stream Writables whose _write feeds update(), as in Node. */
static MalValue crypto_new_signer(MalVm *vm, MalValue prototype, MalValue algorithm, MalValue options) {
    u32 hash;
    if (!crypto_sign_hash(vm, algorithm, &hash)) return mal_value_new_undefined();
    MalValue roots[] = {options, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalCompletion stream = mal_vm_construct_value(vm, vm->intrinsics[MAL_INTRINSIC_NODE_WRITABLE_CONSTRUCTOR],
        &roots[0], mal_value_is_undefined(options) ? 0 : 1);
    if (stream.kind == MAL_COMPLETION_THROW) {
        vm->completion = stream;
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    roots[1] = stream.value;
    mal_object_set_prototype(mal_value_to_object(roots[1]), mal_value_to_object(prototype));
    byte *storage = malloc(64);
    if (storage == nullptr) {
        mal_gc_unroot(&root);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    roots[2] = mal_value_from_array_buffer_object(mal_array_buffer_object_adopt(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]), storage, 64, false));
    crypto_signer_set(vm, roots[1], crypto_pkey_symbol, roots[2]);
    crypto_signer_set(vm, roots[1], crypto_signer_meta_symbol, mal_ops_number_value((f64) hash));
    mal_gc_unroot(&root);
    return roots[1];
}

static MalValue mal_node_crypto_create_sign(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    return crypto_new_signer(vm, crypto_sign_prototype, argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined());
}

static MalValue mal_node_crypto_create_verify(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    return crypto_new_signer(vm, crypto_verify_prototype, argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined());
}

static MalValue mal_node_crypto_signer_write(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    MalValue callback = argc > 2 ? args[2] : mal_value_new_undefined();
    MalValue update_args[] = {argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined()};
    mal_node_crypto_signer_update(vm, receiver, update_args, 2, new_target, callee);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        if (!mal_value_is_callable(callback)) return mal_value_new_undefined();
        MalValue error = vm->completion.value;
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        MalRootSpan root;
        mal_gc_root(&root, &error, 1);
        MalCompletion called = mal_vm_call_value(vm, callback, mal_value_new_undefined(), &error, 1);
        mal_gc_unroot(&root);
        if (called.kind == MAL_COMPLETION_THROW) vm->completion = called;
        return mal_value_new_undefined();
    }
    if (mal_value_is_callable(callback)) {
        MalCompletion called = mal_vm_call_value(vm, callback, mal_value_new_undefined(), nullptr, 0);
        if (called.kind == MAL_COMPLETION_THROW) vm->completion = called;
    }
    return mal_value_new_undefined();
}

static MalValue mal_node_crypto_signer_update(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    MalArrayBufferObject *buffer;
    usize used;
    u32 hash;
    if (!crypto_signer_state(vm, receiver, &buffer, &used, &hash)) return mal_value_new_undefined();
    byte *bytes;
    usize length;
    if (!crypto_input_bytes(vm, argc > 0 ? args[0] : mal_value_new_undefined(),
            argc > 1 ? args[1] : mal_value_new_undefined(), "data", &bytes, &length)) return mal_value_new_undefined();
    if (used + length > buffer->byte_length) {
        usize capacity = buffer->byte_length;
        while (capacity < used + length) capacity *= 2;
        if (capacity > UINT32_MAX) { free(bytes); mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
        byte *grown = malloc(capacity);
        if (grown == nullptr) { free(bytes); mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
        memcpy(grown, buffer->data, used);
        MalValue replacement = mal_value_from_array_buffer_object(mal_array_buffer_object_adopt(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]), grown, (u32) capacity, false));
        crypto_signer_set(vm, receiver, crypto_pkey_symbol, replacement);
        buffer = mal_value_to_array_buffer_object(replacement);
    }
    if (length > 0) memcpy(buffer->data + used, bytes, length);
    free(bytes);
    crypto_signer_set(vm, receiver, crypto_signer_meta_symbol, mal_ops_number_value((f64) (used + length) * 4 + hash));
    return receiver;
}

static MalValue mal_node_crypto_signer_sign(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    MalArrayBufferObject *buffer;
    usize used;
    u32 hash;
    if (!crypto_signer_state(vm, receiver, &buffer, &used, &hash)) return mal_value_new_undefined();
    MalValue result = crypto_sign_with(vm, hash, buffer->data, used, argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined());
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        crypto_signer_set(vm, receiver, crypto_signer_meta_symbol, mal_ops_number_value(-1));
    }
    return result;
}

static MalValue mal_node_crypto_signer_verify(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    MalArrayBufferObject *buffer;
    usize used;
    u32 hash;
    if (!crypto_signer_state(vm, receiver, &buffer, &used, &hash)) return mal_value_new_undefined();
    MalValue result = crypto_verify_with(vm, hash, buffer->data, used, argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined(), argc > 2 ? args[2] : mal_value_new_undefined());
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        crypto_signer_set(vm, receiver, crypto_signer_meta_symbol, mal_ops_number_value(-1));
    }
    return result;
}

static bool crypto_one_shot_hash(MalVm *vm, MalValue algorithm, u32 *hash) {
    if (mal_value_is_undefined(algorithm) || mal_value_is_null(algorithm)) {
        *hash = MAL_PKEY_HASH_NONE;
        return true;
    }
    return crypto_sign_hash(vm, algorithm, hash);
}

static MalValue mal_node_crypto_sign_one_shot(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    u32 hash;
    if (!crypto_one_shot_hash(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &hash)) {
        return mal_value_new_undefined();
    }
    MalValue data = argc > 1 ? args[1] : mal_value_new_undefined();
    if (!crypto_is_byte_source(data)) {
        crypto_throw_arg_type(vm, "data", "an instance of Buffer, TypedArray, or DataView", data);
        return mal_value_new_undefined();
    }
    byte *bytes;
    usize length;
    if (!crypto_input_bytes(vm, data, mal_value_new_undefined(), "data", &bytes, &length)) {
        return mal_value_new_undefined();
    }
    MalValue result = crypto_sign_with(vm, hash, bytes, length, argc > 2 ? args[2] : mal_value_new_undefined(),
        mal_value_new_undefined());
    free(bytes);
    return result;
}

static MalValue mal_node_crypto_verify_one_shot(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    u32 hash;
    if (!crypto_one_shot_hash(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &hash)) {
        return mal_value_new_undefined();
    }
    MalValue data = argc > 1 ? args[1] : mal_value_new_undefined();
    MalValue signature = argc > 3 ? args[3] : mal_value_new_undefined();
    if (!crypto_is_byte_source(data)) {
        crypto_throw_arg_type(vm, "data", "an instance of ArrayBuffer, Buffer, TypedArray, or DataView", data);
        return mal_value_new_undefined();
    }
    if (!crypto_is_byte_source(signature)) {
        crypto_throw_arg_type(vm, "signature", "an instance of ArrayBuffer, Buffer, TypedArray, or DataView",
            signature);
        return mal_value_new_undefined();
    }
    byte *bytes;
    usize length;
    if (!crypto_input_bytes(vm, data, mal_value_new_undefined(), "data", &bytes, &length)) {
        return mal_value_new_undefined();
    }
    MalValue result = crypto_verify_with(vm, hash, bytes, length, argc > 2 ? args[2] : mal_value_new_undefined(),
        signature, mal_value_new_undefined());
    free(bytes);
    return result;
}

static MalValue crypto_encode_generated(MalVm *vm, MalValue key, MalValue encoding, const char *name) {
    if (mal_value_is_undefined(encoding)) return key;
    if (!mal_value_is_object(encoding)) {
        char property[48];
        snprintf(property, sizeof(property), "options.%s", name);
        crypto_throw_property_type(vm, property, "of type object", encoding);
        return mal_value_new_undefined();
    }
    MalRootSpan root;
    mal_gc_root(&root, &key, 1);
    MalValue result = mal_node_crypto_pkey_export(vm, key, &encoding, 1, mal_value_new_undefined(),
        mal_value_new_undefined());
    mal_gc_unroot(&root);
    return result;
}

static MalValue mal_node_crypto_generate_key_pair_sync(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue type = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue options = argc > 1 ? args[1] : mal_value_new_undefined();
    if (!mal_value_is_string(type)) {
        crypto_throw_arg_type(vm, "type", "of type string", type);
        return mal_value_new_undefined();
    }
    u32 kind;
    if (crypto_string_is(type, "ed25519")) {
        kind = MAL_PKEY_ED25519;
    } else if (crypto_string_is(type, "ec")) {
        MalValue curve;
        if (!crypto_option(vm, options, "namedCurve", &curve)) return mal_value_new_undefined();
        if (!mal_value_is_string(curve)) {
            crypto_throw_property_type(vm, "options.namedCurve", "of type string", curve);
            return mal_value_new_undefined();
        }
        if (crypto_string_is(curve, "P-256") || crypto_string_is(curve, "prime256v1")) kind = MAL_PKEY_EC_P256;
        else if (crypto_string_is(curve, "P-384") || crypto_string_is(curve, "secp384r1")) kind = MAL_PKEY_EC_P384;
        else {
            mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid EC curve name",
                "ERR_CRYPTO_INVALID_CURVE");
            return mal_value_new_undefined();
        }
    } else if (crypto_string_is(type, "rsa") || crypto_string_is(type, "rsa-pss")) {
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "RSA key generation is not supported by this host",
            "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM");
        return mal_value_new_undefined();
    } else {
        char name[64];
        crypto_copy_string(mal_value_to_string(type), name, sizeof(name));
        char message[CRYPTO_MESSAGE_CAPACITY];
        snprintf(message, sizeof(message), "The argument 'type' must be a supported key type. Received '%s'", name);
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_VALUE");
        return mal_value_new_undefined();
    }
    MalValue roots[] = {mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    if (!crypto_option(vm, options, "publicKeyEncoding", &roots[3])
        || !crypto_option(vm, options, "privateKeyEncoding", &roots[4])) goto done;
    MalPkey *private_key = nullptr;
    i32 status = mal_pkey_generate(kind, &private_key);
    if (status != MAL_PKEY_OK) { crypto_throw_pkey_status(vm, status); goto done; }
    MalPkey *public_key = nullptr;
    status = mal_pkey_public(private_key, &public_key);
    if (status != MAL_PKEY_OK) { mal_pkey_free(private_key); crypto_throw_pkey_status(vm, status); goto done; }
    roots[1] = crypto_new_pkey_object(vm, private_key);
    if (vm->completion.kind == MAL_COMPLETION_THROW) { mal_pkey_free(public_key); goto done; }
    roots[0] = crypto_new_pkey_object(vm, public_key);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    roots[0] = crypto_encode_generated(vm, roots[0], roots[3], "publicKeyEncoding");
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    roots[1] = crypto_encode_generated(vm, roots[1], roots[4], "privateKeyEncoding");
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    roots[2] = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), (const byte *) "publicKey", roots[0], flags);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), (const byte *) "privateKey", roots[1], flags);
    result = roots[2];
done:
    mal_gc_unroot(&root);
    return result;
}

static MalValue mal_node_crypto_generate_key_pair(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    MalValue call_args[2] = {argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined()};
    MalValue callback = argc > 2 ? args[2] : mal_value_new_undefined();
    if (mal_value_is_callable(call_args[1]) && argc < 3) {
        callback = call_args[1];
        call_args[1] = mal_value_new_undefined();
    }
    if (!mal_value_is_callable(callback)) {
        crypto_throw_arg_type(vm, "callback", "of type function", callback);
        return mal_value_new_undefined();
    }
    if (!crypto_require_host(vm)) return mal_value_new_undefined();
    MalValue roots[] = {callback, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    // Validation errors throw synchronously, as Node's do; generation itself is cheap enough for the caller's thread.
    roots[1] = mal_node_crypto_generate_key_pair_sync(vm, receiver, call_args, 2, new_target, callee);
    if (vm->completion.kind == MAL_COMPLETION_THROW) { mal_gc_unroot(&root); return mal_value_new_undefined(); }
    CryptoImmediateResult *result = calloc(1, sizeof(CryptoImmediateResult));
    MalNodeCryptoAsync *state = crypto_async_new(vm, CRYPTO_ASYNC_KEY_PAIR, roots[0]);
    if (result == nullptr || state == nullptr) {
        free(result);
        free(state);
        mal_gc_unroot(&root);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    state->value = roots[1];
    if (!crypto_complete_immediately(vm, state, result)) {
        crypto_immediate_destroy(result);
        free(state);
        crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Crypto operation failed");
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

/* Asymmetric CryptoKeys store this marker byte, then the key's canonical PKCS#8 or SPKI DER. */
#define CRYPTO_WEB_PRIVATE 0x90
#define CRYPTO_WEB_PUBLIC 0x91

static CryptoWebAsym crypto_web_asym(MalVm *vm, MalValue algorithm, bool *ok) {
    *ok = true;
    MalValue name = mal_value_is_object(algorithm) ? crypto_get(vm, algorithm, "name", ok) : algorithm;
    if (!*ok || !mal_value_is_string(name)) return CRYPTO_WEB_NONE;
    static const struct { const char *name; CryptoWebAsym kind; } names[] = {
        {"RSASSA-PKCS1-v1_5", CRYPTO_WEB_RSASSA}, {"RSA-PSS", CRYPTO_WEB_RSA_PSS},
        {"ECDSA", CRYPTO_WEB_ECDSA}, {"Ed25519", CRYPTO_WEB_ED25519}};
    for (usize i = 0; i < countof(names); i++) {
        if (mal_string_equals_ascii_ci(mal_value_to_string(name), names[i].name)) return names[i].kind;
    }
    return CRYPTO_WEB_NONE;
}

static const char *crypto_web_asym_name(CryptoWebAsym kind) {
    switch (kind) {
        case CRYPTO_WEB_RSASSA: return "RSASSA-PKCS1-v1_5";
        case CRYPTO_WEB_RSA_PSS: return "RSA-PSS";
        case CRYPTO_WEB_ECDSA: return "ECDSA";
        default: return "Ed25519";
    }
}

/* `hash` as a string or `{name}` inside `parameters`. */
static bool crypto_web_param_hash(MalVm *vm, MalValue parameters, MalNodeCryptoStateKind *kind) {
    bool ok = true;
    MalValue hash = crypto_get(vm, parameters, "hash", &ok);
    if (!ok) return false;
    if (mal_value_is_object(hash)) hash = crypto_get(vm, hash, "name", &ok);
    return ok && crypto_web_hash(hash, kind);
}

static u32 crypto_web_pkey_hash(MalNodeCryptoStateKind kind) {
    return kind == MAL_NODE_CRYPTO_SHA384 ? MAL_PKEY_HASH_SHA384
        : kind == MAL_NODE_CRYPTO_SHA512 ? MAL_PKEY_HASH_SHA512 : MAL_PKEY_HASH_SHA256;
}

/* Consumes `key`; `hash` matters for the RSA algorithms only. */
static MalValue crypto_web_asym_key(MalVm *vm, MalPkey *key, CryptoWebAsym algorithm, MalNodeCryptoStateKind hash,
    bool extractable, MalValue usages) {
    bool private_key = mal_pkey_is_private(key);
    u32 kind = mal_pkey_kind(key);
    u32 bits = mal_pkey_modulus_bits(key);
    u8 exponent[16];
    usize exponent_length = 0;
    if (kind == MAL_PKEY_RSA) (void) mal_pkey_jwk_field(key, 1, exponent, sizeof(exponent), &exponent_length);
    byte *der;
    usize length;
    bool exported = crypto_pkey_export_bytes(vm, key, MAL_PKEY_FORMAT_DER,
        private_key ? MAL_PKEY_TYPE_PKCS8 : MAL_PKEY_TYPE_SPKI, private_key, &der, &length);
    mal_pkey_free(key);
    if (!exported) return mal_value_new_undefined();
    byte *stored = malloc(length + 1);
    if (stored == nullptr) { crypto_scrub_free(der, length); mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
    stored[0] = (byte) (private_key ? CRYPTO_WEB_PRIVATE : CRYPTO_WEB_PUBLIC);
    memcpy(stored + 1, der, length);
    crypto_scrub_free(der, length);
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), usages, mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    crypto_set(vm, roots[0], "name", mal_value_from_string(mal_intrinsic_ascii(vm,
        (const byte *) crypto_web_asym_name(algorithm))));
    if (kind == MAL_PKEY_RSA) {
        crypto_set(vm, roots[0], "modulusLength", mal_ops_number_value((f64) bits));
        byte *copy = malloc(exponent_length > 0 ? exponent_length : 1);
        if (copy != nullptr) {
            memcpy(copy, exponent, exponent_length);
            roots[2] = mal_node_buffer_from_owned_bytes(vm, copy, exponent_length);
            crypto_set(vm, roots[0], "publicExponent", roots[2]);
        }
        roots[2] = mal_value_from_object(mal_intrinsic_new_object(vm));
        crypto_set(vm, roots[2], "name", mal_value_from_string(mal_intrinsic_ascii(vm,
            (const byte *) crypto_web_hash_name(hash))));
        crypto_set(vm, roots[0], "hash", roots[2]);
    } else if (kind != MAL_PKEY_ED25519) {
        crypto_set(vm, roots[0], "namedCurve", mal_value_from_string(mal_intrinsic_ascii(vm,
            (const byte *) (kind == MAL_PKEY_EC_P256 ? "P-256" : "P-384"))));
    }
    roots[3] = crypto_web_new_key(vm, stored, length + 1, roots[0], extractable, roots[1]);
    crypto_set(vm, roots[3], "type", mal_value_from_string(mal_intrinsic_ascii(vm,
        (const byte *) (private_key ? "private" : "public"))));
    mal_gc_unroot(&root);
    return roots[3];
}

static MalArrayBufferObject *crypto_web_stored(MalValue key) {
    if (!mal_value_is_object(key) || !mal_value_is_symbol(crypto_crypto_key_symbol)) return nullptr;
    MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(key),
        (MalKey) {.kind = MAL_KEY_SYMBOL, .value = crypto_crypto_key_symbol});
    if (!lookup.present || !mal_value_is_array_buffer_object(lookup.desc.value)) return nullptr;
    MalArrayBufferObject *stored = mal_value_to_array_buffer_object(lookup.desc.value);
    return stored->byte_length > 0 ? stored : nullptr;
}

static bool crypto_web_is_asym_key(MalValue key) {
    MalArrayBufferObject *stored = crypto_web_stored(key);
    return stored != nullptr && ((u8) stored->data[0] == CRYPTO_WEB_PRIVATE || (u8) stored->data[0] == CRYPTO_WEB_PUBLIC);
}

static MalPkey *crypto_web_pkey(MalValue key) {
    MalArrayBufferObject *stored = crypto_web_stored(key);
    if (stored == nullptr) return nullptr;
    bool private_key = (u8) stored->data[0] == CRYPTO_WEB_PRIVATE;
    MalPkey *handle = nullptr;
    if (mal_pkey_import((const u8 *) stored->data + 1, stored->byte_length - 1, MAL_PKEY_FORMAT_DER,
            private_key ? MAL_PKEY_TYPE_PKCS8 : MAL_PKEY_TYPE_SPKI, private_key, &handle) != MAL_PKEY_OK) return nullptr;
    return handle;
}

static MalPkey *crypto_web_import_material(MalVm *vm, MalValue format, MalValue data, CryptoWebAsym algorithm,
    MalValue parameters) {
    if (crypto_string_is(format, "jwk")) {
        MalValue d;
        if (!crypto_option(vm, data, "d", &d)) return nullptr;
        return crypto_pkey_from_jwk(vm, data, !mal_value_is_undefined(d));
    }
    MalBufferSourceSpan span;
    if (!crypto_is_byte_source(data) || mal_buffer_source_span(data, &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The \"keyData\" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.",
            "ERR_INVALID_ARG_TYPE");
        return nullptr;
    }
    MalPkey *key = nullptr;
    i32 status = MAL_PKEY_INVALID_ARGUMENT;
    if (crypto_string_is(format, "spki")) {
        status = mal_pkey_import((const u8 *) span.data, span.length, MAL_PKEY_FORMAT_DER, MAL_PKEY_TYPE_SPKI, false, &key);
    } else if (crypto_string_is(format, "pkcs8")) {
        status = mal_pkey_import((const u8 *) span.data, span.length, MAL_PKEY_FORMAT_DER, MAL_PKEY_TYPE_PKCS8, true, &key);
    } else if (crypto_string_is(format, "raw") && (algorithm == CRYPTO_WEB_ECDSA || algorithm == CRYPTO_WEB_ED25519)) {
        const u8 *parts[8] = {0};
        usize lengths[8] = {0};
        u32 kind = MAL_PKEY_ED25519;
        if (algorithm == CRYPTO_WEB_ECDSA) {
            MalValue curve;
            if (!crypto_option(vm, parameters, "namedCurve", &curve)) return nullptr;
            kind = crypto_string_is(curve, "P-384") ? MAL_PKEY_EC_P384 : MAL_PKEY_EC_P256;
            usize size = kind == MAL_PKEY_EC_P256 ? 32 : 48;
            if (span.length == 1 + 2 * size && span.data[0] == 4) {
                parts[0] = (const u8 *) span.data + 1;
                lengths[0] = size;
                parts[1] = (const u8 *) span.data + 1 + size;
                lengths[1] = size;
            }
        } else {
            parts[0] = (const u8 *) span.data;
            lengths[0] = span.length;
        }
        status = mal_pkey_import_jwk(kind, parts, lengths, 8, false, &key);
    } else {
        mal_dom_exception_throw(vm, (const byte *) "Unsupported key format", (const byte *) "NotSupportedError");
        return nullptr;
    }
    if (status != MAL_PKEY_OK) {
        mal_dom_exception_throw(vm, (const byte *) "Invalid keyData", (const byte *) "DataError");
        return nullptr;
    }
    return key;
}

static bool crypto_web_kind_matches(u32 kind, CryptoWebAsym algorithm) {
    switch (algorithm) {
        case CRYPTO_WEB_RSASSA: case CRYPTO_WEB_RSA_PSS: return kind == MAL_PKEY_RSA;
        case CRYPTO_WEB_ECDSA: return kind == MAL_PKEY_EC_P256 || kind == MAL_PKEY_EC_P384;
        case CRYPTO_WEB_ED25519: return kind == MAL_PKEY_ED25519;
        default: return false;
    }
}

/* Settles `promise` with a CryptoKey made from `key` (consumed), or rejects. */
static void crypto_web_settle_key(MalVm *vm, MalValue promise, MalPkey *key, CryptoWebAsym algorithm,
    MalValue parameters, bool extractable, MalValue usages) {
    MalNodeCryptoStateKind hash = MAL_NODE_CRYPTO_SHA256;
    if (algorithm == CRYPTO_WEB_RSASSA || algorithm == CRYPTO_WEB_RSA_PSS) {
        if (!crypto_web_param_hash(vm, parameters, &hash)) {
            mal_pkey_free(key);
            if (vm->completion.kind != MAL_COMPLETION_THROW) {
                mal_dom_exception_throw(vm, (const byte *) "Unrecognized hash", (const byte *) "NotSupportedError");
            }
            crypto_settle_with_completion(vm, promise);
            return;
        }
    }
    if (!crypto_web_kind_matches(mal_pkey_kind(key), algorithm)) {
        mal_pkey_free(key);
        crypto_web_reject_dom(vm, promise, "Invalid key type", "DataError");
        return;
    }
    MalValue value = crypto_web_asym_key(vm, key, algorithm, hash, extractable, usages);
    if (vm->completion.kind == MAL_COMPLETION_THROW) { crypto_settle_with_completion(vm, promise); return; }
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    mal_promise_fulfill(vm, mal_value_to_promise_object(promise), value);
    mal_gc_unroot(&root);
}

static void crypto_web_import_asym(MalVm *vm, MalValue promise, CryptoWebAsym algorithm, const MalValue *args,
    i32 argc) {
    MalValue format = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue parameters = argc > 2 ? args[2] : mal_value_new_undefined();
    MalPkey *key = crypto_web_import_material(vm, format, argc > 1 ? args[1] : mal_value_new_undefined(), algorithm,
        parameters);
    if (key == nullptr) { crypto_settle_with_completion(vm, promise); return; }
    crypto_web_settle_key(vm, promise, key, algorithm, parameters,
        argc > 3 && mal_value_is_truthy(args[3]), argc > 4 ? args[4] : mal_value_new_undefined());
}

/* subtle.sign/verify for asymmetric keys; `signature` is undefined when signing. */
static void crypto_web_sign_asym(MalVm *vm, MalValue promise, CryptoWebAsym algorithm, MalValue parameters,
    MalValue key_value, MalValue data, MalValue signature) {
    MalPkey *key = crypto_web_pkey(key_value);
    if (key == nullptr) { crypto_web_reject_dom(vm, promise, "Invalid key", "InvalidAccessError"); return; }
    bool ok = true;
    MalValue key_algorithm = crypto_get(vm, key_value, "algorithm", &ok);
    if (!ok || crypto_web_asym(vm, key_algorithm, &ok) != algorithm) {
        mal_pkey_free(key);
        if (!ok) crypto_settle_with_completion(vm, promise);
        else crypto_web_reject_dom(vm, promise, "Key algorithm mismatch", "InvalidAccessError");
        return;
    }
    MalNodeCryptoStateKind hash_kind = MAL_NODE_CRYPTO_SHA256;
    u32 hash = MAL_PKEY_HASH_NONE;
    u32 padding = algorithm == CRYPTO_WEB_RSA_PSS ? MAL_PKEY_PADDING_PSS : MAL_PKEY_PADDING_PKCS1;
    i32 salt = -1;
    if (algorithm == CRYPTO_WEB_ECDSA) {
        if (!crypto_web_param_hash(vm, parameters, &hash_kind)) {
            mal_pkey_free(key);
            if (vm->completion.kind != MAL_COMPLETION_THROW) {
                mal_dom_exception_throw(vm, (const byte *) "Unrecognized hash", (const byte *) "NotSupportedError");
            }
            crypto_settle_with_completion(vm, promise);
            return;
        }
        hash = crypto_web_pkey_hash(hash_kind);
    } else if (algorithm != CRYPTO_WEB_ED25519) {
        (void) crypto_web_param_hash(vm, key_algorithm, &hash_kind);
        hash = crypto_web_pkey_hash(hash_kind);
        if (algorithm == CRYPTO_WEB_RSA_PSS) {
            MalValue salt_value = crypto_get(vm, parameters, "saltLength", &ok);
            if (mal_ops_is_number(salt_value)) salt = (i32) mal_ops_number_as_f64(salt_value);
        }
    }
    MalBufferSourceSpan span;
    if (!crypto_is_byte_source(data) || mal_buffer_source_span(data, &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
        mal_pkey_free(key);
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The \"data\" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.",
            "ERR_INVALID_ARG_TYPE");
        crypto_settle_with_completion(vm, promise);
        return;
    }
    if (!mal_value_is_undefined(signature)) {
        MalBufferSourceSpan sig;
        if (!crypto_is_byte_source(signature) || mal_buffer_source_span(signature, &sig) != MAL_BUFFER_SOURCE_SPAN_OK) {
            mal_pkey_free(key);
            mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "The \"signature\" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.",
                "ERR_INVALID_ARG_TYPE");
            crypto_settle_with_completion(vm, promise);
            return;
        }
        i32 status = mal_pkey_verify(key, hash, padding, salt, algorithm == CRYPTO_WEB_ECDSA,
            (const u8 *) span.data, span.length, (const u8 *) sig.data, sig.length);
        mal_pkey_free(key);
        if (status != MAL_PKEY_OK && status != MAL_PKEY_BAD_SIGNATURE) {
            crypto_web_reject_dom(vm, promise, "Unsupported operation", "NotSupportedError");
            return;
        }
        mal_promise_fulfill(vm, mal_value_to_promise_object(promise), mal_value_new_boolean(status == MAL_PKEY_OK));
        return;
    }
    if (!mal_pkey_is_private(key)) {
        mal_pkey_free(key);
        crypto_web_reject_dom(vm, promise, "Unable to use this key to sign", "InvalidAccessError");
        return;
    }
    u8 out[1024];
    usize written = 0;
    i32 status = mal_pkey_sign(key, hash, padding, salt, algorithm == CRYPTO_WEB_ECDSA, (const u8 *) span.data,
        span.length, out, sizeof(out), &written);
    mal_pkey_free(key);
    if (status != MAL_PKEY_OK) { crypto_web_reject_dom(vm, promise, "Unsupported operation", "NotSupportedError"); return; }
    byte *copy = malloc(written > 0 ? written : 1);
    if (copy == nullptr) { mal_vm_throw_allocation_error(vm); crypto_settle_with_completion(vm, promise); return; }
    memcpy(copy, out, written);
    MalValue buffer = mal_value_from_array_buffer_object(mal_array_buffer_object_adopt(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]), copy, (u32) written, false));
    MalRootSpan root;
    mal_gc_root(&root, &buffer, 1);
    mal_promise_fulfill(vm, mal_value_to_promise_object(promise), buffer);
    mal_gc_unroot(&root);
}

static MalValue mal_node_crypto_subtle_export_key(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue roots[] = {crypto_new_promise(vm), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue format = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue key_value = argc > 1 ? args[1] : mal_value_new_undefined();
    MalPkey *key = crypto_web_is_asym_key(key_value) ? crypto_web_pkey(key_value) : nullptr;
    bool ok = true;
    MalValue extractable = key == nullptr ? mal_value_new_undefined() : crypto_get(vm, key_value, "extractable", &ok);
    MalArrayBufferObject *secret = key == nullptr ? crypto_web_stored(key_value) : nullptr;
    if (secret != nullptr && crypto_string_is(format, "raw")) {
        extractable = crypto_get(vm, key_value, "extractable", &ok);
        if (!ok) {
            crypto_settle_with_completion(vm, roots[0]);
        } else if (!mal_value_is_truthy(extractable)) {
            crypto_web_reject_dom(vm, roots[0], "key is not extractable", "InvalidAccessError");
        } else {
            secret = crypto_web_stored(key_value);
            usize length = secret == nullptr ? 0 : secret->byte_length - 1;
            byte *copy = malloc(length > 0 ? length : 1);
            if (copy == nullptr) {
                mal_vm_throw_allocation_error(vm);
                crypto_settle_with_completion(vm, roots[0]);
            } else {
                if (length > 0) memcpy(copy, secret->data + 1, length);
                roots[1] = mal_value_from_array_buffer_object(mal_array_buffer_object_adopt(&vm->heap,
                    mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]), copy, (u32) length,
                    true));
                mal_promise_fulfill(vm, mal_value_to_promise_object(roots[0]), roots[1]);
            }
        }
    } else if (key == nullptr) {
        crypto_web_reject_dom(vm, roots[0], "Unsupported key for export", "NotSupportedError");
    } else if (!ok || !mal_value_is_truthy(extractable)) {
        mal_pkey_free(key);
        if (!ok) crypto_settle_with_completion(vm, roots[0]);
        else crypto_web_reject_dom(vm, roots[0], "key is not extractable", "InvalidAccessError");
    } else if (crypto_string_is(format, "jwk")) {
        roots[1] = crypto_pkey_jwk(vm, key);
        mal_pkey_free(key);
        MalValue usages = crypto_get(vm, key_value, "usages", &ok);
        if (mal_value_is_array_object(usages)) {
            MalArrayObject *source = mal_value_to_array_object(usages);
            MalValue copied = mal_value_from_array_object(mal_array_object_new_from_values(&vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), source->elements,
                source->elements == nullptr ? 0 : source->dense_count));
            MalRootSpan copied_root;
            mal_gc_root(&copied_root, &copied, 1);
            crypto_set(vm, roots[1], "key_ops", copied);
            mal_gc_unroot(&copied_root);
        }
        crypto_set(vm, roots[1], "ext", mal_value_new_boolean(true));
        mal_promise_fulfill(vm, mal_value_to_promise_object(roots[0]), roots[1]);
    } else if (crypto_string_is(format, "raw") && !mal_pkey_is_private(key) && mal_pkey_kind(key) != MAL_PKEY_RSA) {
        u8 point[97];
        usize length = 0;
        usize x_length = 0;
        usize y_length = 0;
        bool ed25519 = mal_pkey_kind(key) == MAL_PKEY_ED25519;
        if (!ed25519) point[length++] = 4;
        (void) mal_pkey_jwk_field(key, 0, point + length, sizeof(point) - length, &x_length);
        length += x_length;
        if (!ed25519) {
            (void) mal_pkey_jwk_field(key, 1, point + length, sizeof(point) - length, &y_length);
            length += y_length;
        }
        mal_pkey_free(key);
        byte *copy = malloc(length);
        if (copy == nullptr) {
            mal_vm_throw_allocation_error(vm);
            crypto_settle_with_completion(vm, roots[0]);
        } else {
            memcpy(copy, point, length);
            roots[1] = mal_value_from_array_buffer_object(mal_array_buffer_object_adopt(&vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]), copy, (u32) length, false));
            mal_promise_fulfill(vm, mal_value_to_promise_object(roots[0]), roots[1]);
        }
    } else {
        bool private_key = mal_pkey_is_private(key);
        bool spki = crypto_string_is(format, "spki");
        if ((spki && private_key) || (!spki && (!crypto_string_is(format, "pkcs8") || !private_key))) {
            mal_pkey_free(key);
            crypto_web_reject_dom(vm, roots[0], "Unsupported export format for this key", "InvalidAccessError");
        } else {
            byte *der;
            usize length;
            bool exported = crypto_pkey_export_bytes(vm, key, MAL_PKEY_FORMAT_DER,
                spki ? MAL_PKEY_TYPE_SPKI : MAL_PKEY_TYPE_PKCS8, private_key, &der, &length);
            mal_pkey_free(key);
            if (!exported) {
                crypto_settle_with_completion(vm, roots[0]);
            } else {
                roots[1] = mal_value_from_array_buffer_object(mal_array_buffer_object_adopt(&vm->heap,
                    mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]), der, (u32) length,
                    private_key));
                mal_promise_fulfill(vm, mal_value_to_promise_object(roots[0]), roots[1]);
            }
        }
    }
    mal_gc_unroot(&root);
    return roots[0];
}

static bool crypto_web_usage_has(MalValue usages, const char *name) {
    if (!mal_value_is_array_object(usages)) return false;
    MalArrayObject *array = mal_value_to_array_object(usages);
    for (u32 i = 0; i < mal_array_object_length(array); i++) {
        MalValue entry;
        if (mal_array_object_dense_get(array, i, &entry) && crypto_string_is(entry, name)) return true;
    }
    return false;
}

static void crypto_web_split_usages(MalVm *vm, MalValue public_key, MalValue private_key, MalValue usages) {
    MalValue roots[] = {public_key, private_key, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *array_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]);
    roots[2] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "verify"));
    roots[3] = mal_value_from_array_object(mal_array_object_new_from_values(&vm->heap, array_prototype, &roots[2],
        crypto_web_usage_has(usages, "verify") ? 1 : 0));
    crypto_set(vm, roots[0], "usages", roots[3]);
    roots[2] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "sign"));
    roots[3] = mal_value_from_array_object(mal_array_object_new_from_values(&vm->heap, array_prototype, &roots[2],
        crypto_web_usage_has(usages, "sign") ? 1 : 0));
    crypto_set(vm, roots[1], "usages", roots[3]);
    mal_gc_unroot(&root);
}

static MalValue mal_node_crypto_subtle_generate_key(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue parameters = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue roots[] = {crypto_new_promise(vm), mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool ok = true;
    CryptoWebAsym algorithm = crypto_web_asym(vm, parameters, &ok);
    u32 kind = MAL_PKEY_ED25519;
    if (algorithm == CRYPTO_WEB_ECDSA) {
        MalValue curve = crypto_get(vm, parameters, "namedCurve", &ok);
        kind = crypto_string_is(curve, "P-384") ? MAL_PKEY_EC_P384
            : crypto_string_is(curve, "P-256") ? MAL_PKEY_EC_P256 : 0;
    }
    MalPkey *private_key = nullptr;
    MalPkey *public_key = nullptr;
    if (!ok) {
        crypto_settle_with_completion(vm, roots[0]);
    } else if ((algorithm != CRYPTO_WEB_ECDSA && algorithm != CRYPTO_WEB_ED25519) || kind == 0) {
        crypto_web_reject_dom(vm, roots[0], "Unrecognized algorithm name", "NotSupportedError");
    } else if (mal_pkey_generate(kind, &private_key) != MAL_PKEY_OK
        || mal_pkey_public(private_key, &public_key) != MAL_PKEY_OK) {
        mal_pkey_free(private_key);
        crypto_web_reject_dom(vm, roots[0], "Key generation failed", "OperationError");
    } else {
        MalValue usages = argc > 2 ? args[2] : mal_value_new_undefined();
        bool extractable = argc > 1 && mal_value_is_truthy(args[1]);
        // Node splits the requested usages: verify on the public key, sign on the private one.
        roots[1] = crypto_web_asym_key(vm, public_key, algorithm, MAL_NODE_CRYPTO_SHA256, true,
            mal_value_from_array_object(mal_array_object_new_from_values(&vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), nullptr, 0)));
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            roots[2] = crypto_web_asym_key(vm, private_key, algorithm, MAL_NODE_CRYPTO_SHA256, extractable,
                mal_value_from_array_object(mal_array_object_new_from_values(&vm->heap,
                    mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), nullptr, 0)));
        } else {
            mal_pkey_free(private_key);
        }
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            crypto_settle_with_completion(vm, roots[0]);
        } else {
            crypto_web_split_usages(vm, roots[1], roots[2], usages);
            roots[3] = mal_value_from_object(mal_intrinsic_new_object(vm));
            crypto_set(vm, roots[3], "publicKey", roots[1]);
            crypto_set(vm, roots[3], "privateKey", roots[2]);
            mal_promise_fulfill(vm, mal_value_to_promise_object(roots[0]), roots[3]);
        }
    }
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue mal_node_crypto_pkey_to_crypto_key(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    MalPkey *key = crypto_receiver_pkey(vm, receiver);
    if (key == nullptr) return mal_value_new_undefined();
    MalValue parameters = argc > 0 ? args[0] : mal_value_new_undefined();
    bool ok = true;
    CryptoWebAsym algorithm = crypto_web_asym(vm, parameters, &ok);
    MalNodeCryptoStateKind hash = MAL_NODE_CRYPTO_SHA256;
    bool rsa = algorithm == CRYPTO_WEB_RSASSA || algorithm == CRYPTO_WEB_RSA_PSS;
    if (!ok || algorithm == CRYPTO_WEB_NONE || !crypto_web_kind_matches(mal_pkey_kind(key), algorithm)
        || (rsa && !crypto_web_param_hash(vm, parameters, &hash))) {
        mal_pkey_free(key);
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_dom_exception_throw(vm, (const byte *) "Unrecognized algorithm name", (const byte *) "NotSupportedError");
        }
        return mal_value_new_undefined();
    }
    return crypto_web_asym_key(vm, key, algorithm, hash, argc > 1 && mal_value_is_truthy(args[1]),
        argc > 2 ? args[2] : mal_value_new_undefined());
}

static MalValue mal_node_crypto_illegal_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target; (void) callee;
    mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Illegal constructor", "ERR_ILLEGAL_CONSTRUCTOR");
    return mal_value_new_undefined();
}

/* A WebCrypto interface object whose prototype is `prototype`, published on globalThis. */
static void crypto_web_interface(MalVm *vm, const char *name, MalValue prototype) {
    MalValue roots[] = {prototype, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), 0, mal_node_crypto_illegal_constructor);
    mal_native_function_object_set_constructor(constructor);
    roots[1] = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype", roots[0], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "constructor", roots[1],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    MalValue global = vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS];
    if (mal_value_is_object(global)) {
        mal_intrinsic_define_data(vm, mal_value_to_object(global), (const byte *) name, roots[1],
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    mal_gc_unroot(&root);
}

/* Node 26 makes globalThis.crypto the module's webcrypto, replacing the web platform's
 * randomness-only object, and adds the asymmetric subtle methods. */
static void crypto_install_web_globals(MalVm *vm, MalObject *module) {
    MalValue roots[] = {mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!crypto_option(vm, mal_value_from_object(module), "webcrypto", &roots[0])
        || !crypto_option(vm, roots[0], "subtle", &roots[1]) || !mal_value_is_object(roots[1])) {
        mal_gc_unroot(&root);
        return;
    }
    MalObject *subtle = mal_value_to_object(roots[1]);
    mal_intrinsic_define_method_n(vm, subtle, (const byte *) "exportKey", 2, mal_node_crypto_subtle_export_key);
    mal_intrinsic_define_method_n(vm, subtle, (const byte *) "generateKey", 3, mal_node_crypto_subtle_generate_key);
    roots[2] = mal_value_from_object(mal_intrinsic_new_object(vm));
    mal_object_set_prototype(subtle, mal_value_to_object(roots[2]));
    crypto_web_interface(vm, "SubtleCrypto", roots[2]);
    roots[2] = mal_value_from_object(mal_intrinsic_new_object(vm));
    mal_object_set_prototype(mal_value_to_object(roots[0]), mal_value_to_object(roots[2]));
    crypto_web_interface(vm, "Crypto", roots[2]);
    crypto_web_interface(vm, "CryptoKey", crypto_crypto_key_prototype);
    MalValue global = vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS];
    if (mal_value_is_object(global)) {
        mal_intrinsic_define_data(vm, mal_value_to_object(global), (const byte *) "crypto", roots[0],
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    mal_gc_unroot(&root);
}

static bool crypto_crypto_key_brand(MalValue value);

/* KeyObject.from: secret CryptoKeys store a kind byte then the key; asymmetric ones a marker then DER. */
static MalValue mal_node_crypto_key_object_from(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue key = argc > 0 ? args[0] : mal_value_new_undefined();
    MalPropertyLookup lookup = {0};
    if (crypto_crypto_key_brand(key)) {
        lookup = mal_object_get_own(mal_value_to_object(key),
            (MalKey) {.kind = MAL_KEY_SYMBOL, .value = crypto_crypto_key_symbol});
    }
    if (!lookup.present || !mal_value_is_array_buffer_object(lookup.desc.value)
        || mal_value_to_array_buffer_object(lookup.desc.value)->byte_length < 1) {
        crypto_throw_arg_type(vm, "key", "an instance of CryptoKey", key);
        return mal_value_new_undefined();
    }
    if (crypto_web_is_asym_key(key)) {
        MalPkey *handle = crypto_web_pkey(key);
        if (handle == nullptr) { crypto_throw_pkey_status(vm, MAL_PKEY_INVALID_KEY); return mal_value_new_undefined(); }
        return crypto_new_pkey_object(vm, handle);
    }
    MalArrayBufferObject *stored = mal_value_to_array_buffer_object(lookup.desc.value);
    usize length = stored->byte_length - 1;
    byte *copy = malloc(length > 0 ? length : 1);
    if (copy == nullptr) { mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
    if (length > 0) memcpy(copy, stored->data + 1, length);
    return crypto_new_secret_key(vm, copy, length);
}

static MalValue crypto_key_subclass(MalVm *vm, MalValue parent_constructor, MalValue parent_prototype,
    const char *name) {
    MalValue roots[] = {mal_value_from_object(mal_object_new(&vm->heap, mal_value_to_object(parent_prototype))),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(&vm->heap,
        mal_value_to_object(parent_constructor), mal_intrinsic_ascii(vm, (const byte *) name), 1,
        mal_node_crypto_key_object_constructor);
    mal_native_function_object_set_constructor(constructor);
    roots[1] = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype", roots[0], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "constructor", roots[1],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue mal_node_crypto_sign_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    return mal_node_crypto_create_sign(vm, receiver, args, argc, new_target, callee);
}

static MalValue mal_node_crypto_verify_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    return mal_node_crypto_create_verify(vm, receiver, args, argc, new_target, callee);
}

/* Returns Sign.prototype or Verify.prototype and exports the class on `module`. */
static MalValue crypto_signer_class(MalVm *vm, MalObject *module, bool sign) {
    MalValue roots[] = {mal_value_from_object(mal_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_WRITABLE_PROTOTYPE]))), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *prototype = mal_value_to_object(roots[0]);
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_WRITABLE_CONSTRUCTOR]),
        mal_intrinsic_ascii(vm, (const byte *) (sign ? "Sign" : "Verify")), 2,
        sign ? mal_node_crypto_sign_constructor : mal_node_crypto_verify_constructor);
    mal_native_function_object_set_constructor(constructor);
    roots[1] = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype", roots[0], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, (const byte *) "constructor", roots[1],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_method_n(vm, prototype, (const byte *) "_write", 3, mal_node_crypto_signer_write);
    mal_intrinsic_define_method_n(vm, prototype, (const byte *) "update", 2, mal_node_crypto_signer_update);
    if (sign) {
        mal_intrinsic_define_method_n(vm, prototype, (const byte *) "sign", 2, mal_node_crypto_signer_sign);
    } else {
        mal_intrinsic_define_method_n(vm, prototype, (const byte *) "verify", 3, mal_node_crypto_signer_verify);
    }
    mal_intrinsic_define_data(vm, module, (const byte *) (sign ? "Sign" : "Verify"), roots[1],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&root);
    return roots[0];
}

/* Runs after crypto_install_key_objects; the prototypes stay rooted through crypto_scan_roots. */
static void crypto_install_asymmetric(MalVm *vm, MalObject *module) {
    crypto_asymmetric_key_prototype = mal_value_new_undefined();
    crypto_public_key_prototype = mal_value_new_undefined();
    crypto_private_key_prototype = mal_value_new_undefined();
    crypto_sign_prototype = mal_value_new_undefined();
    crypto_verify_prototype = mal_value_new_undefined();
    crypto_signer_meta_symbol = mal_value_new_undefined();
    crypto_pkey_symbol = mal_value_new_undefined();
    crypto_pkey_symbol = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    crypto_signer_meta_symbol = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    MalValue key_prototype = mal_value_new_undefined();
    if (!crypto_option(vm, crypto_key_object_constructor, "prototype", &key_prototype)) return;
    crypto_asymmetric_key_prototype = crypto_key_subclass(vm, crypto_key_object_constructor, key_prototype,
        "AsymmetricKeyObject");
    MalObject *asymmetric = mal_value_to_object(crypto_asymmetric_key_prototype);
    crypto_define_getter(vm, asymmetric, "asymmetricKeyType", mal_node_crypto_pkey_type);
    crypto_define_getter(vm, asymmetric, "asymmetricKeyDetails", mal_node_crypto_pkey_details);
    MalValue asymmetric_constructor;
    if (!crypto_option(vm, crypto_asymmetric_key_prototype, "constructor", &asymmetric_constructor)) return;
    crypto_public_key_prototype = crypto_key_subclass(vm, asymmetric_constructor, crypto_asymmetric_key_prototype,
        "PublicKeyObject");
    crypto_private_key_prototype = crypto_key_subclass(vm, asymmetric_constructor, crypto_asymmetric_key_prototype,
        "PrivateKeyObject");
    mal_intrinsic_define_method_n(vm, mal_value_to_object(crypto_public_key_prototype), (const byte *) "export", 1,
        mal_node_crypto_pkey_export);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(crypto_private_key_prototype), (const byte *) "export", 1,
        mal_node_crypto_pkey_export);
    mal_intrinsic_define_method_n(vm, asymmetric, (const byte *) "toCryptoKey", 3, mal_node_crypto_pkey_to_crypto_key);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(crypto_key_object_constructor), (const byte *) "from", 1,
        mal_node_crypto_key_object_from);
    crypto_sign_prototype = crypto_signer_class(vm, module, true);
    crypto_verify_prototype = crypto_signer_class(vm, module, false);
}

static bool crypto_key_object_brand(MalValue value) {
    const byte *data;
    usize length;
    return crypto_pkey_der(value, &data, &length) || crypto_secret_key_bytes(value, &data, &length);
}

static bool crypto_crypto_key_brand(MalValue value) {
    if (!crypto_keys_ready || !mal_value_is_object(value) || !mal_value_is_symbol(crypto_crypto_key_symbol)) {
        return false;
    }
    return mal_object_get_own(mal_value_to_object(value),
        (MalKey) {.kind = MAL_KEY_SYMBOL, .value = crypto_crypto_key_symbol}).present;
}

typedef struct {
    const char *name;
    i32 length;
    MalNativeFunctionCallback callback;
} CryptoExport;

static MalValue mal_node_crypto_asymmetric_unavailable(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        "Asymmetric cryptography is not supported by this host");
    return mal_value_new_undefined();
}


static MalValue crypto_x509_own(MalValue value, MalValue symbol) {
    if (!crypto_x509_ready || !mal_value_is_object(value)) return mal_value_new_undefined();
    MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(value),
        (MalKey) {.kind = MAL_KEY_SYMBOL, .value = symbol});
    return lookup.present ? lookup.desc.value : mal_value_new_undefined();
}

static bool crypto_x509_der(MalValue value, const byte **der, usize *length) {
    MalValue stored = crypto_x509_own(value, crypto_x509_symbol);
    if (!mal_value_is_array_buffer_object(stored)) return false;
    MalArrayBufferObject *buffer = mal_value_to_array_buffer_object(stored);
    *der = buffer->data;
    *length = buffer->byte_length;
    return true;
}

static bool crypto_x509_this(MalVm *vm, MalValue receiver, const byte **der, usize *length) {
    if (crypto_x509_der(receiver, der, length)) return true;
    mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "Value of \"this\" must be of type X509Certificate", "ERR_INVALID_THIS");
    return false;
}

static MalValue crypto_x509_string(MalVm *vm, const byte *text, usize length) {
    return mal_value_from_string(mal_string_from_utf8(&vm->heap, text, length));
}

// Rust writes T records as decimal Unix seconds; values are not NUL-terminated.
static double crypto_x509_seconds(const byte *value, usize length) {
    char text[32];
    if (length >= sizeof text) return NAN;
    memcpy(text, value, length);
    text[length] = '\0';
    return strtod(text, nullptr);
}

/* Builds the hidden field object once; getters read it, as Node's cache does. */
static MalValue crypto_x509_info_object(MalVm *vm, const byte *der, usize length) {
    intptr_t needed = mal_x509_info(der, length, nullptr, 0);
    byte *records = needed > 0 ? malloc((usize) needed) : nullptr;
    if (records == nullptr || mal_x509_info(der, length, records, (usize) needed) != needed) {
        free(records);
        return mal_value_new_undefined();
    }
    MalValue roots[] = {mal_value_from_object(mal_object_new(&vm->heap, nullptr)), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalX509Record record;
    for (usize at = 0; mal_x509_record_next(records, (usize) needed, &at, &record);) {
        byte kind = record.kind;
        const char *key = record.key;
        const byte *value = record.value;
        usize value_length = record.value_length;
        if (kind == 'K') {
            if (mal_value_is_array_object(roots[1])) {
                roots[2] = crypto_x509_string(vm, value, value_length);
                MalArrayObject *array = mal_value_to_array_object(roots[1]);
                (void) mal_array_object_set(array, mal_key_index(mal_array_object_length(array)), roots[2]);
            }
            continue;
        }
        if (kind == 'F' && strcmp(key, "keyUsage") == 0) {
            roots[1] = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
            roots[2] = roots[1];
        } else if (kind == 'T') {
            roots[2] = mal_value_from_f64(crypto_x509_seconds(value, value_length) * 1000.0);
        } else if (kind == 'B') {
            roots[2] = mal_value_new_boolean(value_length == 1 && value[0] == '1');
        } else {
            roots[2] = crypto_x509_string(vm, value, value_length);
        }
        mal_object_set(mal_value_to_object(roots[0]), mal_intrinsic_string_key(vm, (const byte *) key), roots[2]);
    }
    free(records);
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue mal_node_crypto_x509_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) callee;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Class constructor X509Certificate cannot be invoked without 'new'");
        return mal_value_new_undefined();
    }
    MalValue input = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_string(input) && (!crypto_is_byte_source(input) || mal_value_is_array_buffer_object(input))) {
        crypto_throw_arg_type(vm, "buffer", "of type string or an instance of Buffer, TypedArray, or DataView", input);
        return mal_value_new_undefined();
    }
    byte *bytes;
    usize length;
    if (!crypto_input_bytes(vm, input, mal_value_new_undefined(), "buffer", &bytes, &length)) return mal_value_new_undefined();
    intptr_t der_length = mal_x509_from_input(bytes, length, nullptr, 0);
    byte *der = der_length > 0 ? malloc((usize) der_length) : nullptr;
    if (der != nullptr) (void) mal_x509_from_input(bytes, length, der, (usize) der_length);
    free(bytes);
    if (der == nullptr) {
        if (der_length == -1) {
            mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                "error:0480006C:PEM routines::no start line", "ERR_OSSL_PEM_NO_START_LINE");
        } else if (der_length == -2) {
            mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                "error:0680007B:asn1 encoding routines::header too long", "ERR_OSSL_ASN1_HEADER_TOO_LONG");
        } else {
            mal_vm_throw_allocation_error(vm);
        }
        return mal_value_new_undefined();
    }
    MalValue prototype = mal_vm_function_prototype(vm, new_target);
    MalValue roots[] = {mal_value_from_object(mal_object_new(&vm->heap, mal_value_to_object(
        mal_value_is_object(prototype) ? prototype : vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]))),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = crypto_x509_info_object(vm, der, (usize) der_length);
    if (mal_value_is_undefined(roots[1])) {
        free(der);
        mal_gc_unroot(&root);
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            "error:0680007B:asn1 encoding routines::header too long", "ERR_OSSL_ASN1_HEADER_TOO_LONG");
        return mal_value_new_undefined();
    }
    byte *raw = malloc((usize) der_length);
    if (raw != nullptr) {
        memcpy(raw, der, (usize) der_length);
        roots[2] = mal_node_buffer_from_owned_bytes(vm, raw, (usize) der_length);
        mal_object_set(mal_value_to_object(roots[1]), mal_intrinsic_string_key(vm, (const byte *) "raw"), roots[2]);
    }
    roots[2] = mal_value_from_array_buffer_object(mal_array_buffer_object_adopt(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]), der, (u32) der_length, true));
    mal_object_set(mal_value_to_object(roots[0]), (MalKey) {.kind = MAL_KEY_SYMBOL, .value = crypto_x509_symbol}, roots[2]);
    mal_object_set(mal_value_to_object(roots[0]), (MalKey) {.kind = MAL_KEY_SYMBOL, .value = crypto_x509_info_symbol},
        roots[1]);
    MalValue result = roots[0];
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : result;
}

static MalValue mal_node_crypto_x509_field(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args, (void) argc, (void) new_target;
    const byte *der;
    usize length;
    if (!crypto_x509_this(vm, receiver, &der, &length)) return mal_value_new_undefined();
    MalValue name = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalValue info = crypto_x509_own(receiver, crypto_x509_info_symbol);
    MalValue value = mal_value_new_undefined();
    if (!mal_value_is_object(info) || !mal_value_is_string(name)) return value;
    MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(info), mal_key_from_value(name));
    if (lookup.present) value = lookup.desc.value;
    MalString *text = mal_value_to_string(name);
    if (mal_string_equals_ascii(text, "validFromDate") || mal_string_equals_ascii(text, "validToDate")) {
        if (!mal_ops_is_number(value)) return mal_value_new_undefined();
        return mal_value_from_object((MalObject *) mal_date_object_new(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_DATE_PROTOTYPE]), mal_ops_number_as_f64(value)));
    }
    if (mal_string_equals_ascii(text, "ca") && mal_value_is_undefined(value)) return mal_value_new_boolean(false);
    return value;
}

static MalValue mal_node_crypto_x509_public_key(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args, (void) argc, (void) new_target, (void) callee;
    const byte *der;
    usize length;
    if (!crypto_x509_this(vm, receiver, &der, &length)) return mal_value_new_undefined();
    usize offset = 0, spki_length = 0;
    MalPkey *key = nullptr;
    if (!mal_x509_part(der, length, MAL_X509_PART_SPKI, &offset, &spki_length)
        || mal_pkey_import(der + offset, spki_length, MAL_PKEY_FORMAT_DER, MAL_PKEY_TYPE_SPKI, false, &key)
            != MAL_PKEY_OK) {
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            "error:03000072:digital envelope routines::decode error", "ERR_OSSL_EVP_DECODE_ERROR");
        return mal_value_new_undefined();
    }
    return crypto_new_pkey_object(vm, key);
}

static MalValue mal_node_crypto_x509_to_string(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args, (void) argc, (void) new_target, (void) callee;
    const byte *der;
    usize length;
    if (!crypto_x509_this(vm, receiver, &der, &length)) return mal_value_new_undefined();
    intptr_t needed = mal_x509_pem(der, length, nullptr, 0);
    byte *pem = needed > 0 ? malloc((usize) needed) : nullptr;
    if (pem == nullptr) { mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
    (void) mal_x509_pem(der, length, pem, (usize) needed);
    MalValue result = crypto_x509_string(vm, pem, (usize) needed);
    free(pem);
    return result;
}

static MalValue crypto_x509_san_match(MalVm *vm, MalValue receiver, MalValue wanted, const char *prefix, bool host) {
    MalValue info = crypto_x509_own(receiver, crypto_x509_info_symbol);
    if (!mal_value_is_string(wanted)) {
        crypto_throw_arg_type(vm, host ? "name" : prefix[0] == 'e' ? "email" : "ip", "of type string", wanted);
        return mal_value_new_undefined();
    }
    usize wanted_length = 0;
    byte *want = mal_string_to_utf8(mal_value_to_string(wanted), &wanted_length);
    MalValue result = mal_value_new_undefined();
    MalPropertyLookup san = mal_value_is_object(info)
        ? mal_object_get_own(mal_value_to_object(info), mal_intrinsic_string_key(vm, (const byte *) "subjectAltName"))
        : (MalPropertyLookup) {0};
    usize text_length = 0;
    byte *text = san.present && mal_value_is_string(san.desc.value)
        ? mal_string_to_utf8(mal_value_to_string(san.desc.value), &text_length) : nullptr;
    usize prefix_length = strlen(prefix);
    for (usize at = 0; text != nullptr && want != nullptr && at < text_length;) {
        usize end = at;
        while (end < text_length && !(text[end] == ',' && end + 1 < text_length && text[end + 1] == ' ')) end++;
        if (end - at > prefix_length && memcmp(text + at, prefix, prefix_length) == 0) {
            const byte *name = text + at + prefix_length;
            usize name_length = end - at - prefix_length;
            bool matched = name_length == wanted_length && strncasecmp((const char *) name, (const char *) want, name_length) == 0;
            // RFC 6125: a leftmost `*` label matches exactly one label of the host.
            if (!matched && host && name_length > 2 && name[0] == '*' && name[1] == '.') {
                const byte *dot = memchr(want, '.', wanted_length);
                usize suffix = dot == nullptr ? 0 : wanted_length - (usize) (dot - want);
                matched = dot != nullptr && dot != want && suffix == name_length - 1
                    && strncasecmp((const char *) dot, (const char *) name + 1, suffix) == 0;
            }
            if (matched) {
                result = crypto_x509_string(vm, name, name_length);
                break;
            }
        }
        at = end + 2;
    }
    free(text);
    free(want);
    return result;
}

static MalValue mal_node_crypto_x509_check_host(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target, (void) callee;
    const byte *der;
    usize length;
    if (!crypto_x509_this(vm, receiver, &der, &length)) return mal_value_new_undefined();
    return crypto_x509_san_match(vm, receiver, argc > 0 ? args[0] : mal_value_new_undefined(), "DNS:", true);
}

static MalValue mal_node_crypto_x509_check_email(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target, (void) callee;
    const byte *der;
    usize length;
    if (!crypto_x509_this(vm, receiver, &der, &length)) return mal_value_new_undefined();
    return crypto_x509_san_match(vm, receiver, argc > 0 ? args[0] : mal_value_new_undefined(), "email:", false);
}

static MalValue mal_node_crypto_x509_check_ip(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target, (void) callee;
    const byte *der;
    usize length;
    if (!crypto_x509_this(vm, receiver, &der, &length)) return mal_value_new_undefined();
    return crypto_x509_san_match(vm, receiver, argc > 0 ? args[0] : mal_value_new_undefined(), "IP Address:", false);
}

// OpenSSL's X509_check_issued compares names and requires a CA issuer; key identifiers are not compared.
static MalValue mal_node_crypto_x509_check_issued(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target, (void) callee;
    const byte *der, *other_der;
    usize length, other_length;
    if (!crypto_x509_this(vm, receiver, &der, &length)) return mal_value_new_undefined();
    MalValue other = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!crypto_x509_der(other, &other_der, &other_length)) {
        crypto_throw_arg_type(vm, "otherCert", "an instance of X509Certificate", other);
        return mal_value_new_undefined();
    }
    usize issuer_offset, issuer_length, subject_offset, subject_length;
    if (!mal_x509_part(der, length, MAL_X509_PART_ISSUER, &issuer_offset, &issuer_length)
        || !mal_x509_part(other_der, other_length, MAL_X509_PART_SUBJECT, &subject_offset, &subject_length)) {
        return mal_value_new_boolean(false);
    }
    MalValue info = crypto_x509_own(other, crypto_x509_info_symbol);
    MalPropertyLookup ca = mal_value_is_object(info)
        ? mal_object_get_own(mal_value_to_object(info), mal_intrinsic_string_key(vm, (const byte *) "ca"))
        : (MalPropertyLookup) {0};
    return mal_value_new_boolean(issuer_length == subject_length
        && memcmp(der + issuer_offset, other_der + subject_offset, issuer_length) == 0
        && ca.present && mal_value_is_truthy(ca.desc.value));
}

static bool crypto_x509_key_argument(MalVm *vm, MalValue value, bool private_key, const char *name) {
    const byte *key_der;
    usize key_length;
    if (crypto_pkey_der(value, &key_der, &key_length) && crypto_is_private_pkey(value) == private_key) return true;
    crypto_throw_arg_type(vm, name, "an instance of KeyObject", value);
    return false;
}

static MalValue mal_node_crypto_x509_check_private_key(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target, (void) callee;
    const byte *der;
    usize length;
    if (!crypto_x509_this(vm, receiver, &der, &length)) return mal_value_new_undefined();
    MalValue value = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!crypto_x509_key_argument(vm, value, true, "pkey")) return mal_value_new_undefined();
    MalPkey *private_key = crypto_pkey_from_object(value);
    MalPkey *public_key = nullptr, *certified = nullptr;
    usize offset = 0, spki_length = 0;
    bool matches = private_key != nullptr && mal_pkey_public(private_key, &public_key) == MAL_PKEY_OK
        && mal_x509_part(der, length, MAL_X509_PART_SPKI, &offset, &spki_length)
        && mal_pkey_import(der + offset, spki_length, MAL_PKEY_FORMAT_DER, MAL_PKEY_TYPE_SPKI, false, &certified)
            == MAL_PKEY_OK
        && mal_pkey_equals(public_key, certified);
    mal_pkey_free(private_key);
    mal_pkey_free(public_key);
    mal_pkey_free(certified);
    return mal_value_new_boolean(matches);
}

static MalValue mal_node_crypto_x509_verify(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target, (void) callee;
    const byte *der;
    usize length;
    if (!crypto_x509_this(vm, receiver, &der, &length)) return mal_value_new_undefined();
    MalValue value = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!crypto_x509_key_argument(vm, value, false, "pkey")) return mal_value_new_undefined();
    MalValue info = crypto_x509_own(receiver, crypto_x509_info_symbol);
    MalPropertyLookup algorithm = mal_value_is_object(info)
        ? mal_object_get_own(mal_value_to_object(info), mal_intrinsic_string_key(vm, (const byte *) "signatureAlgorithm"))
        : (MalPropertyLookup) {0};
    if (!algorithm.present || !mal_value_is_string(algorithm.desc.value)) return mal_value_new_boolean(false);
    MalString *name = mal_value_to_string(algorithm.desc.value);
    u32 hash = MAL_PKEY_HASH_NONE;
    if (mal_string_equals_ascii(name, "sha256WithRSAEncryption") || mal_string_equals_ascii(name, "ecdsa-with-SHA256")) {
        hash = MAL_PKEY_HASH_SHA256;
    } else if (mal_string_equals_ascii(name, "sha384WithRSAEncryption") || mal_string_equals_ascii(name, "ecdsa-with-SHA384")) {
        hash = MAL_PKEY_HASH_SHA384;
    } else if (mal_string_equals_ascii(name, "sha512WithRSAEncryption") || mal_string_equals_ascii(name, "ecdsa-with-SHA512")) {
        hash = MAL_PKEY_HASH_SHA512;
    } else if (!mal_string_equals_ascii(name, "ED25519")) {
        return mal_value_new_boolean(false);
    }
    usize tbs_offset, tbs_length, signature_offset, signature_length;
    MalPkey *key = crypto_pkey_from_object(value);
    bool valid = key != nullptr
        && mal_x509_part(der, length, MAL_X509_PART_TBS, &tbs_offset, &tbs_length)
        && mal_x509_part(der, length, MAL_X509_PART_SIGNATURE, &signature_offset, &signature_length)
        && mal_pkey_verify(key, hash, MAL_PKEY_PADDING_PKCS1, 0, false, der + tbs_offset, tbs_length,
            der + signature_offset, signature_length) == MAL_PKEY_OK;
    mal_pkey_free(key);
    return mal_value_new_boolean(valid);
}

// Node keeps a repeated name attribute (several OU, say) as an array of its values.
static void crypto_x509_name_add(MalVm *vm, MalValue name, const char *key, MalValue value) {
    MalKey property = mal_intrinsic_string_key(vm, (const byte *) key);
    MalPropertyLookup existing = mal_object_get_own(mal_value_to_object(name), property);
    if (!existing.present) {
        mal_object_set(mal_value_to_object(name), property, value);
        return;
    }
    MalValue roots[] = {value, existing.desc.value, property.value};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!mal_value_is_array_object(roots[1])) {
        MalArrayObject *array = mal_intrinsic_new_array(vm, 0);
        (void) mal_array_object_set(array, mal_key_index(0), roots[1]);
        roots[1] = mal_value_from_array_object(array);
        property.value = roots[2];
        mal_object_set(mal_value_to_object(name), property, roots[1]);
    }
    MalArrayObject *array = mal_value_to_array_object(roots[1]);
    (void) mal_array_object_set(array, mal_key_index(mal_array_object_length(array)), roots[0]);
    mal_gc_unroot(&root);
}

static MalValue mal_node_crypto_x509_to_legacy_object(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args, (void) argc, (void) new_target, (void) callee;
    const byte *der;
    usize length;
    if (!crypto_x509_this(vm, receiver, &der, &length)) return mal_value_new_undefined();
    intptr_t needed = mal_x509_legacy(der, length, nullptr, 0);
    byte *records = needed > 0 ? malloc((usize) needed) : nullptr;
    if (records == nullptr || mal_x509_legacy(der, length, records, (usize) needed) != needed) {
        free(records);
        return mal_value_new_undefined();
    }
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_from_object(mal_object_new(&vm->heap, nullptr)),
        mal_value_from_object(mal_object_new(&vm->heap, nullptr)), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *object = mal_value_to_object(roots[0]);
    mal_object_set(object, mal_intrinsic_string_key(vm, (const byte *) "subject"), roots[1]);
    mal_object_set(object, mal_intrinsic_string_key(vm, (const byte *) "issuer"), roots[2]);
    MalValue info = crypto_x509_own(receiver, crypto_x509_info_symbol);
    bool ca_written = false;
    MalX509Record record;
    for (usize at = 0; mal_x509_record_next(records, (usize) needed, &at, &record);) {
        byte kind = record.kind;
        const char *key = record.key;
        if (kind == 'F' && !ca_written && strcmp(key, "subjectaltname") != 0) {
            ca_written = true;
            MalPropertyLookup ca = mal_object_get_own(mal_value_to_object(info), mal_intrinsic_string_key(vm, (const byte *) "ca"));
            mal_object_set(object, mal_intrinsic_string_key(vm, (const byte *) "ca"),
                mal_value_new_boolean(ca.present && mal_value_is_truthy(ca.desc.value)));
        }
        if (kind == 'F' && strcmp(key, "serialNumber") == 0) {
            MalPropertyLookup usage = mal_object_get_own(mal_value_to_object(info),
                mal_intrinsic_string_key(vm, (const byte *) "keyUsage"));
            if (usage.present) mal_object_set(object, mal_intrinsic_string_key(vm, (const byte *) "ext_key_usage"), usage.desc.value);
        }
        roots[3] = crypto_x509_string(vm, record.value, record.value_length);
        if (kind == 'S' || kind == 'I') {
            crypto_x509_name_add(vm, kind == 'S' ? roots[1] : roots[2], key, roots[3]);
        } else {
            mal_object_set(object, mal_intrinsic_string_key(vm, (const byte *) key), roots[3]);
        }
    }
    free(records);
    MalPropertyLookup raw = mal_object_get_own(mal_value_to_object(info), mal_intrinsic_string_key(vm, (const byte *) "raw"));
    if (raw.present) mal_object_set(object, mal_intrinsic_string_key(vm, (const byte *) "raw"), raw.desc.value);
    mal_gc_unroot(&root);
    return roots[0];
}

static void crypto_install_x509(MalVm *vm, MalObject *module) {
    crypto_x509_symbol = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    crypto_x509_info_symbol = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    crypto_x509_ready = true;
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "X509Certificate"), 1, mal_node_crypto_x509_constructor);
    mal_native_function_object_set_constructor(constructor);
    roots[1] = mal_value_from_native_function_object(constructor);
    MalObject *prototype = mal_value_to_object(roots[0]);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype", roots[0], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, (const byte *) "constructor", roots[1],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    // Node 26's X509Certificate.prototype order.
    static const char *const fields[] = {
        "subject", "subjectAltName", "issuer", "issuerCertificate", "infoAccess", "validFrom", "validTo",
        "validFromDate", "validToDate", "fingerprint", "fingerprint256", "fingerprint512", "keyUsage",
        "serialNumber", "signatureAlgorithm", "signatureAlgorithmOid", "raw", "publicKey",
    };
    for (usize i = 0; i < countof(fields); i++) {
        char getter_name[64];
        snprintf(getter_name, sizeof getter_name, "get %s", fields[i]);
        roots[2] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) fields[i]));
        MalNativeFunctionCallback callback = strcmp(fields[i], "publicKey") == 0
            ? mal_node_crypto_x509_public_key : mal_node_crypto_x509_field;
        MalValue getter = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) getter_name), 0, callback, &roots[2], 1));
        MalPropertyDesc desc = mal_intrinsic_accessor_desc(getter, mal_value_new_undefined(), MAL_PROPERTY_CONFIGURABLE);
        mal_object_define_own(prototype, mal_intrinsic_string_key(vm, (const byte *) fields[i]), &desc);
    }
    mal_intrinsic_define_method_n(vm, prototype, (const byte *) "toString", 0, mal_node_crypto_x509_to_string);
    mal_intrinsic_define_method_n(vm, prototype, (const byte *) "toJSON", 0, mal_node_crypto_x509_to_string);
    roots[2] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "ca"));
    MalValue ca_getter = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "get ca"), 0, mal_node_crypto_x509_field, &roots[2], 1));
    MalPropertyDesc ca_desc = mal_intrinsic_accessor_desc(ca_getter, mal_value_new_undefined(), MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(prototype, mal_intrinsic_string_key(vm, (const byte *) "ca"), &ca_desc);
    mal_intrinsic_define_method_n(vm, prototype, (const byte *) "checkHost", 2, mal_node_crypto_x509_check_host);
    mal_intrinsic_define_method_n(vm, prototype, (const byte *) "checkEmail", 2, mal_node_crypto_x509_check_email);
    mal_intrinsic_define_method_n(vm, prototype, (const byte *) "checkIP", 2, mal_node_crypto_x509_check_ip);
    mal_intrinsic_define_method_n(vm, prototype, (const byte *) "checkIssued", 1, mal_node_crypto_x509_check_issued);
    mal_intrinsic_define_method_n(vm, prototype, (const byte *) "checkPrivateKey", 1,
        mal_node_crypto_x509_check_private_key);
    mal_intrinsic_define_method_n(vm, prototype, (const byte *) "verify", 1, mal_node_crypto_x509_verify);
    mal_intrinsic_define_method_n(vm, prototype, (const byte *) "toLegacyObject", 0,
        mal_node_crypto_x509_to_legacy_object);
    mal_intrinsic_define_data(vm, module, (const byte *) "X509Certificate", roots[1],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&root);
}

// lib/internal/crypto/keygen.js generateKeyJob for the secret types: hmac takes 8..2^31-1 bits
// (truncated to whole bytes), aes exactly 128, 192 or 256.
static MalValue crypto_generate_secret_key(MalVm *vm, MalValue type, MalValue options) {
    if (!mal_value_is_string(type)) {
        crypto_throw_arg_type(vm, "type", "of type string", type);
        return mal_value_new_undefined();
    }
    MalString *name = mal_value_to_string(type);
    bool hmac = mal_string_equals_ascii(name, "hmac");
    if (!hmac && !mal_string_equals_ascii(name, "aes")) {
        usize text_length = 0;
        byte *text = mal_string_to_utf8(name, &text_length);
        char message[CRYPTO_MESSAGE_CAPACITY];
        snprintf(message, sizeof message, "The argument 'type' must be a supported key type. Received '%.*s'",
            text == nullptr ? 0 : (int) text_length, text == nullptr ? "" : (const char *) text);
        free(text);
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_VALUE");
        return mal_value_new_undefined();
    }
    if (!mal_value_is_object(options) || mal_value_is_callable(options) || mal_value_is_array_object(options)) {
        crypto_throw_arg_type(vm, "options", "of type object", options);
        return mal_value_new_undefined();
    }
    MalValue length = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &length, 1);
    bool ok = mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, (const byte *) "length"), &length);
    mal_gc_unroot(&root);
    if (!ok) return mal_value_new_undefined();
    f64 bits = mal_ops_is_number(length) ? mal_ops_number_as_f64(length) : NAN;
    if (hmac) {
        if (!mal_ops_is_number(length)) {
            crypto_throw_property_type(vm, "options.length", "of type number", length);
            return mal_value_new_undefined();
        }
        if (bits != floor(bits) || !isfinite(bits)) {
            crypto_throw_out_of_range(vm, "options.length", "an integer", length);
            return mal_value_new_undefined();
        }
        if (bits < 8 || bits > 2147483647.0) {
            crypto_throw_out_of_range(vm, "options.length", ">= 8 && <= 2147483647", length);
            return mal_value_new_undefined();
        }
    } else if (!(mal_ops_is_number(length) && (bits == 128 || bits == 192 || bits == 256))) {
        char received[CRYPTO_MESSAGE_CAPACITY / 2];
        if (mal_value_is_string(length)) {
            usize text_length = 0;
            byte *text = mal_string_to_utf8(mal_value_to_string(length), &text_length);
            snprintf(received, sizeof received, "'%.*s'", text == nullptr ? 0 : (int) text_length,
                text == nullptr ? "" : (const char *) text);
            free(text);
        } else {
            crypto_received_number(vm, length, received, sizeof received);
        }
        char message[CRYPTO_MESSAGE_CAPACITY];
        snprintf(message, sizeof message, "The property 'options.length' must be one of: 128, 192, 256. Received %s",
            received);
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_VALUE");
        return mal_value_new_undefined();
    }
    usize size = (usize) (bits / 8);
    byte *bytes = malloc(size > 0 ? size : 1);
    if (bytes == nullptr) { mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
    if (size > 0 && mal_host_entropy(bytes, size) != 0) {
        free(bytes);
        crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, CRYPTO_ENTROPY_UNAVAILABLE);
        return mal_value_new_undefined();
    }
    return crypto_new_secret_key(vm, bytes, size);
}

static MalValue mal_node_crypto_generate_key_sync(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    return crypto_generate_secret_key(vm, argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined());
}

static MalValue mal_node_crypto_generate_key(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    MalValue options = argc > 1 ? args[1] : mal_value_new_undefined();
    MalValue callback = argc > 2 ? args[2] : mal_value_new_undefined();
    if (mal_value_is_callable(options)) {
        callback = options;
        options = mal_value_new_undefined();
    }
    if (!mal_value_is_callable(callback)) {
        crypto_throw_arg_type(vm, "callback", "of type function", callback);
        return mal_value_new_undefined();
    }
    if (!crypto_require_host(vm)) return mal_value_new_undefined();
    MalValue roots[] = {callback, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = crypto_generate_secret_key(vm, argc > 0 ? args[0] : mal_value_new_undefined(), options);
    if (vm->completion.kind == MAL_COMPLETION_THROW) { mal_gc_unroot(&root); return mal_value_new_undefined(); }
    CryptoImmediateResult *result = calloc(1, sizeof(CryptoImmediateResult));
    // RANDOM_FILL delivers `value` as the callback's second argument.
    MalNodeCryptoAsync *state = crypto_async_new(vm, CRYPTO_ASYNC_RANDOM_FILL, roots[0]);
    if (result == nullptr || state == nullptr) {
        free(result);
        free(state);
        mal_gc_unroot(&root);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    state->value = roots[1];
    if (!crypto_complete_immediately(vm, state, result)) {
        crypto_immediate_destroy(result);
        free(state);
        crypto_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Crypto operation failed");
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

/* Node's deprecated Hash/Hmac constructors build what createHash/createHmac build. */
static MalValue crypto_adopt_new_target(MalVm *vm, MalValue result, MalValue new_target) {
    if (vm->completion.kind == MAL_COMPLETION_THROW || !mal_value_is_object(result)) return result;
    if (mal_value_is_object(new_target)) {
        MalValue prototype = mal_vm_function_prototype(vm, new_target);
        if (mal_value_is_object(prototype)) {
            mal_object_set_prototype(mal_value_to_object(result), mal_value_to_object(prototype));
        }
    }
    return result;
}

static MalValue mal_node_crypto_hash_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    return crypto_adopt_new_target(vm,
        mal_node_crypto_create_hash(vm, receiver, args, argc, mal_value_new_undefined(), callee), new_target);
}

static MalValue mal_node_crypto_hmac_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    return crypto_adopt_new_target(vm,
        mal_node_crypto_create_hmac(vm, receiver, args, argc, mal_value_new_undefined(), callee), new_target);
}

static MalValue crypto_digest_class(
    MalVm *vm, MalObject *module, const char *name, i32 length, MalNativeFunctionCallback callback,
    const MalValue *slots) {
    MalNativeFunctionObject *constructor = mal_native_function_object_new_with_slots_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), length, callback, slots, 2);
    mal_native_function_object_set_constructor(constructor);
    MalValue value = mal_value_from_native_function_object(constructor);
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    // Node exports deprecation wrappers, so prototype.constructor is not the exported function.
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype", slots[1], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, module, (const byte *) name, value,
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&root);
    return value;
}

/*
 * lib/internal/streams/lazy_transform.js: Hash, Hmac, Cipheriv and Decipheriv are Transforms
 * whose stream state appears on first stream use, so update()/digest() never pay for it. The
 * native stream methods read their state as own properties, so the stream entry points on these
 * prototypes create it before delegating to Transform.prototype.
 */
static const char *const CRYPTO_LAZY_STREAM_METHODS[] = {
    "write", "end", "pipe", "unpipe", "on", "addListener", "once", "prependListener",
    "prependOnceListener", "removeListener", "off", "removeAllListeners", "setEncoding", "read",
    "resume", "pause", "isPaused", "unshift", "cork", "uncork", "destroy", "setDefaultEncoding", "push",
};

static bool crypto_lazy_stream_init(MalVm *vm, MalValue receiver) {
    if (!mal_value_is_object(receiver)) return true;
    MalObject *object = mal_value_to_object(receiver);
    if (mal_object_get_own(object, mal_intrinsic_string_key(vm, (const byte *) "_readableState")).present) return true;
    MalPropertyLookup options = mal_object_get_own(object, mal_intrinsic_string_key(vm, (const byte *) "_options"));
    MalValue roots[] = {receiver, options.present ? options.desc.value : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalCompletion initialized = mal_vm_call_value(
        vm, vm->intrinsics[MAL_INTRINSIC_NODE_TRANSFORM_CONSTRUCTOR], roots[0], &roots[1], 1);
    bool ok = initialized.kind != MAL_COMPLETION_THROW;
    if (ok) {
        // Strings reach update() with their encoding instead of being decoded to Buffers first.
        MalPropertyLookup state = mal_object_get_own(object, mal_intrinsic_string_key(vm, (const byte *) "_writableState"));
        if (state.present && mal_value_is_object(state.desc.value)) {
            mal_object_set(mal_value_to_object(state.desc.value),
                mal_intrinsic_string_key(vm, (const byte *) "decodeStrings"), mal_value_new_boolean(false));
        }
    }
    mal_gc_unroot(&root);
    return ok;
}

static MalValue mal_node_crypto_lazy_stream_method(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalValue name = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalValue roots[] = {receiver, name, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    if (crypto_lazy_stream_init(vm, roots[0])
        && mal_vm_get_property(vm, vm->intrinsics[MAL_INTRINSIC_NODE_TRANSFORM_PROTOTYPE], mal_key_from_value(roots[1]),
            &roots[2])) {
        MalCompletion called = mal_vm_call_value(vm, roots[2], roots[0], args, argc);
        if (called.kind != MAL_COMPLETION_THROW) result = called.value;
    }
    mal_gc_unroot(&root);
    return result;
}

static void crypto_lazy_call_back(MalVm *vm, MalValue callback, MalValue error) {
    if (!mal_value_is_callable(callback)) return;
    (void) mal_vm_call_value(vm, callback, mal_value_new_undefined(), &error, mal_value_is_undefined(error) ? 0 : 1);
}

static MalValue crypto_lazy_take_error(MalVm *vm) {
    MalValue error = vm->completion.value;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    return error;
}

static bool crypto_lazy_push(MalVm *vm, MalValue receiver, MalValue chunk) {
    MalValue push = mal_value_new_undefined();
    MalValue roots[] = {receiver, chunk, push};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool ok = mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "push"), &roots[2])
        && mal_vm_call_value(vm, roots[2], roots[0], &roots[1], 1).kind != MAL_COMPLETION_THROW;
    mal_gc_unroot(&root);
    return ok;
}

/* Hash and Hmac: slot 0 is update, slot 1 digest, as installed (not as later patched). */
static MalValue mal_node_crypto_digest_transform(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalValue roots[] = {receiver, argc > 2 ? args[2] : mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue update_args[] = {argc > 0 ? args[0] : mal_value_new_undefined(), argc > 1 ? args[1] : mal_value_new_undefined()};
    MalCompletion updated = mal_vm_call_value(vm, mal_native_function_object_get_slot(self, 0), roots[0], update_args, 2);
    if (updated.kind == MAL_COMPLETION_THROW) {
        (void) crypto_lazy_take_error(vm);
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Hash update failed", "ERR_CRYPTO_HASH_UPDATE_FAILED");
        roots[2] = crypto_lazy_take_error(vm);
    }
    crypto_lazy_call_back(vm, roots[1], roots[2]);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue mal_node_crypto_digest_flush(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalValue roots[] = {receiver, argc > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalCompletion digested = mal_vm_call_value(vm, mal_native_function_object_get_slot(self, 1), roots[0], nullptr, 0);
    if (digested.kind == MAL_COMPLETION_THROW) {
        roots[2] = crypto_lazy_take_error(vm);
    } else if (!crypto_lazy_push(vm, roots[0], digested.value)) {
        roots[2] = crypto_lazy_take_error(vm);
    }
    crypto_lazy_call_back(vm, roots[1], roots[2]);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

/* Cipheriv and Decipheriv: slot 0 is update, slot 1 final. */
static MalValue mal_node_crypto_cipher_transform(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalValue roots[] = {receiver, argc > 2 ? args[2] : mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue update_args[] = {argc > 0 ? args[0] : mal_value_new_undefined(), argc > 1 ? args[1] : mal_value_new_undefined()};
    MalCompletion updated = mal_vm_call_value(vm, mal_native_function_object_get_slot(self, 0), roots[0], update_args, 2);
    if (updated.kind == MAL_COMPLETION_THROW || !crypto_lazy_push(vm, roots[0], updated.value)) {
        roots[2] = crypto_lazy_take_error(vm);
    }
    crypto_lazy_call_back(vm, roots[1], roots[2]);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue mal_node_crypto_cipher_flush(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalValue roots[] = {receiver, argc > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalCompletion finished = mal_vm_call_value(vm, mal_native_function_object_get_slot(self, 1), roots[0], nullptr, 0);
    if (finished.kind == MAL_COMPLETION_THROW || !crypto_lazy_push(vm, roots[0], finished.value)) {
        roots[2] = crypto_lazy_take_error(vm);
    }
    crypto_lazy_call_back(vm, roots[1], roots[2]);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static void crypto_lazy_transform_prototype(
    MalVm *vm, MalValue prototype, const char *update_name, const char *finish_name,
    MalNativeFunctionCallback transform, MalNativeFunctionCallback flush) {
    if (!mal_value_is_object(prototype)) return;
    MalObject *object = mal_value_to_object(prototype);
    MalValue roots[] = {prototype, mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    mal_object_set_prototype(object, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_TRANSFORM_PROTOTYPE]));
    MalPropertyFlags hidden = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE;
    for (usize i = 0; i < countof(CRYPTO_LAZY_STREAM_METHODS); i++) {
        roots[1] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) CRYPTO_LAZY_STREAM_METHODS[i]));
        roots[2] = mal_value_new_undefined();
        (void) mal_vm_get_property(vm, vm->intrinsics[MAL_INTRINSIC_NODE_TRANSFORM_PROTOTYPE],
            mal_key_from_value(roots[1]), &roots[2]);
        i32 length = 0;
        MalValue length_value = mal_value_new_undefined();
        if (mal_value_is_callable(roots[2])
            && mal_vm_get_property(vm, roots[2], mal_intrinsic_string_key(vm, (const byte *) "length"), &length_value)
            && mal_ops_is_number(length_value)) {
            length = (i32) mal_ops_number_as_f64(length_value);
        }
        roots[3] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) CRYPTO_LAZY_STREAM_METHODS[i]), length,
            mal_node_crypto_lazy_stream_method, &roots[1], 1));
        mal_intrinsic_define_data(vm, object, (const byte *) CRYPTO_LAZY_STREAM_METHODS[i], roots[3], hidden);
    }
    MalValue methods[2];
    MalPropertyLookup update = mal_object_get_own(object, mal_intrinsic_string_key(vm, (const byte *) update_name));
    MalPropertyLookup finish = mal_object_get_own(object, mal_intrinsic_string_key(vm, (const byte *) finish_name));
    methods[0] = update.present ? update.desc.value : mal_value_new_undefined();
    methods[1] = finish.present ? finish.desc.value : mal_value_new_undefined();
    roots[1] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "_transform"), 3, transform, methods, 2));
    mal_intrinsic_define_data(vm, object, (const byte *) "_transform", roots[1], hidden);
    roots[1] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "_flush"), 1, flush, methods, 2));
    mal_intrinsic_define_data(vm, object, (const byte *) "_flush", roots[1], hidden);
    mal_gc_unroot(&root);
}

/* The flat exports (everything that needs no private-symbol slot). Lengths match
 * Node's, which the fixture pins. */
static const CryptoExport CRYPTO_EXPORTS[] = {
    {"argon2", 3, mal_node_crypto_argon2},
    {"argon2Sync", 2, mal_node_crypto_argon2_sync},
    {"hash", 3, mal_node_crypto_hash},
    {"pbkdf2", 6, mal_node_crypto_pbkdf2},
    {"pbkdf2Sync", 5, mal_node_crypto_pbkdf2_sync},
    {"scrypt", 5, mal_node_crypto_scrypt},
    {"scryptSync", 4, mal_node_crypto_scrypt_sync},
    {"hkdf", 6, mal_node_crypto_hkdf},
    {"hkdfSync", 5, mal_node_crypto_hkdf_sync},
    {"randomFill", 4, mal_node_crypto_random_fill},
    {"randomFillSync", 3, mal_node_crypto_random_fill_sync},
    {"getRandomValues", 1, mal_node_crypto_get_random_values},
    {"randomUUIDv7", 0, mal_node_crypto_random_uuid_v7},
    {"createSecretKey", 2, mal_node_crypto_create_secret_key},
    {"createCipheriv", 4, mal_node_crypto_create_cipheriv},
    {"createDecipheriv", 4, mal_node_crypto_create_decipheriv},
    {"getCipherInfo", 2, mal_node_crypto_get_cipher_info},
    {"getHashes", 0, mal_node_crypto_get_hashes},
    {"getCiphers", 0, mal_node_crypto_get_ciphers},
    {"getCurves", 0, mal_node_crypto_get_curves},
    {"randomBytes", 2, mal_node_crypto_random_bytes},
    {"randomInt", 3, mal_node_crypto_random_int},
    {"randomUUID", 1, mal_node_crypto_random_uuid},
    {"timingSafeEqual", 0, mal_node_crypto_timing_safe_equal},
    {"createPrivateKey", 1, mal_node_crypto_create_private_key},
    {"createPublicKey", 1, mal_node_crypto_create_public_key},
    {"createSign", 2, mal_node_crypto_create_sign},
    {"createVerify", 2, mal_node_crypto_create_verify},
    {"sign", 4, mal_node_crypto_sign_one_shot},
    {"verify", 5, mal_node_crypto_verify_one_shot},
    {"generateKeyPair", 3, mal_node_crypto_generate_key_pair},
    {"generateKeyPairSync", 2, mal_node_crypto_generate_key_pair_sync},
    {"generateKey", 3, mal_node_crypto_generate_key},
    {"generateKeySync", 2, mal_node_crypto_generate_key_sync},
	{"publicEncrypt", 2, mal_node_crypto_asymmetric_unavailable},
};

void mal_host_install_node_crypto(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:crypto", slots, count)) return;
    MalValue cached = vm->intrinsics[MAL_INTRINSIC_NODE_CRYPTO_MODULE];
    if (!mal_value_is_undefined(cached)) {
        mal_node_module_publish(vm, "node:crypto", slots, count, cached);
        return;
    }

    MalValue roots[9];
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

    // Hmac objects share the methods but not the prototype, so instanceof tells them apart.
    roots[7] = mal_value_from_object(mal_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[7]), (const byte *) "update",
        roots[2], method_flags);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[7]), (const byte *) "digest",
        roots[3], method_flags);
    MalValue factory_slots[] = {roots[0], roots[1]};
    MalValue hmac_slots[] = {roots[0], roots[7]};
    roots[4] = mal_value_from_native_function_object(mal_node_crypto_function_with_slots(
        vm, "createHash", 2, mal_node_crypto_create_hash, factory_slots,
        countof(factory_slots)));
    roots[5] = mal_value_from_native_function_object(mal_node_crypto_function_with_slots(
        vm, "createHmac", 3, mal_node_crypto_create_hmac, hmac_slots,
        countof(hmac_slots)));

    roots[6] = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalObject *module = mal_value_to_object(roots[6]);
    mal_intrinsic_define_data(vm, module, (const byte *) "createHash", roots[4], method_flags);
    mal_intrinsic_define_data(vm, module, (const byte *) "createHmac", roots[5], method_flags);
    roots[8] = crypto_digest_class(vm, module, "Hash", 2, mal_node_crypto_hash_constructor, factory_slots);
    roots[8] = crypto_digest_class(vm, module, "Hmac", 3, mal_node_crypto_hmac_constructor, hmac_slots);
    for (usize i = 0; i < countof(CRYPTO_EXPORTS); i++) {
        const CryptoExport *export_entry = &CRYPTO_EXPORTS[i];
		MalNativeFunctionObject *native = mal_native_function_object_new_arity(
			&vm->heap,
			mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
			mal_intrinsic_ascii(vm, (const byte *) export_entry->name),
			export_entry->length, export_entry->callback);
		MalValue function = mal_value_from_native_function_object(native);
        MalRootSpan function_root;
        mal_gc_root(&function_root, &function, 1);
        mal_intrinsic_define_data(
            vm, module, (const byte *) export_entry->name, function, method_flags);
        mal_gc_unroot(&function_root);
    }

    crypto_install_key_objects(vm, module);
    mal_host_install_node_stream(vm, nullptr, 0, launch);
    if (vm->completion.kind == MAL_COMPLETION_THROW) { mal_gc_unroot(&root); return; }
    crypto_install_asymmetric(vm, module);
    crypto_install_x509(vm, module);
    mal_node_key_object_brand = crypto_key_object_brand;
    mal_node_crypto_key_brand = crypto_crypto_key_brand;
    crypto_install_webcrypto(vm, module);
    crypto_install_web_globals(vm, module);
    crypto_install_ciphers(vm, module);
    crypto_lazy_transform_prototype(vm, roots[1], "update", "digest",
        mal_node_crypto_digest_transform, mal_node_crypto_digest_flush);
    crypto_lazy_transform_prototype(vm, roots[7], "update", "digest",
        mal_node_crypto_digest_transform, mal_node_crypto_digest_flush);
    crypto_lazy_transform_prototype(vm, crypto_cipheriv_prototype, "update", "final",
        mal_node_crypto_cipher_transform, mal_node_crypto_cipher_flush);
    crypto_lazy_transform_prototype(vm, crypto_decipheriv_prototype, "update", "final",
        mal_node_crypto_cipher_transform, mal_node_crypto_cipher_flush);
    roots[2] = crypto_constants_object(vm);
    mal_intrinsic_define_data(vm, module, (const byte *) "constants", roots[2], method_flags);

    if (!crypto_roots_installed) {
        mal_gc_register_root_source(crypto_scan_roots, nullptr);
        mal_host_register_macrotask_drain(mal_node_crypto_drain, false);
        // This program already links the entropy boundary, so Math.random's
        // generator can be seeded from it rather than from process divergence.
        // Math.random remains non-cryptographic; see builtin_math.h.
        mal_builtin_math_set_seed_source(mal_host_entropy);
        crypto_roots_installed = true;
    }
    if (!mal_vm_register_runtime_cleanup(vm, mal_node_crypto_free)) {
        mal_gc_unroot(&root);
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Could not register node:crypto runtime cleanup");
        return;
    }
    vm->intrinsics[MAL_INTRINSIC_NODE_CRYPTO_MODULE] = roots[6];
    mal_node_module_publish(vm, "node:crypto", slots, count, roots[6]);
    mal_gc_unroot(&root);
}

#endif // MAL_NODE
