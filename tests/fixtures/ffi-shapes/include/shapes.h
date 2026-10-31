#ifndef SHAPES_H
#define SHAPES_H

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
