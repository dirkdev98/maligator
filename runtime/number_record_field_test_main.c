#include "vm_ops.h"

#include <stdio.h>
#include <string.h>

#define CHECK(condition) do { if (!(condition)) { fprintf(stderr, "record field contract failed at line %d\n", __LINE__); return 1; } } while (0)
#define FRESH (&(MalShapeSnapshot) {0})

int main(void) {
    MalShapeProp primary_props[1] = {{.slot = 0, .field = mal_shape_field(MAL_FIELD_F64, 0)}};
    MalShapeProp alternate_props[3] = {{0}, {0}, {.slot = 2, .field = mal_shape_field(MAL_FIELD_F64, 16)}};
    MalShape primary = {.inline_count = 1, .props = primary_props};
    MalShape alternate = {.inline_count = 3, .props = alternate_props};
    MalShapeProp compact_props[3] = {{0}, {0}, {.slot = 2, .field = mal_shape_field(MAL_FIELD_I32, 4)}};
    MalShape compact = {.inline_count = 3, .props = compact_props, .logical = &alternate};
    f64 values[3] = {11.0, 22.0, 33.5};
    MalFunctionObject callable = {
        .object = {.header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_FUNCTION_OBJECT),
                   .storage_kind = MAL_OBJECT_EMBEDDED, .shape = &alternate},
        .object_storage = {.fields = values},
    };
    MalNumberRecord admitted;
    CHECK(mal_vm_number_record_begin(mal_value_from_function_object(&callable), false, &admitted));
    CHECK(admitted.fields == values && admitted.shape == &alternate);
    callable.object_storage.fields = nullptr;
    CHECK(!mal_vm_number_record_begin(mal_value_from_function_object(&callable), false, &admitted));
    CHECK(!mal_vm_property_read_region_begin(mal_value_from_function_object(&callable)).active);
    callable.object_storage.fields = values;
    CHECK(!mal_vm_number_record_begin(mal_value_from_function_object(&callable), true, &admitted));
    callable.object.header.type = MAL_HEAP_OBJECT;
    CHECK(mal_vm_number_record_begin(mal_value_from_object(&callable.object), false, &admitted));
    CHECK(!mal_vm_number_record_begin(mal_value_from_object(&callable.object), true, &admitted));
    MalObjectStorage external_fields = {.fields = values};
    struct { MalObject object; MalObjectStorage *storage; } external = {
        .object = {.header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_OBJECT),
                   .storage_kind = MAL_OBJECT_EXTERNAL, .shape = &alternate},
        .storage = &external_fields,
    };
    CHECK(mal_vm_number_record_begin(mal_value_from_object(&external.object), false, &admitted));
    CHECK(admitted.fields == values);
    CHECK(mal_vm_number_record_begin(mal_value_from_object(&external.object), true, &admitted));
    external.object.is_prototype = true;
    CHECK(!mal_vm_number_record_begin(mal_value_from_object(&external.object), true, &admitted));
    external.object.is_prototype = false;
    external.object.watched_method_proto = true;
    CHECK(!mal_vm_number_record_begin(mal_value_from_object(&external.object), true, &admitted));
    external.object.watched_method_proto = false;
    external.object.primordial_locked = true;
    CHECK(!mal_vm_number_record_begin(mal_value_from_object(&external.object), true, &admitted));
    external.object.primordial_locked = false;
    MalNumberRecord record = {.shape = &alternate, .fields = values};
    MalInlineCache cache = {.mode = MAL_IC_MODE_SHAPE, .shape = &primary, .slot = 0,
                           .field = primary_props[0].field, .poly_count = 1,
                           .poly_shape = {&alternate}};
    mal_ic_set_poly_slot(&cache, 0, 2);
    MalNumberRecordField field;
    f64 value;
    CHECK(mal_vm_number_record_field(&record, &cache, FRESH, &field, &value));
    CHECK(field.slot == 2 && value == 33.5);
    CHECK(mal_vm_number_record_try_store(&record, field, 44.5));
    CHECK(values[0] == 11.0 && values[1] == 22.0 && values[2] == 44.5);

    byte storage[24] = {0};
    i32 initial = 37, stored;
    memcpy(storage + 4, &initial, sizeof(initial));
    record.shape = &compact;
    record.fields = storage;
    CHECK(mal_vm_number_record_field(&record, &cache, FRESH, &field, &value));
    CHECK(field.slot == 2 && value == 37.0);
    CHECK(!mal_vm_number_record_try_store(&record, field, 0.5));
    memcpy(&stored, storage + 4, sizeof(stored));
    CHECK(stored == initial);
    CHECK(mal_vm_number_record_try_store(&record, field, 41.0));
    memcpy(&stored, storage + 4, sizeof(stored));
    CHECK(stored == 41);
    cache.poly_count = 0;
    CHECK(!mal_vm_number_record_field(&record, &cache, FRESH, &field, &value));
    cache.poly_count = 1;
    cache.mode = MAL_IC_MODE_TRANSITION;
    CHECK(!mal_vm_number_record_field(&record, &cache, FRESH, &field, &value));
    cache.mode = MAL_IC_MODE_SHAPE;
    cache.slot = MAL_IC_VALUE_SLOT;
    CHECK(!mal_vm_number_record_field(&record, &cache, FRESH, &field, &value));

    // A snapshot keeps answering for its own layout after the cache row moves on.
    cache = (MalInlineCache) {.mode = MAL_IC_MODE_SHAPE, .shape = &compact, .slot = 2,
                              .field = compact_props[2].field};
    MalShapeSnapshot snapshot = {0};
    CHECK(mal_vm_number_record_field(&record, &cache, &snapshot, &field, &value));
    CHECK(snapshot.shape == &compact && snapshot.slot == 2 && snapshot.field == compact_props[2].field);
    cache.mode = MAL_IC_MODE_TRANSITION;
    CHECK(mal_vm_number_record_field(&record, &cache, &snapshot, &field, &value));
    CHECK(field.slot == 2 && value == 41.0);
    record.shape = &alternate;
    record.fields = values;
    CHECK(!mal_vm_number_record_field(&record, &cache, &snapshot, &field, &value));

    // Admission read a Number, so a Number replaces it in a tagged field without barriers.
    MalShapeProp tagged_props[1] = {{.slot = 0, .field = mal_shape_field(MAL_FIELD_TAGGED, 0)}};
    MalShape tagged = {.inline_count = 1, .props = tagged_props};
    MalValue tagged_fields[1] = {mal_ops_number_value(2.5)};
    record.shape = &tagged;
    record.fields = tagged_fields;
    cache = (MalInlineCache) {.mode = MAL_IC_MODE_SHAPE, .shape = &tagged, .slot = 0,
                              .field = tagged_props[0].field};
    CHECK(mal_vm_number_record_field(&record, &cache, FRESH, &field, &value));
    CHECK(value == 2.5);
    CHECK(mal_vm_number_record_try_store(&record, field, -0.0));
    CHECK(tagged_fields[0] == mal_ops_number_value(-0.0));
    CHECK(mal_vm_number_record_try_store(&record, field, 7.0));
    CHECK(tagged_fields[0] == mal_ops_number_value(7.0));
    tagged_fields[0] = MAL_VALUE_UNDEFINED;
    CHECK(!mal_vm_number_record_field(&record, &cache, FRESH, &field, &value));
    puts("number-record-field PASS");
    return 0;
}
