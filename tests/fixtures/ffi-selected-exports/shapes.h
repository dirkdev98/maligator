#include <stdlib.h>

typedef struct ShapeBase { int value; } ShapeBase;
typedef struct ShapeCircle { ShapeBase base; } ShapeCircle;
typedef struct ShapeSquare { ShapeBase base; ShapeBase *origin; } ShapeSquare;

static inline ShapeCircle *shape_circle(int value) {
	ShapeCircle *circle = malloc(sizeof *circle);
	if (circle != NULL) circle->base.value = value;
	return circle;
}
static inline void shape_circle_free(ShapeCircle *circle) { free(circle); }
static inline int shape_value(ShapeBase *shape) { return shape->value; }
ShapeSquare *shape_square(int value);
void shape_square_free(ShapeSquare *square);
void shape_watch(ShapeBase *shape, void (*callback)(int value, void *data), void *data);
