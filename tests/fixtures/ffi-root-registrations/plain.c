#include "plain.h"
#include <stdlib.h>
static int destroyed;
const char *plain_init(PlainState *state, size_t *length) { state->value = 7; *length = 5; return "plain"; }
void plain_cleanup(PlainState *state) { if (state->value != 7) abort(); state->value = 0; destroyed++; }
int plain_destroyed(void) { return destroyed; }
