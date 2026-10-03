#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "array_buffer_object.h"
#include "array_object.h"
#include "gc_process.h"
#include "intrinsics.h"
#include "serialize.h"
#include "vm.h"

#define CHECK(condition) do { if (!(condition)) { \
    fprintf(stderr, "check failed at %d: %s\n", __LINE__, #condition); abort(); \
} } while (0)

extern const MalRuntimeImage mal_runtime_image;

static const byte *watched_store;
static usize watched_releases;

static void observe_release(const MalArrayBufferObject *buffer, const byte *data, u32 capacity) {
    if (data != watched_store) return;
    CHECK(buffer->sensitive && capacity == 128);
    for (u32 i = 0; i < capacity; i++) CHECK(data[i] == 0);
    watched_releases++;
}

static bool encode_failure_marker(void *data, MalVm *vm, MalValue value, bool transfer,
        MalSerializeHostDescriptor *out) {
    (void) vm;
    (void) transfer;
    if (value != *(MalValue *) data) return false;
    out->kind = 1;
    return true;
}

static bool reject_marker(void *data, MalVm *vm, MalSerializeHostDescriptor *descriptor,
        MalValue *out) {
    (void) data;
    (void) descriptor;
    (void) out;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "receiver rejected marker");
    return false;
}

static MalValue array(MalVm *vm, const MalValue *values, u32 count) {
    return mal_value_from_array_object(mal_array_object_new_from_values(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), values, count));
}

static MalSerializedValue *snapshot(MalVm *vm, MalValue value, MalValue transfers,
        const MalSerializeHooks *hooks) {
    const char *error = nullptr;
    MalSerializedValue *result = mal_serialize(vm, value, transfers, nullptr, hooks, &error);
    CHECK(result != nullptr && error == nullptr && mal_serialize_commit(vm, result));
    return result;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    MalValue roots[12];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalObject *prototype = mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]);

    MalArrayBufferObject *source = mal_array_buffer_object_new(&vm.heap, prototype, 16, 128, true, false);
    roots[0] = mal_value_from_array_buffer_object(source);
    memset(source->data, 0xA5, source->allocation_capacity);
    source->sensitive = true;
    watched_store = source->data;
    mal_array_buffer_object_set_release_observer(observe_release);
    roots[1] = array(&vm, roots, 1);
    MalValue repeated[] = {roots[0], roots[0]};
    roots[2] = array(&vm, repeated, 2);
    MalSerializedValue *moved = snapshot(&vm, roots[2], roots[1], nullptr);
    CHECK(source->detached && source->data == nullptr && source->allocation_capacity == 0);
    CHECK(mal_deserialize_take(&vm, moved, nullptr, &roots[3]));
    MalValue first, second;
    CHECK(mal_array_object_dense_get(mal_value_to_array_object(roots[3]), 0, &first));
    CHECK(mal_array_object_dense_get(mal_value_to_array_object(roots[3]), 1, &second));
    CHECK(first == second);
    MalArrayBufferObject *received = mal_value_to_array_buffer_object(first);
    CHECK(received->data == watched_store && received->allocation_capacity == 128);
    CHECK(received->resizable && received->byte_length == 16 && received->max_byte_length == 128);
    CHECK(received->sensitive && (u8) received->data[0] == 0xA5);
    CHECK(!mal_deserialize_take(&vm, moved, nullptr, &roots[4]));
    CHECK(vm.completion.kind == MAL_COMPLETION_THROW);
    vm.completion.kind = MAL_COMPLETION_NORMAL;
    mal_serialized_value_release(moved);
    CHECK(watched_releases == 0 && (u8) received->data[0] == 0xA5);
    CHECK(mal_array_buffer_object_resize(received, 32));
    for (u32 i = 16; i < 32; i++) CHECK(received->data[i] == 0);

    roots[4] = mal_value_from_array_buffer_object(mal_array_buffer_object_new(
        &vm.heap, prototype, 64, 64, false, false));
    MalArrayBufferObject *large = mal_value_to_array_buffer_object(roots[4]);
    roots[5] = mal_value_from_array_buffer_object(mal_array_buffer_object_move_store(
        &vm.heap, prototype, large, 8, 8, false, false));
    byte *physical = mal_value_to_array_buffer_object(roots[5])->data;
    roots[6] = array(&vm, &roots[5], 1);
    moved = snapshot(&vm, roots[5], roots[6], nullptr);
    CHECK(mal_deserialize_take(&vm, moved, nullptr, &roots[7]));
    MalArrayBufferObject *small = mal_value_to_array_buffer_object(roots[7]);
    CHECK(small->data == physical && small->allocation_capacity == 64);
    CHECK(!small->resizable && small->byte_length == 8 && small->max_byte_length == 8);
    mal_serialized_value_release(moved);

    small->immutable = true;
    small->data[0] = 23;
    MalSerializedValue *reusable = snapshot(&vm, roots[7], mal_value_new_undefined(), nullptr);
    CHECK(mal_deserialize(&vm, reusable, nullptr, &roots[8]));
    CHECK(mal_deserialize(&vm, reusable, nullptr, &roots[9]));
    MalArrayBufferObject *copy1 = mal_value_to_array_buffer_object(roots[8]);
    MalArrayBufferObject *copy2 = mal_value_to_array_buffer_object(roots[9]);
    CHECK(copy1->data != small->data && copy2->data != copy1->data);
    CHECK(!copy1->immutable && !copy2->immutable && copy1->data[0] == 23 && copy2->data[0] == 23);
    CHECK(mal_deserialize_take(&vm, reusable, nullptr, &roots[10]));
    CHECK(!mal_value_to_array_buffer_object(roots[10])->immutable);
    mal_serialized_value_release(reusable);

    roots[4] = mal_value_from_array_buffer_object(mal_array_buffer_object_new(
        &vm.heap, prototype, 16, 64, true, false));
    MalArrayBufferObject *failure_source = mal_value_to_array_buffer_object(roots[4]);
    byte *failure_store = failure_source->data;
    roots[5] = mal_value_from_object(mal_intrinsic_new_object(&vm));
    const MalSerializeHooks hooks = {.data = &roots[5], .encode = encode_failure_marker, .decode = reject_marker};
    roots[6] = array(&vm, &roots[4], 1);
    roots[7] = array(&vm, &roots[4], 2);
    moved = snapshot(&vm, roots[7], roots[6], &hooks);
    CHECK(!mal_deserialize_take(&vm, moved, &hooks, &roots[11]));
    CHECK(vm.completion.kind == MAL_COMPLETION_THROW);
    vm.completion.kind = MAL_COMPLETION_NORMAL;
    CHECK(mal_array_object_dense_get(mal_value_to_array_object(roots[11]), 0, &first));
    CHECK(mal_value_to_array_buffer_object(first)->data == failure_store);
    mal_serialized_value_release(moved);
    CHECK(mal_array_buffer_object_resize(mal_value_to_array_buffer_object(first), 32));

    mal_gc_unroot(&span);
    mal_vm_free(&vm);
    CHECK(watched_releases == 1 && mal_gc_process_bytes() == 0);
    mal_array_buffer_object_set_release_observer(nullptr);
    puts("clone-take PASS");
    return 0;
}
