#include "tagged.h"
#include <stdlib.h>

Tagged tagged_echo(Tagged value) { value.serial++; return value; }
Tagged tagged_unknown(void) { return (Tagged) { .kind = -1 }; }
void tagged_out(Tagged *value) { *value = (Tagged) { PRIVATE_TAG_INTEGER, 7, { .integer = 42 } }; }
void tagged_update(Tagged *value) { value->serial++; }
int tagged_many(const Tagged *values, size_t count) {
    int sum = 0;
    for (size_t i = 0; i < count; i++) {
        if (values[i].kind == PRIVATE_TAG_INTEGER) sum += values[i].payload.integer;
        else if (values[i].kind == PRIVATE_TAG_POINT) sum += (int) values[i].payload.point.x;
    }
    return sum;
}
const Tagged *tagged_array(size_t *count) {
    static const Tagged values[] = {
        { PRIVATE_TAG_INTEGER, 1, { .integer = 5 } },
        { PRIVATE_TAG_POINT, 2, { .point = { 3, 4 } } },
        { PRIVATE_TAG_DONE, 3, { .integer = 99 } },
    };
    *count = sizeof(values) / sizeof(values[0]);
    return values;
}
Tagged tagged_visit(Tagged value, Tagged (*visit)(Tagged)) { return visit(value); }
Anonymous anonymous_echo(Anonymous value) { return value; }
Multiple multiple_echo(Multiple value) { return value; }
Root root_echo(Root value) { return value; }
WideTag wide_echo(WideTag value) { return value; }
BoolTag bool_echo(BoolTag value) { return value; }
Nested nested_echo(Nested value) { return value; }
Batch batch_echo(Batch value) { return value; }
Envelope envelope_echo(Envelope value) { return value; }
Deep deep_echo(Deep value) { return value; }
SignedTag signed_echo(SignedTag value) { return value; }
PromotedTag promoted_echo(PromotedTag value) { return value; }
Defaulted defaulted_echo(Defaulted value) { return value; }
DefaultOuter default_outer_echo(DefaultOuter value) { return value; }
struct Owner { int value; };
Owner *owner_new(void) { Owner *owner = malloc(sizeof(*owner)); owner->value = 17; return owner; }
void owner_destroy(Owner *owner) { free(owner); }
int owner_read(Owner *owner, Tagged value) { return owner->value + value.serial; }
int resource_read(Resource value) { return value.value + *value.data; }
void resource_visit(void (*visit)(TaggedResource)) {
    int *data = malloc(sizeof(*data));
    *data = 23;
    TaggedResource value = { .kind = 1, .payload.items = { { 19, data } } };
    visit(value);
    free(data);
}
TaggedResource resource_result(void) { return (TaggedResource) { .kind = 2, .payload.integer = 1 }; }
TaggedResource resource_transform(TaggedResource (*visit)(void)) { return visit(); }
void resource_keep(void (*visit)(TaggedResource, void *), void *data, void (*release)(void *)) {
    visit((TaggedResource) { .kind = 2, .payload.integer = 1 }, data);
    release(data);
}
