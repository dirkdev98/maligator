#include "vm_ops.h"

#include <stdio.h>
#include <string.h>

extern const MalRuntimeImage mal_runtime_image;

#define CHECK(condition) do { if (!(condition)) { fprintf(stderr, "record field contract failed at line %d\n", __LINE__); return 1; } } while (0)
#define FRESH (&(MalShapeSnapshot) {0})

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    MalValue callable = mal_vm_op_create_function(&vm, 0, nullptr);
    MalRootSpan callable_root;
    mal_gc_root(&callable_root, &callable, 1);
    MalObject *callable_object = &mal_value_to_function_object(callable)->object;
    void *callable_fields = mal_object_fields(callable_object);
    MalShapeProp primary_props[1] = {{.slot = 0}};
    MalShapeProp alternate_props[3] = {{.slot = 0}, {.slot = 1}, {.slot = 2}};
    MalShape primary = {.inline_count = 1, .props = primary_props};
    MalShape alternate = {.inline_count = 3, .props = alternate_props};
    MalValue values[3] = {
        mal_ops_number_value(11.0), mal_ops_number_value(22.0), mal_ops_number_value(33.5)};
    MalNumberRecord admitted;
    CHECK(mal_vm_number_record_begin(callable, false, &admitted));
    CHECK(admitted.fields == callable_fields && admitted.shape == callable_object->shape);
    CHECK(!mal_vm_number_record_begin(callable, true, &admitted));
    mal_object_set_fields_pointer(callable_object, nullptr);
    CHECK(!mal_vm_number_record_begin(callable, false, &admitted));
    CHECK(!mal_vm_property_read_region_begin(callable).active);
    mal_object_set_fields_pointer(callable_object, callable_fields);
    CHECK(mal_vm_number_record_begin(callable, false, &admitted));
    CHECK(admitted.fields == callable_fields && admitted.shape == callable_object->shape);
    CHECK(!mal_vm_number_record_begin(callable, true, &admitted));
    MalEmbeddedObject embedded;
    mal_object_init_embedded_stack(&vm.heap, &embedded, nullptr, &alternate, values);
    CHECK(mal_vm_number_record_begin(mal_value_from_object(&embedded.object), false, &admitted));
    CHECK(admitted.fields == values && admitted.shape == &alternate);
    CHECK(!mal_vm_number_record_begin(mal_value_from_object(&embedded.object), true, &admitted));
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
                           .poly_count = 1, .poly_shape = {&alternate}};
    mal_ic_set_poly_slot(&cache, 0, 2);
    MalNumberRecordField field;
    f64 value;
    CHECK(mal_vm_number_record_field(&record, &cache, FRESH, &field, &value));
    CHECK(field.slot == 2 && value == 33.5);
    mal_vm_number_record_store(&record, field, 44.5);
    CHECK(values[0] == mal_ops_number_value(11.0) && values[1] == mal_ops_number_value(22.0) &&
          values[2] == mal_ops_number_value(44.5));
    cache.poly_count = 0;
    CHECK(!mal_vm_number_record_field(&record, &cache, FRESH, &field, &value));
    cache.poly_count = 1;
    cache.mode = MAL_IC_MODE_TRANSITION;
    CHECK(!mal_vm_number_record_field(&record, &cache, FRESH, &field, &value));
    cache.mode = MAL_IC_MODE_WATCHED_VALUE;
    CHECK(!mal_vm_number_record_field(&record, &cache, FRESH, &field, &value));

    // A snapshot keeps answering for its own shape after the cache row moves on.
    cache = (MalInlineCache) {.mode = MAL_IC_MODE_SHAPE, .shape = &alternate, .slot = 2};
    MalShapeSnapshot snapshot = {0};
    CHECK(mal_vm_number_record_field(&record, &cache, &snapshot, &field, &value));
    CHECK(snapshot.shape == &alternate && snapshot.slot == 2);
    cache.mode = MAL_IC_MODE_TRANSITION;
    CHECK(mal_vm_number_record_field(&record, &cache, &snapshot, &field, &value));
    CHECK(field.slot == 2 && value == 44.5);
    record.shape = &primary;
    CHECK(!mal_vm_number_record_field(&record, &cache, &snapshot, &field, &value));

    // Admission read a Number, so a Number replaces it without barriers.
    MalValue tagged_fields[1] = {mal_ops_number_value(2.5)};
    record.shape = &primary;
    record.fields = tagged_fields;
    cache = (MalInlineCache) {.mode = MAL_IC_MODE_SHAPE, .shape = &primary, .slot = 0};
    CHECK(mal_vm_number_record_field(&record, &cache, FRESH, &field, &value));
    CHECK(value == 2.5);
    mal_vm_number_record_store(&record, field, -0.0);
    CHECK(tagged_fields[0] == mal_ops_number_value(-0.0));
    mal_vm_number_record_store(&record, field, 7.0);
    CHECK(tagged_fields[0] == mal_ops_number_value(7.0));
    tagged_fields[0] = MAL_VALUE_UNDEFINED;
    CHECK(!mal_vm_number_record_field(&record, &cache, FRESH, &field, &value));
    mal_gc_unroot(&callable_root);
    mal_vm_free(&vm);
    puts("number-record-field PASS");
    return 0;
}
