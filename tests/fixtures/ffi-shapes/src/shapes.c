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
static ShapesCanvas *current_canvas;

ShapesCanvas *shapes_canvas_open(const char *title) {
	ShapesCanvas *canvas = calloc(1, sizeof(*canvas));
	if (canvas == NULL) return NULL;
	snprintf(canvas->title, sizeof(canvas->title), "%s", title);
	canvases_open++;
	current_canvas = canvas;
	return canvas;
}

void shapes_canvas_close(ShapesCanvas *canvas) {
	if (canvas == current_canvas) current_canvas = NULL;
	free(canvas);
	canvases_open--;
}

ShapesCanvas *shapes_canvas_current(void) { return current_canvas; }

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

int shapes_canvas_create(const char *title, ShapesCanvas **canvas) {
	*canvas = shapes_canvas_open(title);
	return *canvas == NULL ? -1 : 0;
}

int shapes_text_bytes(const char *text) { return (int) strlen(text); }

const char *shapes_join(const char **parts, int count) {
	static char joined[256];
	size_t used = 0;
	joined[0] = '\0';
	for (int index = 0; index < count; index++) {
		int written = snprintf(joined + used, sizeof(joined) - used, "%s%s", index == 0 ? "" : ",",
		                       parts[index]);
		if (written < 0 || (size_t)written >= sizeof(joined) - used) break;
		used += (size_t)written;
	}
	return joined;
}

static int allocations;

static void *allocate(size_t size) {
	void *memory = malloc(size);
	if (memory != NULL) allocations++;
	return memory;
}

void shapes_free(void *memory) {
	if (memory != NULL) allocations--;
	free(memory);
}

int shapes_allocations(void) { return allocations; }

int shapes_parse(const char *text, ShapesPoint *point) {
	return sscanf(text, "%f,%f", &point->x, &point->y) == 2 ? 0 : -1;
}

void shapes_scale(ShapesPoint *point, float factor) {
	point->x *= factor;
	point->y *= factor;
}

int shapes_bounds(const ShapesPoint *points, int count, ShapesBox *box) {
	if (count == 0) return -1;
	box->min = box->max = points[0];
	for (int index = 1; index < count; index++) {
		if (points[index].x < box->min.x) box->min.x = points[index].x;
		if (points[index].y < box->min.y) box->min.y = points[index].y;
		if (points[index].x > box->max.x) box->max.x = points[index].x;
		if (points[index].y > box->max.y) box->max.y = points[index].y;
	}
	return 0;
}

uint32_t shapes_checksum(const void *data, size_t size) {
	uint32_t sum = 0;
	for (size_t index = 0; index < size; index++) sum += ((const unsigned char *)data)[index];
	return sum;
}

unsigned char *shapes_render(int width, int height, int *size) {
	*size = width * height;
	unsigned char *pixels = allocate((size_t)*size);
	for (int index = 0; pixels != NULL && index < *size; index++) pixels[index] = (unsigned char)index;
	return pixels;
}

ShapesPoint *shapes_corners(ShapesBox box, int *count) {
	ShapesPoint *corners = allocate(4 * sizeof(ShapesPoint));
	if (corners == NULL) return NULL;
	corners[0] = box.min;
	corners[1] = (ShapesPoint){box.max.x, box.min.y};
	corners[2] = box.max;
	corners[3] = (ShapesPoint){box.min.x, box.max.y};
	*count = 4;
	return corners;
}

int shapes_each(const ShapesPoint *points, int count,
                int (*visit)(ShapesPoint point, int index, void *data), void *data) {
	int visited = 0;
	while (visited < count) {
		int stop = visit(points[visited], visited, data);
		visited++;
		if (stop != 0) break;
	}
	return visited;
}

double shapes_integrate(double (*f)(void *data, double x), void *data, double from, double to,
                        int steps) {
	double width = (to - from) / steps;
	double sum = 0;
	for (int step = 0; step < steps; step++) sum += f(data, from + (step + 0.5) * width) * width;
	return sum;
}

char *shapes_describe(ShapesPoint point) {
	char *text = allocate(64);
	if (text != NULL) snprintf(text, 64, "(%g, %g)", point.x, point.y);
	return text;
}

static char log_line[128];

int shapes_log(const char *format, ...) {
	va_list arguments;
	va_start(arguments, format);
	int written = vsnprintf(log_line, sizeof(log_line), format, arguments);
	va_end(arguments);
	return written;
}

const char *shapes_log_line(void) { return log_line; }

static struct {
	ShapesListener listener;
	void *data;
	void (*release)(void *data);
} listeners[8];
static int listener_count;

int shapes_listen(ShapesListener listener, void *data, void (*release)(void *data)) {
	if (listener_count == 8) {
		if (release != NULL) release(data);
		return -1;
	}
	listeners[listener_count].listener = listener;
	listeners[listener_count].data = data;
	listeners[listener_count].release = release;
	listener_count++;
	return 0;
}

void shapes_emit(int event) {
	for (int index = 0; index < listener_count; index++)
		listeners[index].listener(listeners[index].data, event);
}

void shapes_unlisten_all(void) {
	int count = listener_count;
	listener_count = 0;
	for (int index = 0; index < count; index++)
		if (listeners[index].release != NULL) listeners[index].release(listeners[index].data);
}

int shapes_listeners(void) { return listener_count; }

int shapes_canvas_visit(ShapesCanvas *canvas, void (*visit)(void *data), void *data) {
	visit(data);
	return (int)strlen(canvas->title);
}

int shapes_read(ShapesReader reader, void *data) {
	static const ShapesPoint points[3] = {{0, 0}, {1, 2}, {3, 4}};
	static const unsigned char bytes[4] = {9, 8, 7, 6};
	return reader(data, 3, points, 4, bytes);
}

int shapes_fill(unsigned char *data, size_t size, int (*visit)(void *ctx, int index), void *ctx) {
	for (size_t index = 0; index < size; index++) {
		data[index] = (unsigned char)index;
		if (visit(ctx, (int)index) != 0) return (int)index + 1;
	}
	return (int)size;
}

size_t shapes_path_length(ShapesPath path) { return (size_t)path.count; }

int shapes_sum2(int a, int b) { return a + b; }

int shapes_mul(int value, int factor) { return value * factor; }

uint32_t shapes_unsigned_max(void) { return UINT32_MAX; }

int shapes_sum3(int a, int b, int c) { return a + b + c; }
