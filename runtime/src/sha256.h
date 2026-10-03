#pragma once

#include "./defaults.h"

typedef struct {
    u32 state[8];
    u64 bit_len;   // total message length in bits (of fully-absorbed data)
    u8 block[64];  // partial block being filled
    usize block_len;
} MalSha256;

void mal_sha256_init(MalSha256 *context);
void mal_sha256_update(MalSha256 *context, const u8 *data, usize length);
void mal_sha256_final(MalSha256 *context, u8 out[32]);
