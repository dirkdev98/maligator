#pragma once

#include <string.h>

#include "defaults.h"

/* Native-order unaligned transport for TypedArray backing stores. DataView uses
 * endian.h instead; these helpers intentionally retain the host byte order. */
static inline u8 mal_scalar_load_native_u8(const void *source) {
    u8 value;
    memcpy(&value, source, sizeof value);
    return value;
}

static inline u16 mal_scalar_load_native_u16(const void *source) {
    u16 value;
    memcpy(&value, source, sizeof value);
    return value;
}

static inline u32 mal_scalar_load_native_u32(const void *source) {
    u32 value;
    memcpy(&value, source, sizeof value);
    return value;
}

static inline u64 mal_scalar_load_native_u64(const void *source) {
    u64 value;
    memcpy(&value, source, sizeof value);
    return value;
}

static inline void mal_scalar_store_native_u8(void *destination, u8 value) {
    memcpy(destination, &value, sizeof value);
}

static inline void mal_scalar_store_native_u16(void *destination, u16 value) {
    memcpy(destination, &value, sizeof value);
}

static inline void mal_scalar_store_native_u32(void *destination, u32 value) {
    memcpy(destination, &value, sizeof value);
}

static inline void mal_scalar_store_native_u64(void *destination, u64 value) {
    memcpy(destination, &value, sizeof value);
}

/* Reinterpret scalar object representations without aliasing or alignment UB. */
static inline i8 mal_scalar_i8_from_bits(u8 bits) {
    i8 value;
    memcpy(&value, &bits, sizeof value);
    return value;
}

static inline i16 mal_scalar_i16_from_bits(u16 bits) {
    i16 value;
    memcpy(&value, &bits, sizeof value);
    return value;
}

static inline i32 mal_scalar_i32_from_bits(u32 bits) {
    i32 value;
    memcpy(&value, &bits, sizeof value);
    return value;
}

static inline i64 mal_scalar_i64_from_bits(u64 bits) {
    i64 value;
    memcpy(&value, &bits, sizeof value);
    return value;
}

static inline f32 mal_scalar_f32_from_bits(u32 bits) {
    f32 value;
    memcpy(&value, &bits, sizeof value);
    return value;
}

static inline f64 mal_scalar_f64_from_bits(u64 bits) {
    f64 value;
    memcpy(&value, &bits, sizeof value);
    return value;
}

static inline u32 mal_scalar_f32_to_bits(f32 value) {
    u32 bits;
    memcpy(&bits, &value, sizeof bits);
    return bits;
}

static inline u64 mal_scalar_f64_to_bits(f64 value) {
    u64 bits;
    memcpy(&bits, &value, sizeof bits);
    return bits;
}
