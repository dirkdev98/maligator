#include "fields.h"
#include <stdlib.h>

Flags fields_copy(Flags value) { return value; }
PackedFlags fields_packed(PackedFlags value) { return value; }
FlagBox fields_box(FlagBox value) { return value; }
void fields_visit(Flags value, Flags (*callback)(Flags)) {
    Flags returned = callback(value);
    if (returned.small != value.small || returned.offset != value.offset ||
        returned.wide != value.wide || returned.balance != value.balance ||
        returned.enabled != value.enabled || returned.mode != value.mode ||
        returned.inline_mode != value.inline_mode) abort();
}
unsigned long long fields_state(FlagState *state) { return state->count + state->mode; }
void fields_configure(FlagState *state, unsigned mode, unsigned long long count) {
    state->mode = mode;
    state->count = count;
}
void fields_advance(FlagState *state) { state->count++; state->generation++; }
void fields_advance_many(FlagState **states, unsigned count) {
    for (unsigned index = 0; index < count; index++) fields_advance(states[index]);
}
void fields_observe(FlagState *state, void (*callback)(void)) { callback(); }
