#include "globals.h"

int globals_mode = 3;
const int globals_limit = 42;
GlobalsLimit globals_aliased_limit = 37;
const GlobalsPoint globals_fixed_point = {5, 6};
volatile int globals_signal = 1;
int globals_values[2];
uint64_t globals_serial;
double globals_ratio;
_Thread_local int globals_thread = 17;
GlobalsPoint globals_point = {1, 2};
const char *globals_title = "north";
static GlobalsContext context = {19};
GlobalsContext *globals_context = &context;
static int add_one(int value) { return value + 1; }
static int triple(int value) { return value * 3; }
int (*globals_transform)(int) = add_one;
static int destroyed;
void globals_advance(void) { globals_mode++; globals_point.x++; globals_point.y++; }
void globals_select(int mode) { globals_title = mode ? "south" : "north"; globals_transform = mode ? triple : add_one; }
void globals_destroy(GlobalsContext *value) { if (value != 0) destroyed++; }
int globals_destroyed(void) { return destroyed; }
