#pragma once

#include "defaults.h"

/* Explicit-endian integer transport. These byte-wise operations accept
 * unaligned addresses and do not depend on the host byte order. */
static inline u16 mal_load_u16_le(const void *source) {
    const u8 *bytes = source;
    return (u16) ((u16) bytes[0] | ((u16) bytes[1] << 8));
}

static inline u16 mal_load_u16_be(const void *source) {
    const u8 *bytes = source;
    return (u16) (((u16) bytes[0] << 8) | (u16) bytes[1]);
}

static inline u32 mal_load_u32_le(const void *source) {
    const u8 *bytes = source;
    return (u32) bytes[0] | ((u32) bytes[1] << 8) |
           ((u32) bytes[2] << 16) | ((u32) bytes[3] << 24);
}

static inline u32 mal_load_u32_be(const void *source) {
    const u8 *bytes = source;
    return ((u32) bytes[0] << 24) | ((u32) bytes[1] << 16) |
           ((u32) bytes[2] << 8) | (u32) bytes[3];
}

static inline u64 mal_load_u64_le(const void *source) {
    const u8 *bytes = source;
    return (u64) bytes[0] | ((u64) bytes[1] << 8) |
           ((u64) bytes[2] << 16) | ((u64) bytes[3] << 24) |
           ((u64) bytes[4] << 32) | ((u64) bytes[5] << 40) |
           ((u64) bytes[6] << 48) | ((u64) bytes[7] << 56);
}

static inline u64 mal_load_u64_be(const void *source) {
    const u8 *bytes = source;
    return ((u64) bytes[0] << 56) | ((u64) bytes[1] << 48) |
           ((u64) bytes[2] << 40) | ((u64) bytes[3] << 32) |
           ((u64) bytes[4] << 24) | ((u64) bytes[5] << 16) |
           ((u64) bytes[6] << 8) | (u64) bytes[7];
}

static inline void mal_store_u16_le(void *destination, u16 value) {
    u8 *bytes = destination;
    bytes[0] = (u8) value;
    bytes[1] = (u8) (value >> 8);
}

static inline void mal_store_u16_be(void *destination, u16 value) {
    u8 *bytes = destination;
    bytes[0] = (u8) (value >> 8);
    bytes[1] = (u8) value;
}

static inline void mal_store_u32_le(void *destination, u32 value) {
    u8 *bytes = destination;
    bytes[0] = (u8) value;
    bytes[1] = (u8) (value >> 8);
    bytes[2] = (u8) (value >> 16);
    bytes[3] = (u8) (value >> 24);
}

static inline void mal_store_u32_be(void *destination, u32 value) {
    u8 *bytes = destination;
    bytes[0] = (u8) (value >> 24);
    bytes[1] = (u8) (value >> 16);
    bytes[2] = (u8) (value >> 8);
    bytes[3] = (u8) value;
}

static inline void mal_store_u64_le(void *destination, u64 value) {
    u8 *bytes = destination;
    for (u32 index = 0; index < 8; index++) {
        bytes[index] = (u8) (value >> (index * 8));
    }
}

static inline void mal_store_u64_be(void *destination, u64 value) {
    u8 *bytes = destination;
    for (u32 index = 0; index < 8; index++) {
        bytes[index] = (u8) (value >> ((7 - index) * 8));
    }
}
