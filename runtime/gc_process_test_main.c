#include "vm.h"
#include "gc_process.h"
#include "array_buffer_object.h"
#include "array_object.h"
#include "intrinsics.h"
#include "serialize.h"
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>

extern const MalRuntimeImage mal_runtime_image;

static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t condition = PTHREAD_COND_INITIALIZER;
static usize ready;
static bool charged;
static _Atomic usize serviced;

static void *owner(void *data) {
    (void) data;
    MalGcProcessParticipant *participant = mal_gc_process_register(mal_gc_current_poll_target());
    pthread_mutex_lock(&mutex);
    ready++;
    pthread_cond_broadcast(&condition);
    while (!charged) pthread_cond_wait(&condition, &mutex);
    pthread_mutex_unlock(&mutex);
    if (!mal_gc_poll || !mal_gc_process_take_pressure(participant) ||
        mal_gc_process_take_pressure(participant)) abort();
    atomic_fetch_add(&serviced, 1);
    mal_gc_process_unregister(participant);
    return nullptr;
}

static void check_pressure_after_released_peak(void) {
    usize before = mal_gc_process_bytes();
    usize budget = mal_gc_process_budget();
    usize growth = budget / 16;
    MalGcProcessParticipant *participant = mal_gc_process_register(mal_gc_current_poll_target());
    mal_gc_process_charge(budget);
    mal_gc_process_charge(budget * 4);
    if (!mal_gc_process_take_pressure(participant)) abort();
    mal_gc_process_release(budget * 4);
    if (mal_gc_process_bytes() < budget) abort();
    mal_gc_process_charge(growth);
    if (!mal_gc_process_take_pressure(participant) ||
        mal_gc_process_take_pressure(participant)) abort();
    mal_gc_process_release(growth);
    mal_gc_process_release(budget);
    if (mal_gc_process_bytes() != before) abort();
    mal_gc_process_unregister(participant);
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    usize baseline = mal_gc_process_bytes();
    pthread_t owners[2];
    for (usize i = 0; i < countof(owners); i++) {
        if (pthread_create(&owners[i], nullptr, owner, nullptr) != 0) abort();
    }
    pthread_mutex_lock(&mutex);
    while (ready != countof(owners)) pthread_cond_wait(&condition, &mutex);
    usize reservation = mal_gc_process_budget();
    mal_gc_process_charge(reservation);
    charged = true;
    pthread_cond_broadcast(&condition);
    pthread_mutex_unlock(&mutex);
    for (usize i = 0; i < countof(owners); i++) pthread_join(owners[i], nullptr);
    if (atomic_load(&serviced) != countof(owners)) abort();
    mal_gc_process_release(reservation);
    if (mal_gc_process_bytes() != baseline) abort();
    check_pressure_after_released_peak();
    usize helpers = 0;
    while (helpers < 3 && mal_gc_process_helper_acquire()) helpers++;
    if (helpers > 2) abort();
    while (helpers > 0) {
        helpers--;
        mal_gc_process_helper_release();
    }
    MalValue roots[5];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[0] = mal_value_from_array_buffer_object(mal_array_buffer_object_new(
        &vm.heap, mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        64, 128, true, false));
    roots[1] = mal_value_from_array_object(mal_array_object_new_from_values(
        &vm.heap, mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), roots, 1));
    const char *error = nullptr;
    MalSerializedValue *snapshot = mal_serialize(&vm, roots[0], roots[1], nullptr, nullptr, &error);
    if (snapshot == nullptr || !mal_serialize_commit(&vm, snapshot) ||
        !mal_array_buffer_object_is_detached(mal_value_to_array_buffer_object(roots[0])) ||
        !mal_deserialize(&vm, snapshot, nullptr, &roots[2])) abort();
    mal_serialized_value_release(snapshot);
    roots[3] = mal_value_from_array_buffer_object(mal_array_buffer_object_new(
        &vm.heap, mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_SHARED_ARRAY_BUFFER_PROTOTYPE]),
        32, 256, true, true));
    snapshot = mal_serialize(&vm, roots[3], mal_value_new_undefined(), nullptr, nullptr, &error);
    if (snapshot == nullptr || !mal_serialize_commit(&vm, snapshot) ||
        !mal_deserialize(&vm, snapshot, nullptr, &roots[4])) abort();
    mal_serialized_value_release(snapshot);
    mal_gc_unroot(&root);
    mal_vm_free(&vm);
    if (mal_gc_process_bytes() != 0) abort();
    puts("gc-process PASS");
    return 0;
}
