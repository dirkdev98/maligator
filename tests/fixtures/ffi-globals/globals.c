#include "globals.h"

int globals_values[2] = {1, 2};
int globals_matrix[2][2] = {{3, 4}, {5, 6}};
GlobalsPoint globals_points[2] = {{7, 8}, {9, 10}};
const GlobalsValues globals_fixed_values = {11, 12};
volatile int globals_signals[2] = {13, 14};
_Thread_local int globals_threads[2] = {15, 16};
char globals_label[GLOBALS_TEXT_CAPACITY] = "start";
unsigned char globals_bytes[GLOBALS_BYTE_CAPACITY] = {0, 127, 128, 255};
signed char globals_signed_bytes[GLOBALS_BYTE_CAPACITY] = {0, 127, -128, -1};
volatile unsigned char globals_volatile_bytes[GLOBALS_BYTE_CAPACITY] = {1, 2, 3, 4};
_Thread_local char globals_thread_label[GLOBALS_TEXT_CAPACITY] = "thread";
const GlobalsText globals_fixed_label = "fixed";
char globals_sink[8] = "old";
void globals_unterminate_label(void) {
    for (size_t i = 0; i < GLOBALS_TEXT_CAPACITY; i++) globals_label[i] = 'x';
}
unsigned int globals_label_byte(int index) { return (unsigned char)globals_label[index]; }
const char *globals_sink_text(void) { return globals_sink; }

int globals_mode = 3;
const int globals_limit = 42;
GlobalsLimit globals_aliased_limit = 37;
const GlobalsPoint globals_fixed_point = {5, 6};
volatile int globals_signal = 1;
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
