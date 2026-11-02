#include "state.h"
#include <stdint.h>
#include <stdlib.h>
#include <pthread.h>
#include <string.h>

static int live;

int variable_state_zero(const VariableState *state, size_t count) {
    if (state->length != 0) return 0;
    for (size_t index = 0; index < count; index++) if (state->tail[index] != 0) return 0;
    return 1;
}
void variable_state_fill(VariableState *state, size_t count, int seed) {
    state->length = (int) count;
    for (size_t index = 0; index < count; index++) state->tail[index] = (unsigned char) (seed + index);
}
int variable_state_sum(const VariableState *state) {
    int sum = 0;
    for (int index = 0; index < state->length; index++) sum += state->tail[index];
    return sum;
}
int variable_state_aligned(const VariableState *state) { return (uintptr_t)state % _Alignof(VariableState) == 0; }
VariableState *variable_state_same(VariableState *state) { return state; }
void variable_state_visit(VariableState *state, void (*callback)(VariableState *, void *), void *data) { callback(state, data); }
void wide_state_fill(WideState *state, size_t count) {
    state->length = count;
    for (size_t index = 0; index < count; index++) state->tail[index] = UINT32_C(0x80000000) + (uint32_t)index;
}
uint64_t wide_state_sum(const WideState *state) {
    uint64_t sum = 0;
    for (size_t index = 0; index < state->length; index++) sum += state->tail[index];
    return sum;
}

int caller_state_init(CallerState *state, int value) {
    if (value < 0 || state->private_state != NULL || state->value != 0) return -1;
    int *stored = malloc(sizeof(*stored));
    if (stored == NULL) return -2;
    *stored = value;
    state->private_state = stored;
    state->value = value;
    live++;
    return 0;
}

int caller_state_read(const CallerState *state) {
    return state->private_state == NULL ? -1 : *(const int *) state->private_state;
}

int caller_state_aligned(const CallerState *state) {
    return (uintptr_t) state % _Alignof(CallerState) == 0;
}

CallerState *caller_state_same(CallerState *state) { return state; }

void caller_state_cleanup(CallerState *state) {
    state->listener = NULL;
    state->listener_data = NULL;
    free(state->private_state);
    state->private_state = NULL;
    state->value = 0;
    live--;
}

void caller_state_visit(CallerState *state, void (*visit)(CallerState *, void *), void *data) {
    visit(state, data);
}

void caller_state_listen(CallerState *state, void (*listener)(int, void *), void *data) {
    state->listener = listener;
    state->listener_data = data;
}

void caller_state_emit(CallerState *state, int event) {
    if (state->listener != NULL) state->listener(event, state->listener_data);
}

typedef struct { CallerState *state; int event; } CallerEvent;
static void *caller_event_thread(void *data) {
    CallerEvent *event = data;
    caller_state_emit(event->state, event->event);
    return NULL;
}

int caller_state_emit_thread(CallerState *state, int event) {
    CallerEvent input = { state, event };
    pthread_t thread;
    int status = pthread_create(&thread, NULL, caller_event_thread, &input);
    return status == 0 ? pthread_join(thread, NULL) : status;
}

int caller_state_live(void) { return live; }

CopiedState caller_copy(int value) { return (CopiedState) { .value = value }; }

int caller_copy_aligned(const CopiedState *state) {
    return (uintptr_t) state % _Alignof(CopiedState) == 0;
}

struct IncompleteState { _Alignas(64) void *private_state; int value; unsigned char reserved[17]; };
static uint64_t incomplete_size = sizeof(IncompleteState);
static uint64_t incomplete_alignment = _Alignof(IncompleteState);
static int incomplete_size_queries;
static int incomplete_alignment_queries;
static void (*incomplete_query_callback)(void *);
static void *incomplete_query_data;
static int incomplete_live;
uint64_t incomplete_state_size(void) {
    incomplete_size_queries++;
    if (incomplete_query_callback != NULL) incomplete_query_callback(incomplete_query_data);
    return incomplete_size;
}
uint64_t incomplete_state_alignment(void) { incomplete_alignment_queries++; return incomplete_alignment; }
void incomplete_state_layout(uint64_t size, uint64_t alignment) { incomplete_size = size; incomplete_alignment = alignment; }
void incomplete_state_default_layout(void) { incomplete_size = sizeof(IncompleteState); incomplete_alignment = _Alignof(IncompleteState); }
int incomplete_state_size_queries(void) { return incomplete_size_queries; }
int incomplete_state_alignment_queries(void) { return incomplete_alignment_queries; }
void incomplete_state_query_hook(void (*callback)(void *), void *data) { incomplete_query_callback = callback; incomplete_query_data = data; }
int incomplete_state_init(IncompleteState *state, int value) {
    if (state->private_state != NULL || state->value != 0 || value < 0) return -1;
    state->private_state = malloc(1);
    if (state->private_state == NULL) abort();
    state->value = value;
    incomplete_live++;
    return 0;
}
int incomplete_state_read(const IncompleteState *state) { return state->private_state == NULL ? -1 : state->value; }
void incomplete_state_cleanup(IncompleteState *state) { free(state->private_state); state->private_state = NULL; state->value = 0; incomplete_live--; }
int incomplete_state_aligned(const IncompleteState *state) { return (uintptr_t)state % _Alignof(IncompleteState) == 0 && (uintptr_t)state % incomplete_alignment == 0; }
IncompleteState *incomplete_state_same(IncompleteState *state) { return state; }
IncompleteBase *incomplete_state_base(IncompleteState *state) { return (IncompleteBase *)state; }
int incomplete_base_read(const IncompleteBase *state) { return incomplete_state_read((const IncompleteState *)state); }
void incomplete_state_visit(IncompleteState *state, void (*callback)(IncompleteState *, void *), void *data) { callback(state, data); }
int incomplete_state_live(void) { return incomplete_live; }

int incomplete_state_zero(const IncompleteState *state) {
    const unsigned char *bytes = (const unsigned char *)state;
    for (uint64_t i = 0; i < incomplete_size; i++) if (bytes[i] != 0) return 0;
    return 1;
}
void incomplete_state_fill(IncompleteState *state) { memset(state, 0x5a, (size_t)incomplete_size); }
