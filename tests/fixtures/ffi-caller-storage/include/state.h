#ifndef CALLER_STATE_H
#define CALLER_STATE_H

typedef struct CallerState {
    _Alignas(64) void *private_state;
    int value;
} CallerState;

typedef struct CopiedState {
    _Alignas(64) int value;
} CopiedState;

typedef struct IncompleteState IncompleteState;
typedef struct VariableState { int length; char tail[]; } VariableState;

int caller_state_init(CallerState *state, int value);
int caller_state_read(const CallerState *state);
int caller_state_aligned(const CallerState *state);
CallerState *caller_state_same(CallerState *state);
void caller_state_cleanup(CallerState *state);
void caller_state_visit(CallerState *state, void (*visit)(CallerState *, void *), void *data);
int caller_state_live(void);
CopiedState caller_copy(int value);
int caller_copy_aligned(const CopiedState *state);

#endif
