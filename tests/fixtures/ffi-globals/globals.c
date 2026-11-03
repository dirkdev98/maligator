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
static unsigned char retained_initial[] = {1, 2, 3};
const char *globals_retained_title = "initial";
unsigned char *globals_retained_bytes = retained_initial;
unsigned char globals_retained_count = sizeof(retained_initial);
void *globals_retained_void;
int globals_retained_signed_count;
void globals_retained_negative_count(void) { globals_retained_signed_count = -1; }
_Thread_local const char *globals_retained_tls = "tls";
const char *const globals_retained_const = "const";
static const char *retained_saved_title;
static unsigned char *retained_saved_bytes;
static unsigned char retained_saved_count;
void globals_retained_advance(void) {
    if (globals_retained_bytes != 0 && globals_retained_count > 0) { globals_retained_bytes++; globals_retained_count--; }
    if (globals_retained_title != 0 && *globals_retained_title != 0) globals_retained_title++;
}
void globals_retained_corrupt_count(void) { retained_saved_count = globals_retained_count; globals_retained_count = 255; }
void globals_retained_corrupt_title(void) { retained_saved_title = globals_retained_title; globals_retained_title = "outside"; }
void globals_retained_corrupt_pointer(void) { retained_saved_bytes = globals_retained_bytes; globals_retained_bytes = retained_initial; }
void globals_retained_restore(void) {
    if (retained_saved_title != 0) { globals_retained_title = retained_saved_title; retained_saved_title = 0; }
    if (retained_saved_bytes != 0) { globals_retained_bytes = retained_saved_bytes; retained_saved_bytes = 0; }
    if (retained_saved_count != 0) { globals_retained_count = retained_saved_count; retained_saved_count = 0; }
}
int globals_retained_nonnull(void) { return globals_retained_bytes != 0; }
