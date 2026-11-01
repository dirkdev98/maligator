#define _POSIX_C_SOURCE 200809L
#include "state.h"
#include <stdint.h>
#include <string.h>
#include <time.h>
#include <stdlib.h>
#include <stdatomic.h>
#include <sched.h>

int managed_text_advance(ManagedText *state, unsigned int count) {
    if (count > state->remaining) abort();
    if (state->text != NULL) state->text += count;
    state->remaining -= count;
    return (int) state->remaining;
}
void managed_text_write(ManagedText *state, unsigned char value) {
    if (state->remaining != 0) state->text[0] = (char) value;
}
void managed_text_bad(ManagedText *state, int mode) {
    if (mode == 1) state->remaining++;
    if (mode == 2) state->text = (char *) ((uintptr_t) state->text - 1);
    if (mode == 3) { state->text = NULL; state->remaining = 1; }
}
int managed_text_empty(ManagedText *state) { return state->text != NULL && state->remaining == 0; }
static _Atomic int text_started;
static _Atomic int text_released;
void managed_text_wait(ManagedTextBase *base) {
    ManagedText *state = (ManagedText *) base;
    atomic_store(&text_started, 1);
    while (!atomic_load(&text_released)) sched_yield();
    managed_text_write(state, 'Q');
}
void managed_text_wait_started(void) { while (!atomic_load(&text_started)) sched_yield(); }
void managed_text_release(void) { atomic_store(&text_released, 1); }

int managed_copy(ManagedState *state) {
    unsigned int count = state->avail_in < state->avail_out ? state->avail_in : state->avail_out;
    if (count > 0) {
        memcpy(state->next_out, state->next_in, count);
        state->next_in += count;
        state->next_out += count;
        state->avail_in -= count;
        state->avail_out -= count;
        state->total += count;
    }
    return (int) count;
}
int managed_copy_wait(ManagedState *state) {
    struct timespec delay = {.tv_nsec = 20000000};
    nanosleep(&delay, NULL);
    return managed_copy(state);
}
int managed_alias(ManagedState *first, ManagedState *second) {
    return first == second ? managed_copy(first) : -1;
}
int managed_base_copy(ManagedBase *state) { return managed_copy((ManagedState *) state); }
void managed_visit(ManagedState *state, void (*callback)(void *), void *data) {
    callback(data);
    (void) managed_copy(state);
}
void managed_bad(ManagedState *state, int mode) {
    if (mode == 1) state->avail_in++;
    if (mode == 2) state->next_in = (const unsigned char *) ((uintptr_t) state->next_in + state->avail_in + 1);
    if (mode == 3) { state->next_in = NULL; state->avail_in = 1; }
    if (mode == 4) { state->next_in += state->avail_in; state->avail_in = 0; }
    if (mode == 5) { state->next_in = NULL; state->avail_in = 0; }
}
void managed_negative(ManagedSigned *state) { state->length = -1; }
int managed_abi_size(int size) { return size == (int) sizeof(ManagedState); }
int managed_many(ManagedState *const *states, size_t count) {
    int result = 0;
    for (size_t index = 0; index < count; index++) result += managed_copy(states[index]);
    return result;
}
int managed_many_wait(ManagedState *const *states, size_t count) {
    struct timespec delay = {.tv_nsec = 20000000};
    nanosleep(&delay, NULL);
    return managed_many(states, count);
}
int managed_indirect(ManagedState **state) { return managed_copy(*state); }
const unsigned char *managed_remaining(ManagedState *state, size_t *length) {
    *length = state->avail_in;
    return state->next_in;
}
ManagedResource managed_resource_new(int value) {
    ManagedResource result = {malloc(sizeof(int))};
    if (result.value != NULL) *result.value = value;
    return result;
}
void managed_resource_free(ManagedResource value) { free(value.value); }
int managed_packet(ManagedPacket packet, void (*callback)(void *), void *data) {
    callback(data);
    return packet.resources[0].value == NULL ? -1 : *packet.resources[0].value;
}
int managed_packet_wait(ManagedPacket packet) {
    struct timespec delay = {.tv_nsec = 20000000};
    nanosleep(&delay, NULL);
    return packet.resources[0].value == NULL ? -1 : *packet.resources[0].value;
}
int managed_copy_slow(ManagedState *state) {
    struct timespec delay = {.tv_nsec = 200000000};
    nanosleep(&delay, NULL);
    return managed_copy(state);
}
int managed_small_size(unsigned char size) { return size; }
void managed_lend(void (*callback)(ManagedState *, void *), void *data) {
    ManagedState state = {0};
    callback(&state, data);
}
