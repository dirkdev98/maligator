#pragma once
#include <stddef.h>
typedef struct PlainState { int value; } PlainState;
const char *plain_init(PlainState *state, size_t *length);
void plain_cleanup(PlainState *state);
int plain_destroyed(void);
