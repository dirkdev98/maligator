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

// Allocate a bitmap of zero pixels.
ShapesBitmap shapes_bitmap_new(int width, int height);
void shapes_bitmap_fill(ShapesBitmap *bitmap, unsigned char value);  // Set every pixel
int shapes_bitmap_sum(ShapesBitmap bitmap);  // Sum of all pixels
void shapes_bitmap_free(ShapesBitmap bitmap);
ShapesBitmap shapes_bitmap_shared(void);  // A bitmap the library keeps
int shapes_bitmaps_live(void);  // Bitmaps allocated and not freed
int shapes_canvas_create(const char *title, ShapesCanvas **canvas);  // 0 on success

// Parse "x,y" into a point; returns 0, or -1 for other text.
int shapes_parse(const char *text, ShapesPoint *point);
void shapes_scale(ShapesPoint *point, float factor);  // Scale in place
// The bounding box of the points; returns -1 for no points.
int shapes_bounds(const ShapesPoint *points, int count, ShapesBox *box);
uint32_t shapes_checksum(const void *data, size_t size);  // Sum of the bytes
// A width x height gradient, one byte per pixel; writes its byte count.
unsigned char *shapes_render(int width, int height, int *size);
ShapesPoint *shapes_corners(ShapesBox box, int *count);  // The box's corners
char *shapes_describe(ShapesPoint point);  // "(x, y)" in memory the caller frees
void shapes_free(void *memory);  // Release memory the library allocated
int shapes_allocations(void);  // Allocations not yet released

// Visit each point until visit returns nonzero; returns the points visited.
int shapes_each(const ShapesPoint *points, int count,
                int (*visit)(ShapesPoint point, int index, void *data), void *data);
// Integrate f over [from, to] with the midpoint rule.
double shapes_integrate(double (*f)(void *data, double x), void *data, double from, double to,
                        int steps);
int shapes_log(const char *format, ...);
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

static inline int shapes_twice(int value) { return value * 2; }

#endif
