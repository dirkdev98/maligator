#include "records.h"
#include <stdlib.h>

ShapeEnvelope shapes_copy(ShapeEnvelope value) { return value; }
void shapes_update(ShapeEnvelope *value) { value->x++; value->detail.code++; }
void shapes_visit(ShapeEnvelope value, ShapeEnvelope (*visit)(ShapeEnvelope)) {
    ShapeEnvelope returned = visit(value);
    if (returned.mode != value.mode || returned.serial != value.serial ||
        returned.detail.weight != value.detail.weight || returned.detail.code != value.detail.code ||
        returned.items[1].value != value.items[1].value) abort();
}
int shapes_total(const ShapeEnvelope *values, size_t count) {
    int sum = 0;
    for (size_t index = 0; index < count; index++) sum += values[index].x;
    return sum;
}
void shapes_configure(ShapeState *state, unsigned generation, double weight) {
    state->generation = generation;
    state->weight = weight;
}
ConstShapePacket shapes_const_copy(ConstShapePacket value) { return value; }
ConstPromotedPacket shapes_const_promoted(ConstPromotedPacket value) { return value; }
