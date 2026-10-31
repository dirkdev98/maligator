#include "shapes.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct ShapesCanvas {
	char title[64];
};

ShapesPoint shapes_add(ShapesPoint a, ShapesPoint b) {
	return (ShapesPoint){a.x + b.x, a.y + b.y};
}

float shapes_area(ShapesBox box) {
	return (box.max.x - box.min.x) * (box.max.y - box.min.y);
}

const char *shapes_mode_name(ShapesMode mode) {
	switch (mode) {
	case SHAPES_FILL:
		return "fill";
	case SHAPES_STROKE:
		return "stroke";
	case SHAPES_BOTH:
		return "both";
	}
	return NULL;
}

int64_t shapes_total(int64_t a, int64_t b) { return a + b; }

bool shapes_contains(ShapesBox box, ShapesPoint point) {
	return point.x >= box.min.x && point.x <= box.max.x && point.y >= box.min.y &&
	       point.y <= box.max.y;
}

static int canvases_open;
static int bitmaps_live;

ShapesCanvas *shapes_canvas_open(const char *title) {
	ShapesCanvas *canvas = calloc(1, sizeof(*canvas));
	if (canvas == NULL) return NULL;
	snprintf(canvas->title, sizeof(canvas->title), "%s", title);
	canvases_open++;
	return canvas;
}

void shapes_canvas_close(ShapesCanvas *canvas) {
	free(canvas);
	canvases_open--;
}

const char *shapes_canvas_title(const ShapesCanvas *canvas) {
	return canvas == NULL ? NULL : canvas->title;
}

int shapes_canvases_open(void) { return canvases_open; }

ShapesBitmap shapes_bitmap_new(int width, int height) {
	ShapesBitmap bitmap = {calloc((size_t)(width * height), 1), width, height};
	if (bitmap.pixels != NULL) bitmaps_live++;
	return bitmap;
}

void shapes_bitmap_fill(ShapesBitmap *bitmap, unsigned char value) {
	memset(bitmap->pixels, value, (size_t)(bitmap->width * bitmap->height));
}

int shapes_bitmap_sum(ShapesBitmap bitmap) {
	int sum = 0;
	for (int index = 0; index < bitmap.width * bitmap.height; index++) sum += bitmap.pixels[index];
	return sum;
}

void shapes_bitmap_free(ShapesBitmap bitmap) {
	free(bitmap.pixels);
	bitmaps_live--;
}

ShapesBitmap shapes_bitmap_shared(void) {
	static unsigned char pixels[4] = {1, 1, 1, 1};
	return (ShapesBitmap){pixels, 2, 2};
}

int shapes_bitmaps_live(void) { return bitmaps_live; }

int shapes_log(const char *format, ...) {
	va_list arguments;
	va_start(arguments, format);
	int written = vprintf(format, arguments);
	va_end(arguments);
	return written;
}

size_t shapes_path_length(ShapesPath path) { return (size_t)path.count; }

int shapes_sum2(int a, int b) { return a + b; }

int shapes_sum3(int a, int b, int c) { return a + b + c; }
