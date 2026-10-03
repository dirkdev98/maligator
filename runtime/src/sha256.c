#include "sha256.h"

#include <string.h>


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

void mal_sha256_init(MalSha256 *ctx) {
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

void mal_sha256_update(MalSha256 *ctx, const u8 *data, usize len) {
    for (usize i = 0; i < len; i++) {
        ctx->block[ctx->block_len++] = data[i];
        if (ctx->block_len == 64) {
            mal_sha256_compress(ctx, ctx->block);
            ctx->bit_len += 512;
            ctx->block_len = 0;
        }
    }
}

void mal_sha256_final(MalSha256 *ctx, u8 out[32]) {
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

