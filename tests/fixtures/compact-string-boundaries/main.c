#include <stdio.h>
#include <string.h>

#include "array_object.h"
#include "ascii.h"
#include "builtin_iterator.h"
#include "gc.h"
#include "heap_string.h"
#include "node_path.h"
#include "object_ops.h"
#include "utf16.h"
#include "vm.h"
#include "vm_ops.h"
#include "web_headers_object.h"

extern const MalRuntimeImage mal_runtime_image;

#define CHECK(condition) \
    do { \
        if (!(condition)) { \
            printf("%s:%d CHECK FAIL: %s\n", __func__, __LINE__, #condition); \
            return false; \
        } \
    } while (0)

static MalCompletion call_method(
    MalVm *vm, MalValue receiver, const char *name, const MalValue *args, i32 count
) {
    MalValue method;
    if (!mal_vm_get_property(vm, receiver, mal_intrinsic_string_key(vm, name), &method)) {
        return vm->completion;
    }
    return mal_vm_call_value(vm, method, receiver, args, count);
}

static bool array_keys_stay_compact(MalVm *vm) {
    u8 bytes[4096];
    memset(bytes, 'x', sizeof(bytes));
    MalString *key = mal_string_new_latin1_copy(&vm->heap, bytes, countof(bytes));
    usize before = mal_heap_usage(&vm->heap).raw_owned_bytes;
    CHECK(!mal_array_key_is_length(mal_key_from_value(mal_value_from_string(key))));
    CHECK(key->latin1 && mal_heap_usage(&vm->heap).raw_owned_bytes == before);

    MalString literal;
    mal_string_init_external_latin1(&literal, (const u8 *) "length", 6);
    CHECK(mal_array_key_is_length(mal_key_from_value(mal_value_from_string(&literal))));
    CHECK(literal.latin1 && literal.storage == MAL_STRING_STORAGE_EXTERNAL);
    mal_string_init_external_latin1(&literal, (const u8 *) "lengtH", 6);
    CHECK(!mal_array_key_is_length(mal_key_from_value(mal_value_from_string(&literal))));
    CHECK(literal.latin1);
    return true;
}

static bool path_predicate_stays_compact(MalVm *vm) {
    MalValue predicate = mal_value_new_undefined();
    MalValue join = mal_value_new_undefined();
    MalValue resolve = mal_value_new_undefined();
    for (i32 i = 0; i < vm->runtime_image->host_install_count; i++) {
        const MalHostInstall *install = &vm->runtime_image->host_installs[i];
        if (install->installer != mal_host_install_node_path) continue;
        install->installer(vm, install->slots, install->slot_count, nullptr);
        for (i32 j = 0; j < install->slot_count; j++) {
            if (strcmp(install->slots[j].name, "isAbsolute") == 0) {
                predicate = vm->globals[install->slots[j].slot];
            } else if (strcmp(install->slots[j].name, "join") == 0) {
                join = vm->globals[install->slots[j].slot];
            } else if (strcmp(install->slots[j].name, "resolve") == 0) {
                resolve = vm->globals[install->slots[j].slot];
            }
        }
    }
    CHECK(mal_value_is_callable(predicate) && mal_value_is_callable(join) && mal_value_is_callable(resolve));
    u8 bytes[4096];
    memset(bytes, 'x', sizeof(bytes));
    bytes[0] = '/';
    MalValue roots[3] = {predicate, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    roots[1] = mal_value_from_string(mal_string_new_latin1_copy(&vm->heap, bytes, countof(bytes)));
    MalString *source = mal_value_to_string(roots[1]);
    MalCompletion result = mal_vm_call_value(vm, predicate, mal_value_new_undefined(), &roots[1], 1);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && result.value == mal_value_new_boolean(true));
    CHECK(source->latin1);
    MalString *rope;
    CHECK(mal_string_new_cons_checked(&vm->heap, source, source, &rope));
    roots[2] = mal_value_from_string(rope);
    result = mal_vm_call_value(vm, predicate, mal_value_new_undefined(), &roots[2], 1);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && result.value == mal_value_new_boolean(true));
    CHECK(source->latin1 && rope->storage == MAL_STRING_STORAGE_CONS);
    roots[2] = mal_value_from_string(mal_string_new_slice(&vm->heap, source, 1, 128));
    result = mal_vm_call_value(vm, predicate, mal_value_new_undefined(), &roots[2], 1);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && result.value == mal_value_new_boolean(false));
    CHECK(source->latin1);
    result = mal_vm_call_value(vm, join, mal_value_new_undefined(), &roots[1], 2);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value));
    CHECK(mal_value_to_string(result.value)->length == source->length + 129);
    CHECK(source->latin1 && mal_value_to_string(roots[2])->latin1);
    result = mal_vm_call_value(vm, resolve, mal_value_new_undefined(), &roots[1], 2);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value));
    CHECK(mal_value_to_string(result.value)->length == source->length + 129);
    CHECK(source->latin1 && mal_value_to_string(roots[2])->latin1);
    mal_gc_unroot(&span);
    return true;
}

static bool headers_preserve_sources(MalVm *vm) {
    MalValue roots[8];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalHeadersObject *headers = mal_headers_create(vm);
    roots[0] = mal_value_from_headers_object(headers);
    roots[1] = mal_value_from_string(mal_string_new_ascii(&vm->heap, "X-Long-Compact-Header", 21));
    const u8 value[] = " \t\r\nlong-latin1-header-value-\xe9\xff \t\r\n";
    roots[2] = mal_value_from_string(mal_string_new_latin1_copy(&vm->heap, value, sizeof(value) - 1));
    MalCompletion result = call_method(vm, roots[0], "append", &roots[1], 2);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && headers->count == 1);
    CHECK(mal_value_to_string(roots[1])->latin1 && mal_value_to_string(roots[2])->latin1);
    CHECK(mal_string_equals_ascii(headers->entries[0].name, "x-long-compact-header"));
    CHECK(headers->entries[0].name->latin1 && headers->entries[0].value->latin1);
    CHECK(headers->entries[0].value->length == sizeof(value) - 9);
    roots[3] = mal_value_from_string(headers->entries[0].value);

    roots[1] = mal_value_from_string(mal_string_new_ascii(&vm->heap, "x-long-compact-header", 21));
    roots[2] = mal_value_from_string(mal_string_new_ascii(&vm->heap, "plain-unchanged-value", 21));
    result = call_method(vm, roots[0], "append", &roots[1], 2);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && headers->count == 2);
    CHECK(headers->entries[1].name == mal_value_to_string(roots[1]));
    CHECK(headers->entries[1].value == mal_value_to_string(roots[2]));
    result = call_method(vm, roots[0], "get", &roots[1], 1);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value));
    roots[4] = result.value;
    CHECK(mal_value_to_string(result.value)->latin1);
    CHECK(mal_value_to_string(roots[3])->latin1 && mal_value_to_string(roots[2])->latin1);

    MalString *rope;
    CHECK(mal_string_new_cons_checked(&vm->heap, mal_value_to_string(roots[2]), mal_value_to_string(roots[2]), &rope));
    roots[5] = mal_value_from_string(rope);
    roots[2] = roots[5];
    result = call_method(vm, roots[0], "set", &roots[1], 2);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && headers->count == 1);
    CHECK(rope->storage == MAL_STRING_STORAGE_CONS && headers->entries[0].value == rope);
    result = call_method(vm, roots[0], "values", nullptr, 0);
    CHECK(result.kind == MAL_COMPLETION_NORMAL);
    roots[6] = result.value;
    result = call_method(vm, roots[6], "next", nullptr, 0);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && rope->storage == MAL_STRING_STORAGE_CONS);

    const c16 invalid[][3] = {{'a', 0x100, 'b'}, {'a', 0, 'b'}, {'a', '\r', 'b'}, {'a', '\n', 'b'}};
    for (usize i = 0; i < countof(invalid); i++) {
        roots[2] = mal_value_from_string(mal_string_new_copy(&vm->heap, invalid[i], 3));
        bool compact = mal_value_to_string(roots[2])->latin1;
        result = call_method(vm, roots[0], "append", &roots[1], 2);
        CHECK(result.kind == MAL_COMPLETION_THROW);
        CHECK(mal_value_to_string(roots[2])->latin1 == compact);
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    }
    roots[6] = mal_value_from_array_object(mal_intrinsic_new_dense_pair(vm, roots[1], roots[5]));
    roots[7] = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 1));
    CHECK(mal_array_object_store(mal_value_to_array_object(roots[7]), mal_key_index(0), roots[6]));
    MalHeadersObject *copied = mal_headers_from_init(vm, roots[7]);
    CHECK(copied != nullptr && copied->count == 1);
    roots[6] = mal_value_from_headers_object(copied);
    CHECK(copied->entries[0].value == rope && mal_value_to_string(roots[1])->latin1);
    mal_gc_collect(vm);
    CHECK(rope->storage == MAL_STRING_STORAGE_CONS);
    mal_gc_unroot(&span);
    return true;
}

static c16 iteration_unit(usize index) {
    switch (index % 128) {
        case 31: return 0xd834;
        case 32: return 0xdd1e;
        case 63: return 0xd800;
        case 95: return 0xdc00;
        default: return (c16) ('a' + index % 26);
    }
}

static bool string_iteration_reacquires_leaf_storage(MalVm *vm, usize leaves, bool flatten) {
    MalValue roots[5];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    for (usize leaf = 0; leaf < leaves; leaf++) {
        c16 units[32];
        for (usize i = 0; i < countof(units); i++) units[i] = iteration_unit(leaf * 32 + i);
        roots[1] = mal_value_from_string(mal_string_new_copy(&vm->heap, units, countof(units)));
        if (leaf == 0) roots[0] = roots[1];
        else {
            MalString *rope;
            CHECK(mal_string_new_cons_checked(&vm->heap, mal_value_to_string(roots[0]), mal_value_to_string(roots[1]), &rope));
            roots[0] = mal_value_from_string(rope);
        }
    }
    MalString *source = mal_value_to_string(roots[0]);
    MalIteratorRecord record;
    CHECK(mal_vm_get_iterator(vm, roots[0], &record));
    roots[2] = record.iterator;
    roots[3] = record.next_method;
    MalIteratorObject *cursor = mal_vm_iterator_protocol_cursor(&record, MAL_ITERATOR_CURSOR_STRING_VALUES);
    CHECK(cursor != nullptr);
    usize index = 0;
    while (index < source->length) {
        bool done;
        CHECK(index % 2 == 0
            ? mal_vm_iterator_step_protocol_cursor(vm, cursor, &roots[4], &done)
            : mal_vm_iterator_step(vm, &record, &roots[4], &done));
        CHECK(!done && mal_value_is_string(roots[4]));
        MalString *item = mal_value_to_string(roots[4]);
        c16 first = iteration_unit(index);
        usize count = mal_utf16_is_lead_surrogate(first) && index + 1 < source->length &&
            mal_utf16_is_trail_surrogate(iteration_unit(index + 1)) ? 2 : 1;
        CHECK(item->length == count && mal_string_code_unit_at(item, 0) == first);
        if (count == 2) CHECK(mal_string_code_unit_at(item, 1) == iteration_unit(index + 1));
        index += count;
        if (flatten && index == 97) {
            // The source drops its old children; the cursor alone now traces its leaf.
            CHECK(cursor->string_leaf != nullptr && cursor->string_leaf->latin1);
            mal_string_code_units(source);
            mal_string_code_units(cursor->string_leaf);
            mal_gc_collect(vm);
        }
        if (!flatten) CHECK(source->storage == MAL_STRING_STORAGE_CONS);
        if (index % 256 == 0) mal_gc_collect(vm);
    }
    bool done;
    CHECK(mal_vm_iterator_step_protocol_cursor(vm, cursor, &roots[4], &done));
    CHECK(done && cursor->string_leaf == nullptr);
    mal_gc_unroot(&span);
    return true;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    mal_headers_install(&vm, mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS]));
    bool passed = array_keys_stay_compact(&vm)
        && path_predicate_stays_compact(&vm)
        && headers_preserve_sources(&vm)
        && string_iteration_reacquires_leaf_storage(&vm, 8, false)
        && string_iteration_reacquires_leaf_storage(&vm, 512, false)
        && string_iteration_reacquires_leaf_storage(&vm, 512, true);
    mal_vm_free(&vm);
    if (!passed) return 1;
    puts("compact-string-boundaries PASS");
    return 0;
}
