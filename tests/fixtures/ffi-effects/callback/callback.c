#include "callback.h"
static void (*active)(void *);
static void *active_data;
void effects_scope(void (*callback)(void *), void *data) {
    active = callback;
    active_data = data;
    callback(data);
    active = 0;
    active_data = 0;
}
int effects_nested(void) { if (active != 0) active(active_data); return 1; }
