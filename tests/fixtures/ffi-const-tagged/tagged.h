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
typedef union ConstEvent {
    struct { const unsigned kind; };
    struct { const unsigned kind; double x; } point;
    struct { const unsigned kind; int value; } integer;
} ConstEvent;
typedef struct ConstPromotedEvent {
    const int id;
    union {
        struct { const unsigned kind; };
        struct { const unsigned kind; double x; } point;
    };
} ConstPromotedEvent;
typedef union { const _Bool kind; float payload; } ConstIncompatibleOverlap;
int tagged_bad_overlap(ConstIncompatibleOverlap value);
typedef struct { union { const _Bool kind; double payload; }; } ConstIncompatiblePromotedOverlap;
int tagged_bad_promoted_overlap(ConstIncompatiblePromotedOverlap value);
ConstEvent event_make(unsigned kind, int seed);
int event_take(ConstEvent value);
ConstEvent event_identity(ConstEvent value);
void event_out(ConstEvent *value);
void event_inout(ConstEvent *value);
int event_sum(const ConstEvent *values, size_t count);
int event_visit(ConstEvent value, int (*callback)(ConstEvent, void *), void *data);
ConstEvent event_callback(ConstEvent (*callback)(void));
void event_notify(ConstEvent value, void (*callback)(ConstEvent, void *), void *data, void (*release)(void *));
int event_callback_error(ConstEvent (*callback)(void));
ConstPromotedEvent promoted_event_make(int seed);
int promoted_event_take(ConstPromotedEvent value);
typedef union ConstOffsetEvent {
    struct { int prefix; const unsigned kind; };
    struct { int prefix; const unsigned kind; double x; } point;
} ConstOffsetEvent;
int offset_event_take(ConstOffsetEvent value);
typedef union ConstNestedEvent {
    struct { struct { const unsigned kind; }; };
    struct { struct { const unsigned kind; }; int value; } point;
} ConstNestedEvent;
int nested_event_take(ConstNestedEvent value);
typedef union ConstBitEvent {
    struct { const unsigned kind : 3; };
    struct { const unsigned kind : 3; int value; } point;
} ConstBitEvent;
int bit_event_take(ConstBitEvent value);
typedef union ConstBadPrefix {
    struct { int prefix; const unsigned kind; };
    struct { float prefix; const unsigned kind; int value; } point;
} ConstBadPrefix;
int tagged_bad_prefix(ConstBadPrefix value);
typedef union ConstBadOffset {
    struct { char prefix; const unsigned kind; };
    struct __attribute__((packed)) { char prefix; const unsigned kind; int value; } point;
} ConstBadOffset;
int tagged_bad_offset(ConstBadOffset value);
typedef union ConstBadWidth {
    struct { const unsigned kind : 3; };
    struct { const unsigned kind : 4; int value; } point;
} ConstBadWidth;
int tagged_bad_width(ConstBadWidth value);
