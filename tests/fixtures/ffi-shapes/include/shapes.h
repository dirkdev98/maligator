#ifndef SHAPES_H
#define SHAPES_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define SHAPES_VERSION "1.4"  // Library version
#define SHAPES_MAX_POINTS 64
#define SHAPES_SCALE 2.5f
#define SHAPES_BIG 0x100000000ULL
#define SHAPES_ORIGIN (ShapesPoint){ 0.0f, 0.0f }  // The origin
#define SHAPES_EXPORT

/* A point in the plane. */
typedef struct ShapesPoint {
	float x;  // Horizontal position
	float y;  // Vertical position
} ShapesPoint;

typedef struct {
	ShapesPoint min;
	ShapesPoint max;
} ShapesBox;  // Axis-aligned box

typedef struct ShapesPath {
	ShapesPoint *points;
	int count;
} ShapesPath;

typedef struct ShapesCanvas ShapesCanvas;

/* A grayscale bitmap in memory the library allocates. */
typedef struct ShapesBitmap {
	unsigned char *pixels;  // One byte per pixel
	int width;              // Width in pixels
	int height;             // Height in pixels
} ShapesBitmap;

typedef enum {
	SHAPES_FILL = 1,  // Fill the interior
	SHAPES_STROKE = 2,
	SHAPES_BOTH = SHAPES_FILL | SHAPES_STROKE,
} ShapesMode;

// Add two points.
SHAPES_EXPORT ShapesPoint shapes_add(ShapesPoint a, ShapesPoint b);
float shapes_area(ShapesBox box);  // Area of a box
const char *shapes_mode_name(ShapesMode mode);
int64_t shapes_total(int64_t a, int64_t b);
bool shapes_contains(ShapesBox box, ShapesPoint point);
ShapesCanvas *shapes_canvas_open(const char *title);
void shapes_canvas_close(ShapesCanvas *canvas);
const char *shapes_canvas_title(const ShapesCanvas *canvas);  // NULL for no canvas
int shapes_canvases_open(void);  // Canvases opened and not closed
ShapesCanvas *shapes_canvas_current(void);  // The canvas opened last, while it is open
ShapesCanvas *shapes_get_first_canvas(void);  // The first canvas opened, while it is open

// Allocate a bitmap of zero pixels.
ShapesBitmap shapes_bitmap_new(int width, int height);
void shapes_bitmap_fill(ShapesBitmap *bitmap, unsigned char value);  // Set every pixel
int shapes_bitmap_sum(ShapesBitmap bitmap);  // Sum of all pixels
void shapes_bitmap_free(ShapesBitmap bitmap);
ShapesBitmap shapes_bitmap_shared(void);  // A bitmap the library keeps
int shapes_bitmaps_live(void);  // Bitmaps allocated and not freed
int shapes_canvas_create(const char *title, ShapesCanvas **canvas);  // 0 on success
int shapes_text_bytes(const char *text);  // The byte length of UTF-8 text
const char *shapes_join(const char **parts, int count);  // Join parts with commas

// Parse "x,y" into a point; returns 0, or -1 for other text.
int shapes_parse(const char *text, ShapesPoint *point);
void shapes_scale(ShapesPoint *point, float factor);  // Scale in place
// The bounding box of the points; returns -1 for no points.
int shapes_bounds(const ShapesPoint *points, int count, ShapesBox *box);
uint32_t shapes_checksum(const void *data, size_t size);  // Sum of the bytes
// Copy source into dest, which holds destLen bytes, and set destLen to the bytes copied;
// returns 0, or -1 when dest is too small.
int shapes_pack(unsigned char *dest, size_t *destLen, const unsigned char *source,
                size_t sourceLen);
// A width x height gradient, one byte per pixel; writes its byte count. The caller
// frees it with shapes_free.
unsigned char *shapes_render(int width, int height, int *size);
ShapesPoint *shapes_corners(ShapesBox box, int *count);  // The box's corners; free them
char *shapes_describe(ShapesPoint point);  // "(x, y)" in memory the caller frees
void shapes_free(void *memory);  // Release memory the library allocated
int shapes_allocations(void);  // Allocations not yet released

// Visit each point until visit returns nonzero; returns the points visited.
int shapes_each(const ShapesPoint *points, int count,
                int (*visit)(ShapesPoint point, int index, void *data), void *data);
// Integrate f over [from, to] with the midpoint rule.
double shapes_integrate(double (*f)(void *data, double x), void *data, double from, double to,
                        int steps);
// Fold steps 0 to count - 1 with step, starting from 0; returns the result.
int shapes_fold(int count, int (*step)(int acc, int index));
// Format a log line like printf; returns its length.
int shapes_log(const char *format, ...);
// Write each byte's index into data, calling visit after each until it returns nonzero.
int shapes_fill(unsigned char *data, size_t size, int (*visit)(void *ctx, int index), void *ctx);

typedef void (*ShapesListener)(void *data, int event);
// Keep a listener until shapes_unlisten_all, which calls release(data) for it.
int shapes_listen(ShapesListener listener, void *data, void (*release)(void *data));
void shapes_emit(int event);  // Call every listener
void shapes_unlisten_all(void);
int shapes_listeners(void);  // Listeners kept

typedef int (*ShapesReader)(void *data, int count, const ShapesPoint *points, int size,
                            const unsigned char *bytes);
// Call reader with three points and four bytes; returns its result.
int shapes_read(ShapesReader reader, void *data);
// Lend visit the canvas and a temporary canvas that closes when visit returns.
void shapes_canvas_lend(ShapesCanvas *canvas,
                        void (*visit)(void *data, ShapesCanvas *held, ShapesCanvas *temporary),
                        void *data);
// Call visit, then return the length of the canvas title.
int shapes_canvas_visit(ShapesCanvas *canvas, void (*visit)(void *data), void *data);

typedef void (*ShapesErrorHandler)(int code, const char *message);
// Keep handler until the next call; returns the handler it replaces.
ShapesErrorHandler shapes_set_error_handler(ShapesErrorHandler handler);
void shapes_fail(int code);  // Report a failure to the error handler
// Keep handler for the canvas until the next call or until the canvas closes.
void shapes_canvas_on_resize(ShapesCanvas *canvas,
                             void (*handler)(ShapesCanvas *canvas, int width, int height));
void shapes_canvas_resize(ShapesCanvas *canvas, int width, int height);  // Call its handler
// Keep hook for the canvas until the next call; returns the data it replaces.
void *shapes_canvas_on_draw(ShapesCanvas *canvas, int (*hook)(void *data, int frame), void *data);
int shapes_canvas_draw(ShapesCanvas *canvas, int frame);  // The hook's result, or -1
typedef void (*ShapesWatcher)(void *data, int event, const char *label);
// Keep a watcher the library may call from its own threads, until shapes_unwatch.
int shapes_watch(ShapesWatcher watcher, void *data, void (*release)(void *data));
void shapes_unwatch(void);
// Call the watcher with events 1 to count from a new thread; returns once that ends.
void shapes_watch_fire(int count);
void shapes_watch_call(int event);  // Call the watcher on this thread
// Call the watcher with event from a new thread after milliseconds; returns at once.
void shapes_watch_later(int event, int milliseconds);
// Keep ticker until the next call; shapes_tick calls it with 1 to count from a new thread.
void shapes_set_ticker(void (*ticker)(int tick));
void shapes_tick(int count);
// Sleep for milliseconds while using the canvas and bytes; returns the sum of the bytes.
int shapes_hold(ShapesCanvas *canvas, const void *data, size_t size, int milliseconds);

typedef struct ShapesCall ShapesCall;
void *shapes_call_data(ShapesCall *call);  // The data its function was registered with
void shapes_call_return(ShapesCall *call, double value);  // Set the call's result
// Register fn under name until shapes_unregister_all, destroying the data of a function
// it replaces; returns 0, or -1 when full.
int shapes_register(const char *name, void (*fn)(ShapesCall *call, int count, const double *args),
                    void *data, void (*destroy)(void *data));
double shapes_invoke(const char *name, double x, double y);  // -1 for an unknown name
void shapes_unregister_all(void);  // Destroy every registered function's data
const char *shapes_log_line(void);  // The last log line
size_t shapes_path_length(ShapesPath path);

/*
** Sum two or three integers.
*/
int shapes_sum2(int a, int b);
int shapes_sum3(
	int a, /* First term */
	int b, /* Second term */
	int c  /* Third term */
);

int shapes_mul(int value, int factor);
uint32_t shapes_unsigned_max(void);  // UINT32_MAX

static inline int shapes_twice(int value) { return value * 2; }

#endif
