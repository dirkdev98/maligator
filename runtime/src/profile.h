#pragma once

#include "defaults.h"

typedef struct MalVm MalVm;
typedef struct MalHeap MalHeap;

enum {
    MAL_PROFILE_RECORD_CPU = 1,
    MAL_PROFILE_RECORD_ALLOCATION = 2,
    MAL_PROFILE_RECORD_GC_BEGIN = 3,
    MAL_PROFILE_RECORD_GC_END = 4,
};

enum {
    MAL_PROFILE_SITE_EXECUTION = 0,
    MAL_PROFILE_SITE_FAST_PATH = 1,
    MAL_PROFILE_SITE_FALLBACK = 2,
    MAL_PROFILE_SITE_ALLOCATION_COUNT = 3,
    MAL_PROFILE_SITE_ALLOCATION_BYTES = 4,
    MAL_PROFILE_SITE_BOXING = 5,
    MAL_PROFILE_SITE_SAFEPOINT = 6,
    MAL_PROFILE_SITE_GC = 7,
    MAL_PROFILE_SITE_EVENT_COUNT = 8,
};

#if MAL_PROFILE
void mal_profile_init(MalVm *vm);
void mal_profile_finish(MalVm *vm);
void mal_profile_safepoint(MalVm *vm);
void mal_profile_allocation(MalHeap *heap, usize size, u8 heap_type);
void mal_profile_event(MalVm *vm, u8 kind, u64 value);
#if defined(MAL_PERF_STATS) && MAL_PERF_STATS
void mal_profile_site_event(MalVm *vm, i32 site_id, u8 event, u64 value);
#define MAL_PROFILE_SITE_EVENT(vm, site_id, event, value) \
    mal_profile_site_event((vm), (site_id), (event), (value))
#define MAL_PROFILE_SITE_BOX(vm, site_id, value) \
    (mal_profile_site_event((vm), (site_id), MAL_PROFILE_SITE_BOXING, 1), (value))
#define MAL_PROFILE_FALLBACK_VALUE(vm, site_id, value) \
    (mal_profile_site_event((vm), (site_id), MAL_PROFILE_SITE_FALLBACK, 1), (value))
#else
#define MAL_PROFILE_SITE_EVENT(vm, site_id, event, value) ((void) 0)
#define MAL_PROFILE_SITE_BOX(vm, site_id, value) (value)
#define MAL_PROFILE_FALLBACK_VALUE(vm, site_id, value) (value)
#endif
#else
static inline void mal_profile_init(MalVm *vm) { (void) vm; }
static inline void mal_profile_finish(MalVm *vm) { (void) vm; }
static inline void mal_profile_safepoint(MalVm *vm) { (void) vm; }
static inline void mal_profile_allocation(MalHeap *heap, usize size, u8 heap_type) {
    (void) heap;
    (void) size;
    (void) heap_type;
}
static inline void mal_profile_event(MalVm *vm, u8 kind, u64 value) {
    (void) vm;
    (void) kind;
    (void) value;
}
#define MAL_PROFILE_SITE_EVENT(vm, site_id, event, value) ((void) 0)
#define MAL_PROFILE_SITE_BOX(vm, site_id, value) (value)
#define MAL_PROFILE_FALLBACK_VALUE(vm, site_id, value) (value)
#endif
