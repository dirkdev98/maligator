#include <stdint.h>
#include <stddef.h>

typedef struct GlobalsPoint { int x; int y; } GlobalsPoint;
typedef struct GlobalsContext { int value; } GlobalsContext;
/** Current library mode, shared with ordinary C calls. */
extern int globals_mode;

extern const int globals_limit;
typedef const int GlobalsLimit;
extern GlobalsLimit globals_aliased_limit;
extern const GlobalsPoint globals_fixed_point;
extern volatile int globals_signal;
extern uint64_t globals_serial;
extern double globals_ratio;
extern _Thread_local int globals_thread;
extern GlobalsPoint globals_point;
extern const char *globals_title;
extern GlobalsContext *globals_context;
extern int (*globals_transform)(int);
extern int globals_unprovided;
extern int globals_values[2];
extern int globals_matrix[2][2];
extern GlobalsPoint globals_points[2];
typedef int GlobalsValues[2];
extern const GlobalsValues globals_fixed_values;
extern volatile int globals_signals[2];
extern _Thread_local int globals_threads[2];
enum { GLOBALS_TEXT_CAPACITY = 16, GLOBALS_BYTE_CAPACITY = 4 };
extern char globals_label[GLOBALS_TEXT_CAPACITY];
extern unsigned char globals_bytes[GLOBALS_BYTE_CAPACITY];
extern signed char globals_signed_bytes[GLOBALS_BYTE_CAPACITY];
extern volatile unsigned char globals_volatile_bytes[GLOBALS_BYTE_CAPACITY];
extern _Thread_local char globals_thread_label[GLOBALS_TEXT_CAPACITY];
typedef char GlobalsText[GLOBALS_TEXT_CAPACITY];
extern const GlobalsText globals_fixed_label;
extern char globals_sink[8];
void globals_unterminate_label(void);
unsigned int globals_label_byte(int index);
const char *globals_sink_text(void);
extern int globals_incomplete[];
extern int globals_empty[0];
extern int globals_oversized[2147483648ULL];
static int globals_private;
enum { GLOBALS_CONSTANT = 13 };
void globals_advance(void);
void globals_select(int mode);
void globals_destroy(GlobalsContext *context);
int globals_destroyed(void);
