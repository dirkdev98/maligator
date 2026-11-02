#include <stdint.h>

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
static int globals_private;
enum { GLOBALS_CONSTANT = 13 };
void globals_advance(void);
void globals_select(int mode);
void globals_destroy(GlobalsContext *context);
int globals_destroyed(void);
