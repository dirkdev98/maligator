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

#if MAL_PROFILE
void mal_profile_init(MalVm *vm);
void mal_profile_finish(MalVm *vm);
void mal_profile_safepoint(MalVm *vm);
void mal_profile_allocation(MalHeap *heap, usize size, u8 heap_type);
void mal_profile_event(MalVm *vm, u8 kind, u64 value);
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
#endif
