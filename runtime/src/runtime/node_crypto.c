#include "node_crypto.h"

#include <stdlib.h>
#include <string.h>

#include "array_buffer_object.h"
#include "builtin_data_view.h"
#include "function_object.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "text_encoding.h"
#include "typed_array_object.h"
#include "value.h"
#include "vm.h"
#include "vm_ops.h"

#if MAL_NODE

// DataView keeps its layout private to builtin_data_view.c. The runtime crypto
// adapter needs the view window as well as the publicly exposed backing buffer.
// Keep this definition in sync with MalDataViewObject there.
struct MalDataViewObject {
    MalObject object;
    MalArrayBufferObject *buffer;
    u32 byte_offset;
    u32 byte_length;
    bool length_tracking;
};

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

/* ---------------------------------------------------------------------------
 * The `hash` export.
 * --------------------------------------------------------------------------- */

/* True when `str` is exactly the ASCII literal `ascii` of length `n`. Used for the
 * algorithm and output-encoding checks — both must match one fixed lowercase word,
 * so a code-unit-wise compare (no allocation, no ToLower) is enough. */
static bool mal_node_crypto_str_is(const MalString *str, const char *ascii, usize n) {
    if (mal_string_length(str) != n) {
        return false;
    }
    const c16 *units = mal_string_code_units(str);
    for (usize i = 0; i < n; i++) {
        if (units[i] != (c16) (u8) ascii[i]) {
            return false;
        }
    }
    return true;
}

typedef struct {
    const u8 *data;
    usize length;
} MalNodeCryptoByteSpan;

static bool mal_node_crypto_data_view_is_out_of_bounds(const MalDataViewObject *view) {
    MalArrayBufferObject *buffer = view->buffer;
    if (buffer == nullptr || buffer->detached) {
        return true;
    }
    if (view->length_tracking) {
        return view->byte_offset > buffer->byte_length;
    }
    return (u64) view->byte_offset + view->byte_length > buffer->byte_length;
}

// Validate the complete view before applying its byte offset. In particular,
// detached stores have null data, so even adding a zero offset would be undefined.
static bool mal_node_crypto_byte_span(MalVm *vm, MalValue value, MalNodeCryptoByteSpan *out) {
    MalArrayBufferObject *buffer;
    u32 byte_offset = 0;
    u32 byte_length;

    if (mal_value_is_typed_array_object(value)) {
        MalTypedArrayObject *view = mal_value_to_typed_array_object(value);
        if (mal_typed_array_object_is_out_of_bounds(view)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                (const byte *) "crypto.hash: detached or out-of-bounds byte source");
            return false;
        }
        buffer = view->buffer;
        byte_offset = view->byte_offset;
        byte_length = mal_typed_array_object_byte_length(view);
    } else if (mal_value_is_data_view_object(value)) {
        MalDataViewObject *view = mal_value_to_data_view_object(value);
        if (mal_node_crypto_data_view_is_out_of_bounds(view)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                (const byte *) "crypto.hash: detached or out-of-bounds byte source");
            return false;
        }
        buffer = view->buffer;
        byte_offset = view->byte_offset;
        byte_length = view->length_tracking ? buffer->byte_length - byte_offset : view->byte_length;
    } else {
        buffer = mal_value_to_array_buffer_object(value);
        if (buffer->detached) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                (const byte *) "crypto.hash: detached or out-of-bounds byte source");
            return false;
        }
        byte_length = buffer->byte_length;
    }

    out->length = byte_length;
    out->data = byte_length == 0 ? nullptr : (const u8 *) buffer->data + byte_offset;
    return true;
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
        MalNodeCryptoByteSpan span;
        if (!mal_node_crypto_byte_span(vm, data, &span)) {
            return mal_value_new_undefined();
        }
        if (span.length > 0) {
            mal_sha256_update(&ctx, span.data, span.length);
        }
    } else {
        MalString *data_str = mal_value_to_string(data);
        usize byte_len;
        byte *bytes =
            mal_utf8_encode(mal_string_code_units(data_str), mal_string_length(data_str), &byte_len);
        mal_sha256_update(&ctx, (const u8 *) bytes, byte_len);
        free(bytes);
    }

    u8 digest[32];
    mal_sha256_final(&ctx, digest);

    static const char HEX[] = "0123456789abcdef";
    char hex[64];
    for (int i = 0; i < 32; i++) {
        hex[i * 2] = HEX[(digest[i] >> 4) & 0xF];
        hex[i * 2 + 1] = HEX[digest[i] & 0xF];
    }
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, (const byte *) hex, 64));
}

void mal_host_install_node_crypto(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) launch;
    MalObject *function_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    for (i32 i = 0; i < count; i++) {
        // Only `hash` is exported; any other requested slot is left undefined.
        if (strcmp(slots[i].name, "hash") == 0) {
            MalNativeFunctionObject *fn = mal_native_function_object_new_arity(&vm->heap,
                function_prototype, mal_intrinsic_ascii(vm, (const byte *) "hash"), 2,
                mal_node_crypto_hash);
            vm->globals[slots[i].slot] = mal_value_from_native_function_object(fn);
        }
    }
}

#endif // MAL_NODE
