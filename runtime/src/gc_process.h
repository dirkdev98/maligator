#pragma once

#include "defaults.h"

typedef struct MalGcPollTarget MalGcPollTarget;
typedef struct MalGcProcessParticipant MalGcProcessParticipant;

MalGcProcessParticipant *mal_gc_process_register(MalGcPollTarget *poll);
void mal_gc_process_unregister(MalGcProcessParticipant *participant);
// Only the owning mutator consumes pressure; unregister follows its final take.
bool mal_gc_process_take_pressure(MalGcProcessParticipant *participant);
void mal_gc_process_set_busy(MalGcProcessParticipant *participant, bool busy);
void mal_gc_process_set_waker(MalGcProcessParticipant *participant, void (*wake)(void *), void *data);
// Reserved backing bytes include heap mappings, ordinary/shared stores, and admitted snapshots once each.
void mal_gc_process_charge(usize bytes);
void mal_gc_process_release(usize bytes);
usize mal_gc_process_bytes(void);
usize mal_gc_process_budget(void);
usize mal_gc_process_cpu_capacity(void);
// Grants are bounded quanta; a waking mutator does not wait for an already running helper.
bool mal_gc_process_helper_acquire(void);
void mal_gc_process_helper_release(void);
