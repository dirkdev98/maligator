#include "unions.h"
#include <stdlib.h>

Scalar scalar_integer(Scalar value) { return value; }
int scalar_number(int value) { return value; }
Scalar scalar_real(Scalar value) { return value; }
Scalar scalar_wide(Scalar value) { return value; }
Scalar scalar_bits(Scalar value) { return value; }
Scalar scalar_point(Scalar value) { return value; }
Scalar scalar_items(Scalar value) { return value; }
ScalarBox scalar_box(ScalarBox value) { return value; }
void scalar_update(Scalar *value) { value->real += 0.5; }
void scalar_out(Scalar *value) { value->wide = 0xffffffffffffffffULL; }
int scalar_many(const Scalar *values, size_t count) {
    int sum = 0;
    for (size_t index = 0; index < count; index++) sum += values[index].integer;
    return sum;
}
double scalar_real_many(const Scalar *values, size_t count) {
    double sum = 0;
    for (size_t index = 0; index < count; index++) sum += values[index].real;
    return sum;
}
const Scalar *scalar_arrays(size_t *count) {
    static const Scalar values[] = {{.items = {2, 3, 5}}, {.items = {7, 11, 13}}};
    *count = sizeof(values) / sizeof(values[0]);
    return values;
}
void scalar_visit(Scalar value, Scalar (*visit)(Scalar)) {
    Scalar result = visit(value);
    if (result.point.x != value.point.x || result.point.y != value.point.y) abort();
}
int resource_read(Resource value) { return *value.data; }
ResourceParent resource_parent_new(void) { return (ResourceParent){.version = 1}; }
void resources_visit(void (*visit)(ResourcePayload)) {
    ResourcePayload value = {.resources = {{.value = 41, .data = malloc(sizeof(int))}}};
    if (value.resources[0].data == NULL) abort();
    *value.resources[0].data = 41;
    visit(value);
    free(value.resources[0].data);
}
void resources_record_visit(void (*visit)(ResourceRecord)) {
    ResourceRecord value = {.resources = {{.value = 43, .data = malloc(sizeof(int))}}};
    if (value.resources[0].data == NULL) abort();
    *value.resources[0].data = 43;
    visit(value);
    free(value.resources[0].data);
}
void resources_keep(void (*visit)(ResourcePayload, void *), void *data, void (*release)(void *)) {
    (void) visit;
    release(data);
}
