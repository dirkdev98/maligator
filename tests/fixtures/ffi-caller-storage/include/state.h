#ifndef CALLER_STATE_H
#define CALLER_STATE_H
#include <stddef.h>
#include <stdint.h>

typedef struct CallerState {
    _Alignas(64) void *private_state;
    int value;
    void (*listener)(int event, void *data);
    void *listener_data;
} CallerState;

typedef struct CopiedState {
    _Alignas(64) int value;
} CopiedState;

typedef struct IncompleteState IncompleteState;
typedef struct VariableState { _Alignas(64) int length; unsigned char tail[]; } VariableState;
typedef struct WideState { _Alignas(32) size_t length; uint32_t tail[0]; } WideState;
typedef struct NonfinalState { int tail[0]; int value; } NonfinalState;
typedef struct FixedTailState { int length; int tail[2]; } FixedTailState;

int variable_state_zero(const VariableState *state, size_t count);
void variable_state_fill(VariableState *state, size_t count, int seed);
int variable_state_sum(const VariableState *state);
int variable_state_aligned(const VariableState *state);
VariableState *variable_state_same(VariableState *state);
void variable_state_visit(VariableState *state, void (*callback)(VariableState *, void *), void *data);
void wide_state_fill(WideState *state, size_t count);
uint64_t wide_state_sum(const WideState *state);

int caller_state_init(CallerState *state, int value);
int caller_state_read(const CallerState *state);
int caller_state_aligned(const CallerState *state);
CallerState *caller_state_same(CallerState *state);
void caller_state_cleanup(CallerState *state);
void caller_state_visit(CallerState *state, void (*visit)(CallerState *, void *), void *data);
void caller_state_listen(CallerState *state, void (*listener)(int, void *), void *data);
void caller_state_emit(CallerState *state, int event);
int caller_state_emit_thread(CallerState *state, int event);
int caller_state_live(void);
CopiedState caller_copy(int value);
int caller_copy_aligned(const CopiedState *state);

#endif
