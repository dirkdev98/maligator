#pragma once
#include <stddef.h>
#include <stdint.h>

typedef struct { const int value; int writable; } ConstPoint;
typedef struct __attribute__((aligned(64))) ConstTagged {
    struct { const unsigned kind : 3; };
    const int id;
    union { const int integer; ConstPoint point; const int samples[2]; } payload;
} ConstTagged;
typedef struct { const int id; ConstTagged values[2]; } ConstTaggedPair;
ConstTagged tagged_make(unsigned kind, int seed);
int tagged_take(ConstTagged value);
void tagged_out(ConstTagged *value);
void tagged_inout(ConstTagged *value);
int tagged_sum(const ConstTagged *values, size_t count);
int tagged_pair(ConstTaggedPair value);
void tagged_pair_inout(ConstTagged (*value)[2]);
int tagged_visit(ConstTagged value, int (*callback)(ConstTagged, void *), void *data);
void tagged_notify(ConstTagged value, void (*callback)(ConstTagged, void *), void *data, void (*release)(void *));
int tagged_calls(void);
ConstTagged tagged_callback(ConstTagged (*callback)(void));
typedef union { const int kind; int payload; } ConstOverlap;
int tagged_overlap(ConstOverlap value);
typedef struct { union { const int kind; int payload; }; } ConstPromotedOverlap;
int tagged_promoted_overlap(ConstPromotedOverlap value);
