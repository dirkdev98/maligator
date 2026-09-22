#pragma once

#include "defaults.h"

typedef struct MalVm MalVm;

#if MAL_PGO
void mal_pgo_init(MalVm *vm);
void mal_pgo_finish(MalVm *vm);
void mal_pgo_entry(MalVm *vm, i32 function_index);
void mal_pgo_call(MalVm *vm, i32 site);
#else
static inline void mal_pgo_init(MalVm *vm) { (void) vm; }
static inline void mal_pgo_finish(MalVm *vm) { (void) vm; }
static inline void mal_pgo_entry(MalVm *vm, i32 function_index) { (void) vm; (void) function_index; }
static inline void mal_pgo_call(MalVm *vm, i32 site) { (void) vm; (void) site; }
#endif
