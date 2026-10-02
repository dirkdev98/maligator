#pragma once

#include <string.h>
#include <stdlib.h>

#include "defaults.h"
#include "perf_stats.h"

#if defined(__ARM_NEON) && !defined(MAL_HASH_FORCE_SCALAR)
#include <arm_neon.h>
#define MAL_HASH_MASK_SHIFT 2
#elif defined(__SSE2__) && !defined(MAL_HASH_FORCE_SCALAR)
#include <emmintrin.h>
#define MAL_HASH_MASK_SHIFT 0
#else
#define MAL_HASH_MASK_SHIFT 0
#endif

#define MAL_HASH_GROUP_WIDTH 16
#define MAL_HASH_EMPTY UINT8_C(0x80)
#define MAL_HASH_DELETED UINT8_C(0xfe)

typedef u64 MalHashMask;

typedef struct MalHashProbe {
    u32 group;
    u32 stride;
    u32 mask;
} MalHashProbe;

static inline u8 mal_hash_tag(u64 hash) {
    return (u8) (hash >> 57);
}

static inline usize mal_hash_index_bytes(u32 capacity) {
    if ((usize) capacity > SIZE_MAX / (sizeof(i32) + sizeof(u8))) abort();
    return (usize) capacity * (sizeof(i32) + sizeof(u8));
}

static inline u8 *mal_hash_controls(const i32 *slots, u32 capacity) {
    return (u8 *) (slots + capacity);
}

static inline void mal_hash_index_reset(i32 *slots, u32 capacity) {
    memset(mal_hash_controls(slots, capacity), MAL_HASH_EMPTY, capacity);
}

static inline MalHashMask mal_hash_group_match_scalar(const u8 *controls, u8 tag) {
    MalHashMask mask = 0;
    for (u32 i = 0; i < MAL_HASH_GROUP_WIDTH; i++) {
        if (controls[i] == tag) mask |= UINT64_C(1) << (i << MAL_HASH_MASK_SHIFT);
    }
    return mask;
}

static inline MalHashMask mal_hash_group_match(const u8 *controls, u8 tag) {
#if defined(__ARM_NEON) && !defined(MAL_HASH_FORCE_SCALAR)
    uint8x16_t matches = vceqq_u8(vld1q_u8(controls), vdupq_n_u8(tag));
    // Each byte pair becomes two nibbles; one bit per nibble makes ctz enumerate lanes.
    return vget_lane_u64(vreinterpret_u64_u8(vshrn_n_u16(vreinterpretq_u16_u8(matches), 4)), 0)
        & UINT64_C(0x1111111111111111);
#elif defined(__SSE2__) && !defined(MAL_HASH_FORCE_SCALAR)
    return (u32) _mm_movemask_epi8(_mm_cmpeq_epi8(
        _mm_loadu_si128((const __m128i *) controls), _mm_set1_epi8((char) tag)));
#else
    return mal_hash_group_match_scalar(controls, tag);
#endif
}

static inline u32 mal_hash_mask_first(MalHashMask mask) {
    return (u32) __builtin_ctzll(mask) >> MAL_HASH_MASK_SHIFT;
}

static inline MalHashProbe mal_hash_probe(u64 hash, u32 capacity) {
    return (MalHashProbe) {
        .group = ((u32) hash & (capacity - 1)) & ~(MAL_HASH_GROUP_WIDTH - 1),
        .mask = capacity - 1,
    };
}

static inline void mal_hash_probe_next(MalHashProbe *probe) {
    // Triangular strides visit every group exactly once at power-of-two capacities.
    probe->stride += MAL_HASH_GROUP_WIDTH;
    if (probe->stride > probe->mask) abort();
    probe->group = (probe->group + probe->stride) & probe->mask;
}

static inline bool mal_hash_slot_live(const i32 *slots, u32 capacity, u32 slot) {
    return mal_hash_controls(slots, capacity)[slot] < MAL_HASH_EMPTY;
}

static inline void mal_hash_index_insert(i32 *slots, u32 capacity, u32 slot, u32 entry, u64 hash) {
    if (mal_hash_controls(slots, capacity)[slot] == MAL_HASH_DELETED) {
        MAL_PERF_COUNT(hash_index_tombstone_reuses);
    }
    slots[slot] = (i32) entry;
    mal_hash_controls(slots, capacity)[slot] = mal_hash_tag(hash);
}

static inline u32 mal_hash_controls_empty_slot(const u8 *controls, u32 capacity, u64 hash) {
    MalHashProbe probe = mal_hash_probe(hash, capacity);
    for (;;) {
        MalHashMask empty = mal_hash_group_match(controls + probe.group, MAL_HASH_EMPTY);
        if (empty != 0) return probe.group + mal_hash_mask_first(empty);
        mal_hash_probe_next(&probe);
    }
}

static inline u32 mal_hash_index_empty_slot(i32 *slots, u32 capacity, u64 hash) {
    return mal_hash_controls_empty_slot(mal_hash_controls(slots, capacity), capacity, hash);
}

static inline bool mal_hash_controls_erase(u8 *controls, u32 slot) {
    u32 group = slot & ~(MAL_HASH_GROUP_WIDTH - 1);
    // An existing empty proves searches already stop here; a full group needs a tombstone.
    bool deleted = mal_hash_group_match(controls + group, MAL_HASH_EMPTY) == 0;
    controls[slot] = deleted ? MAL_HASH_DELETED : MAL_HASH_EMPTY;
    return deleted;
}

static inline bool mal_hash_index_erase(i32 *slots, u32 capacity, u32 slot) {
    return mal_hash_controls_erase(mal_hash_controls(slots, capacity), slot);
}

static inline bool mal_hash_index_fits(usize size, u32 capacity) {
    return size <= capacity - capacity / 8;
}
