#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#if defined(__APPLE__)
#include <malloc/malloc.h>
#elif defined(__GLIBC__)
#include <malloc.h>
#endif

#include "array_buffer_object.h"
#include "builtin_uri.h"
#include "vm_ops.h"
#include "gc.h"
#include "heap_string.h"
#include "runtime/node_buffer.h"
#include "typed_array_object.h"
#include "utf8.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

#define CHECK(condition) \
    do { \
        if (!(condition)) { \
            printf("%s:%d CHECK FAIL: %s\n", __func__, __LINE__, #condition); \
            return false; \
        } \
    } while (0)

static bool compact_decode_preserves_code_units_and_failures(MalVm *vm) {
    byte latin1[384];
    usize length = 0;
    for (u32 cp = 0; cp <= 255; cp++) {
        if (cp < 128) latin1[length++] = (byte) cp;
        else {
            latin1[length++] = (byte) (0xc0 | (cp >> 6));
            latin1[length++] = (byte) (0x80 | (cp & 63));
        }
    }
    usize before = mal_heap_usage(&vm->heap).raw_owned_bytes;
    bool had_error;
    MalUtf8DecodeStatus status;
    MalString *string = mal_string_from_utf8_report(
        &vm->heap, latin1, length, &had_error, &status);
    CHECK(string != nullptr && status == MAL_UTF8_DECODE_OK && !had_error);
    CHECK(string->length == 256 && string->latin1);
    CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes - before == mal_heap_allocation_charge(256));
    for (usize i = 0; i < 256; i++) CHECK(mal_string_code_unit_at(string, i) == i);

    const byte prefix_malformed[] = {(byte) 0xc3, (byte) 0xa9, (byte) 0xc2, (byte) 0xa0,
        (byte) 0xc3, '!', (byte) 0xe2, (byte) 0x82};
    const c16 prefix_expected[] = {0xe9, 0xa0, 0xfffd, '!', 0xfffd};
    string = mal_string_from_utf8_report(&vm->heap, prefix_malformed,
        countof(prefix_malformed), &had_error, &status);
    CHECK(string != nullptr && status == MAL_UTF8_DECODE_OK && had_error);
    CHECK(string->length == countof(prefix_expected));
    for (usize i = 0; i < countof(prefix_expected); i++) {
        CHECK(mal_string_code_unit_at(string, i) == prefix_expected[i]);
    }

    const byte malformed[] = {
        (byte) 0xe1, (byte) 0x80, 'A', (byte) 0xed, (byte) 0xa0, (byte) 0x80,
        (byte) 0xf4, (byte) 0x90, (byte) 0x80, (byte) 0x80,
        (byte) 0xf0, (byte) 0x9f, (byte) 0x98, (byte) 0x80,
        (byte) 0xf0, (byte) 0x9f
    };
    const c16 expected[] = {
        0xfffd, 'A', 0xfffd, 0xfffd, 0xfffd,
        0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xd83d, 0xde00, 0xfffd
    };
    string = mal_string_from_utf8_report(
        &vm->heap, malformed, countof(malformed), &had_error, &status);
    CHECK(string != nullptr && status == MAL_UTF8_DECODE_OK && had_error);
    CHECK(!string->latin1 && string->length == countof(expected));
    for (usize i = 0; i < countof(expected); i++) {
        CHECK(mal_string_code_unit_at(string, i) == expected[i]);
    }
    MalValue root = mal_value_from_string(string);
    MalRootSpan span;
    mal_gc_root(&span, &root, 1);
    mal_gc_collect(vm);
    for (usize i = 0; i < countof(expected); i++) {
        CHECK(mal_string_code_unit_at(string, i) == expected[i]);
    }
    mal_gc_unroot(&span);
    mal_gc_collect(vm);

    before = mal_heap_usage(&vm->heap).raw_owned_bytes;
    vm->heap.fail_next_raw_allocation = true;
    string = mal_string_from_utf8_report(
        &vm->heap, latin1 + 128, length - 128, &had_error, &status);
    CHECK(string == nullptr && status == MAL_UTF8_DECODE_ALLOCATION_FAILURE && !had_error);
    CHECK(!vm->heap.fail_next_raw_allocation);
    CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes == before);
    return true;
}

static bool buffer_accepts_large_decoded_units(MalVm *vm) {
    MalValue encoding = mal_value_from_string(
        mal_string_new_ascii(&vm->heap, (const byte *) "utf8", 4));
    MalRootSpan encoding_root;
    mal_gc_root(&encoding_root, &encoding, 1);
    const u8 patterns[][3] = {{0xc3, 0xa9, 0}, {0xe2, 0x82, 0xac}, {0xe1, 0x80, 0}};
    const usize widths[] = {2, 3, 2};
    const c16 units[] = {0xe9, 0x20ac, 0xfffd};
    const usize count = ((usize) 1 << 25) + 1;
    for (usize test = 0; test < countof(widths); test++) {
        usize width = widths[test];
        byte *input = malloc(count * width);
        CHECK(input != nullptr);
        for (usize i = 0; i < count; i++) memcpy(input + i * width, patterns[test], width);
        MalValue result = mal_node_buffer_encode_bytes(vm, input, count * width, encoding, true);
        CHECK(vm->completion.kind != MAL_COMPLETION_THROW && mal_value_is_string(result));
        MalString *string = mal_value_to_string(result);
        CHECK(string->length == count && string->latin1 == (test == 0));
        CHECK(mal_string_code_unit_at(string, 0) == units[test]);
        CHECK(mal_string_code_unit_at(string, count - 1) == units[test]);
        free(input);
        mal_gc_collect(vm);
    }
    const byte pair[] = {(byte) 0xf0, (byte) 0x9f, (byte) 0x98, (byte) 0x80};
    byte *astral = malloc(count * 4 + 1);
    CHECK(astral != nullptr);
    for (usize i = 0; i < count; i++) memcpy(astral + i * 4, pair, 4);
    astral[count * 4] = 'x';
    MalUtf8DecodeStatus status;
    MalString *string = mal_string_from_utf8_report(&vm->heap, astral, count * 4 + 1, nullptr, &status);
    CHECK(string != nullptr && status == MAL_UTF8_DECODE_OK && string->length == count * 2 + 1);
    CHECK(mal_string_code_unit_at(string, count * 2 - 2) == 0xd83d);
    CHECK(mal_string_code_unit_at(string, count * 2 - 1) == 0xde00);
    CHECK(mal_string_code_unit_at(string, count * 2) == 'x');
    free(astral);
    mal_gc_unroot(&encoding_root);
    mal_gc_collect(vm);
    return true;
}

static bool take_range_error(MalVm *vm) {
    bool range = vm->completion.kind == MAL_COMPLETION_THROW &&
        mal_value_is_object(vm->completion.value) &&
        mal_object_prototype(mal_value_to_object(vm->completion.value)) ==
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE]);
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    return range;
}

static bool rejects_unrepresentable_outputs_before_materialization(MalVm *vm) {
    usize bytes = MAL_STRING_MAX_CODE_UNITS + 1;
    // Anonymous zero pages give real readable input without committing its logical
    // size. Overflow must be catchable before allocating a decoded output.
    byte *input = mmap(nullptr, bytes, PROT_READ, MAP_PRIVATE | MAP_ANON, -1, 0);
    CHECK(input != MAP_FAILED);
    MalValue encoding = mal_value_from_string(mal_intrinsic_ascii(vm, "utf8"));
    MalValue result = mal_node_buffer_encode_bytes(vm, input, bytes, encoding, true);
    CHECK(mal_value_is_undefined(result) && take_range_error(vm));

    MalString *string = mal_string_new_external(
        &vm->heap, (const c16 *) input, MAL_STRING_MAX_CODE_UNITS / 3 + 1);
    MalValue rooted = mal_value_from_string(string);
    MalRootSpan root;
    mal_gc_root(&root, &rooted, 1);
    result = mal_builtin_uri_encode_known(vm, string, true);
    CHECK(mal_value_is_undefined(result) && take_range_error(vm));
    mal_gc_unroot(&root);
    CHECK(munmap(input, bytes) == 0);

    const char *methods[] = {"toHex", "toBase64"};
    const u32 lengths[] = {MAL_STRING_MAX_CODE_UNITS / 2 + 1, (MAL_STRING_MAX_CODE_UNITS / 4) * 3 + 1};
    for (usize i = 0; i < countof(methods); i++) {
        mal_gc_collect(vm);
        // These methods must reject from the extent before observing any byte.
        MalArrayBufferObject *backing = mal_array_buffer_object_new_uninitialized(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
            lengths[i], lengths[i], false, false, false);
        CHECK(backing->data != nullptr);
        MalValue roots[] = {mal_value_from_array_buffer_object(backing), mal_value_new_undefined(), mal_value_new_undefined()};
        MalRootSpan span;
        mal_gc_root(&span, roots, countof(roots));
        MalTypedArrayObject *array = mal_typed_array_object_new(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]),
            backing, MAL_TA_UINT8, 0, lengths[i], false);
        roots[1] = mal_value_from_typed_array_object(array);
        CHECK(mal_vm_get_property(vm, roots[1], mal_intrinsic_string_key(vm, methods[i]), &roots[2]));
        MalCompletion completion = mal_vm_call_value(vm, roots[2], roots[1], nullptr, 0);
        CHECK(completion.kind == MAL_COMPLETION_THROW && take_range_error(vm));
        mal_gc_unroot(&span);
    }
    mal_gc_collect(vm);
    return true;
}

static bool adopted_utf8_storage_matches_output(MalVm *vm) {
    usize length = 65536;
    u8 *ascii = malloc(length);
    CHECK(ascii != nullptr);
    memset(ascii, 'a', length);
    MalValue string = mal_value_from_string(mal_string_new_latin1_copy(&vm->heap, ascii, length));
    free(ascii);
    usize written;
    byte *encoded = mal_node_buffer_decode_string(vm, string, mal_value_new_undefined(), &written);
    CHECK(encoded != nullptr && written == length);
#if defined(__APPLE__)
    CHECK(malloc_size(encoded) < written + 8192);
#elif defined(__GLIBC__)
    CHECK(malloc_usable_size(encoded) < written + 8192);
#endif
    MalValue buffer = mal_node_buffer_from_owned_bytes(vm, encoded, written);
    CHECK(vm->completion.kind != MAL_COMPLETION_THROW && mal_value_is_typed_array_object(buffer));
    MalArrayBufferObject *backing = mal_value_to_typed_array_object(buffer)->buffer;
    CHECK(backing->data == encoded && backing->byte_length == length);
    CHECK(backing->allocation_capacity == length && !backing->sensitive);
    MalRootSpan span;
    mal_gc_root(&span, &buffer, 1);
    mal_gc_collect(vm);
    CHECK(backing->data == encoded && backing->allocation_capacity == length);
    for (usize i = 0; i < length; i++) CHECK((u8) backing->data[i] == 'a');
    mal_gc_unroot(&span);
    mal_gc_collect(vm);
    return true;
}

static bool encoded_storage_trims_to_the_allocator_size_class(MalVm *vm) {
    usize length = 65536;
    c16 *units = malloc(length * sizeof(c16));
    CHECK(units != nullptr);
    for (usize pattern = 0; pattern < 3; pattern++) {
        for (usize i = 0; i < length; i++) {
            units[i] = pattern == 0 ? (i % 64 == 0 ? 0xe9 : 'a')
                : pattern == 1 ? 0x100 : (i % 2 == 0 ? 0xd83d : 0xde00);
        }
        usize expected_length;
        byte *expected = mal_utf8_encode(units, length, &expected_length);
        CHECK(expected != nullptr);
        MalString *string = mal_string_new_copy(&vm->heap, units, length);
        usize written;
        byte *encoded = mal_node_buffer_decode_string(vm,
            mal_value_from_string(string), MAL_VALUE_UNDEFINED, &written);
        CHECK(encoded != nullptr && written == expected_length);
        CHECK(memcmp(encoded, expected, written) == 0);
        byte *exact = malloc(written);
        CHECK(exact != nullptr);
#if defined(__APPLE__)
        CHECK(malloc_size(encoded) <= malloc_size(exact));
#elif defined(__GLIBC__)
        CHECK(malloc_usable_size(encoded) <= malloc_usable_size(exact));
#endif
        free(exact);
        free(expected);
        MalValue buffer = mal_node_buffer_from_owned_bytes(vm, encoded, written);
        CHECK(vm->completion.kind != MAL_COMPLETION_THROW && mal_value_is_typed_array_object(buffer));
        CHECK(mal_value_to_typed_array_object(buffer)->buffer->allocation_capacity == written);
        mal_gc_collect(vm);
    }
    free(units);
    return true;
}

int main(void) {
    // Every value here is rooted explicitly; stale C locals must not retain cells.
    mal_gc_test_precise_stack_roots = true;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    bool passed = compact_decode_preserves_code_units_and_failures(&vm)
        && buffer_accepts_large_decoded_units(&vm)
        && rejects_unrepresentable_outputs_before_materialization(&vm)
        && adopted_utf8_storage_matches_output(&vm)
        && encoded_storage_trims_to_the_allocator_size_class(&vm);
    mal_vm_free(&vm);
    if (!passed) return 1;
    puts("utf8-string-storage PASS");
    return 0;
}
