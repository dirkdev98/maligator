#include <stddef.h>
#include <stdint.h>
#include "private-tags.h"

typedef struct Point { double x; double y; } Point;
typedef struct Tagged {
    int kind;
    int serial;
    union { int integer; Point point; const void *hidden; } payload;
} Tagged;
typedef struct Anonymous {
    int kind;
    union { int integer; Point point; };
} Anonymous;
typedef struct Multiple {
    unsigned kind : 3;
    union { int left_integer; double left_real; };
    union { int right_integer; double right_real; };
} Multiple;
typedef union Root {
    int kind;
    struct { int kind; double x; } point;
    struct { int kind; int number; } integer;
} Root;
typedef struct WideTag { uint64_t kind; union { int integer; } payload; } WideTag;
typedef struct BoolTag { _Bool kind; union { int integer; double real; } payload; } BoolTag;
Tagged tagged_echo(Tagged value);
Tagged tagged_unknown(void);
void tagged_out(Tagged *value);
void tagged_update(Tagged *value);
int tagged_many(const Tagged *values, size_t count);
const Tagged *tagged_array(size_t *count);
Tagged tagged_visit(Tagged value, Tagged (*visit)(Tagged));
Anonymous anonymous_echo(Anonymous value);
Multiple multiple_echo(Multiple value);
Root root_echo(Root value);
WideTag wide_echo(WideTag value);
BoolTag bool_echo(BoolTag value);
typedef struct Nested { int kind; struct { union { int integer; Point point; } data; } box; } Nested;
typedef struct Batch { Tagged items[2]; } Batch;
Nested nested_echo(Nested value);
Batch batch_echo(Batch value);
typedef struct Envelope { int kind; union { Tagged event; int integer; } payload; } Envelope;
Envelope envelope_echo(Envelope value);
typedef struct Deep { int kind; union { union { int integer; Point point; } inner; int flag; } payload; } Deep;
Deep deep_echo(Deep value);
typedef struct SignedTag { int64_t kind; union { int integer; } payload; } SignedTag;
SignedTag signed_echo(SignedTag value);
typedef struct PromotedTag { struct { int kind; }; union { int integer; Point point; }; } PromotedTag;
PromotedTag promoted_echo(PromotedTag value);
typedef union DefaultPayload { int integer; double real; } DefaultPayload;
typedef struct Defaulted { int kind; DefaultPayload payload; } Defaulted;
Defaulted defaulted_echo(Defaulted value);
typedef struct DefaultOuter { int kind; union { DefaultPayload inner; int unused; } payload; } DefaultOuter;
DefaultOuter default_outer_echo(DefaultOuter value);
typedef struct Owner Owner;
Owner *owner_new(void);
void owner_destroy(Owner *owner);
int owner_read(Owner *owner, Tagged value);
typedef struct Resource { int value; int *data; } Resource;
typedef struct TaggedResource { int kind; union { Resource items[1]; int integer; } payload; } TaggedResource;
int resource_read(Resource value);
void resource_visit(void (*visit)(TaggedResource));
TaggedResource resource_result(void);
TaggedResource resource_transform(TaggedResource (*visit)(void));
void resource_keep(void (*visit)(TaggedResource, void *), void *data, void (*release)(void *));
