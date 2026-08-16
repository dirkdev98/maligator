#pragma once

#include "defaults.h"

#if MAL_PROFILE
#include <signal.h>
#endif

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
    MAL_PROFILE_SITE_FALLBACK = 1,
    MAL_PROFILE_SITE_ALLOCATION_COUNT = 2,
    MAL_PROFILE_SITE_ALLOCATION_REQUESTED_BYTES = 3,
    MAL_PROFILE_SITE_ALLOCATION_CHARGED_BYTES = 4,
    MAL_PROFILE_SITE_BOXING = 5,
    MAL_PROFILE_SITE_SAFEPOINT = 6,
    MAL_PROFILE_SITE_GC = 7,
    MAL_PROFILE_SITE_EVENT_COUNT = 8,
};

typedef enum MalProfileAllocationStorage : u8 {
    MAL_PROFILE_ALLOCATION_NONE = 0,
    MAL_PROFILE_ALLOCATION_MANAGED_CELL = 1,
    MAL_PROFILE_ALLOCATION_RAW_PAYLOAD = 2,
    MAL_PROFILE_ALLOCATION_NATIVE_BACKING = 3,
} MalProfileAllocationStorage;

/** Stable, deliberately coarse allocation families exposed by profile artifacts. */
typedef enum MalProfileAllocationFamily : u8 {
    MAL_PROFILE_ALLOCATION_FAMILY_UNKNOWN = 0,
    MAL_PROFILE_ALLOCATION_FAMILY_OBJECT = 1,
    MAL_PROFILE_ALLOCATION_FAMILY_STRING = 2,
    MAL_PROFILE_ALLOCATION_FAMILY_ARRAY = 3,
    MAL_PROFILE_ALLOCATION_FAMILY_FUNCTION = 4,
    MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION = 5,
    MAL_PROFILE_ALLOCATION_FAMILY_BUFFER = 6,
    MAL_PROFILE_ALLOCATION_FAMILY_REGEXP = 7,
    MAL_PROFILE_ALLOCATION_FAMILY_PROMISE = 8,
    MAL_PROFILE_ALLOCATION_FAMILY_ITERATOR = 9,
    MAL_PROFILE_ALLOCATION_FAMILY_HOST = 10,
    MAL_PROFILE_ALLOCATION_FAMILY_METADATA = 11,
} MalProfileAllocationFamily;

#define MAL_PROFILE_OBJECT_TYPE_NONE 0xffu

#if MAL_PROFILE
extern volatile sig_atomic_t mal_profile_poll_requested;
void mal_profile_init(MalVm *vm);
void mal_profile_finish(MalVm *vm);
void mal_profile_safepoint_slow(MalVm *vm);
void mal_profile_allocation(
    MalHeap *heap, usize requested_size, usize charged_size,
    MalProfileAllocationStorage storage, MalProfileAllocationFamily family,
    u8 object_type);
void mal_profile_native_allocation(
    MalHeap *heap, usize size, MalProfileAllocationFamily family);
void mal_profile_event(MalVm *vm, u8 kind, u64 value);
#if defined(MAL_PERF_STATS) && MAL_PERF_STATS
void mal_profile_site_event(MalVm *vm, i32 site_id, u8 event, u64 value);
void mal_profile_safepoint_compiler(MalVm *vm);
#define MAL_PROFILE_SITE_EVENT(vm, site_id, event, value) \
    mal_profile_site_event((vm), (site_id), (event), (value))
#define MAL_PROFILE_CURRENT_SITE(vm, site_id) ((vm)->profile_current_site_id = (site_id))
#define MAL_PROFILE_SITE_BOX(vm, site_id, value) \
    (mal_profile_site_event((vm), (site_id), MAL_PROFILE_SITE_BOXING, 1), (value))
#define MAL_PROFILE_FALLBACK_VALUE(vm, site_id, value) \
    (mal_profile_site_event((vm), (site_id), MAL_PROFILE_SITE_FALLBACK, 1), (value))
#else
#define MAL_PROFILE_SITE_EVENT(vm, site_id, event, value) ((void) 0)
#define MAL_PROFILE_CURRENT_SITE(vm, site_id) ((void) 0)
#define MAL_PROFILE_SITE_BOX(vm, site_id, value) (value)
#define MAL_PROFILE_FALLBACK_VALUE(vm, site_id, value) (value)
#endif
static inline void mal_profile_safepoint(MalVm *vm) {
#if defined(MAL_PERF_STATS) && MAL_PERF_STATS
    mal_profile_safepoint_compiler(vm);
#endif
    if (__builtin_expect(mal_profile_poll_requested != 0, 0)) {
        mal_profile_safepoint_slow(vm);
    }
}
#else
static inline void mal_profile_init(MalVm *vm) { (void) vm; }
static inline void mal_profile_finish(MalVm *vm) { (void) vm; }
static inline void mal_profile_safepoint(MalVm *vm) { (void) vm; }
static inline void mal_profile_allocation(
    MalHeap *heap, usize requested_size, usize charged_size,
    MalProfileAllocationStorage storage, MalProfileAllocationFamily family,
    u8 object_type) {
    (void) heap;
    (void) requested_size;
    (void) charged_size;
    (void) storage;
    (void) family;
    (void) object_type;
}
static inline void mal_profile_native_allocation(
    MalHeap *heap, usize size, MalProfileAllocationFamily family) {
    (void) heap;
    (void) size;
    (void) family;
}
static inline void mal_profile_event(MalVm *vm, u8 kind, u64 value) {
    (void) vm;
    (void) kind;
    (void) value;
}
#define MAL_PROFILE_SITE_EVENT(vm, site_id, event, value) ((void) 0)
#define MAL_PROFILE_CURRENT_SITE(vm, site_id) ((void) 0)
#define MAL_PROFILE_SITE_BOX(vm, site_id, value) (value)
#define MAL_PROFILE_FALLBACK_VALUE(vm, site_id, value) (value)
#endif
