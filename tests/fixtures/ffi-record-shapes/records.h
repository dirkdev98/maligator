#include <stddef.h>

typedef struct ShapeEnvelope {
    unsigned version;
    struct {
        int x;
        int y;
        enum { SHAPE_IDLE = 0, SHAPE_READY = 7 } mode : 3;
        unsigned long long serial : 35;
    };
    struct {
        double weight;
        struct { int code; };
    } detail;
    struct { int value; } items[2];
} ShapeEnvelope;

typedef struct ShapeState {
    struct { unsigned generation : 3; double weight; };
} ShapeState;

ShapeEnvelope shapes_copy(ShapeEnvelope value);
void shapes_update(ShapeEnvelope *value);
void shapes_visit(ShapeEnvelope value, ShapeEnvelope (*visit)(ShapeEnvelope));
int shapes_total(const ShapeEnvelope *values, size_t count);
void shapes_configure(ShapeState *state, unsigned generation, double weight);

typedef struct ConstShapePacket { const struct { int value; } detail; } ConstShapePacket;
typedef struct ConstPromotedPacket { struct { const int value; }; } ConstPromotedPacket;
ConstShapePacket shapes_const_copy(ConstShapePacket value);
ConstPromotedPacket shapes_const_promoted(ConstPromotedPacket value);
