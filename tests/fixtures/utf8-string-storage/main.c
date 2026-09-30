#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if defined(__APPLE__)
#include <malloc/malloc.h>
#elif defined(__GLIBC__)
#include <malloc.h>
#endif

#include "array_buffer_object.h"
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

static bool buffer_limit_counts_decoded_units(MalVm *vm) {
    MalValue encoding = mal_value_from_string(
        mal_string_new_ascii(&vm->heap, (const byte *) "utf8", 4));
    MalRootSpan encoding_root;
    mal_gc_root(&encoding_root, &encoding, 1);
    const u8 patterns[][3] = {{0xc3, 0xa9, 0}, {0xe2, 0x82, 0xac}, {0xe1, 0x80, 0}};
    const usize widths[] = {2, 3, 2};
    const c16 units[] = {0xe9, 0x20ac, 0xfffd};
    for (usize test = 0; test < countof(widths); test++) {
        usize width = widths[test];
        usize maximum = MAL_STRING_MAX_CODE_UNITS;
        byte *input = malloc((maximum + 1) * width);
        CHECK(input != nullptr);
        for (usize i = 0; i <= maximum; i++) memcpy(input + i * width, patterns[test], width);
        MalValue result = mal_node_buffer_encode_bytes(vm, input, maximum * width, encoding, true);
        CHECK(vm->completion.kind != MAL_COMPLETION_THROW && mal_value_is_string(result));
        MalString *string = mal_value_to_string(result);
        CHECK(string->length == maximum && string->latin1 == (test == 0));
        CHECK(mal_string_code_unit_at(string, 0) == units[test]);
        CHECK(mal_string_code_unit_at(string, maximum - 1) == units[test]);
        mal_gc_collect(vm);
        result = mal_node_buffer_encode_bytes(vm, input, (maximum + 1) * width, encoding, true);
        CHECK(vm->completion.kind == MAL_COMPLETION_THROW && mal_value_is_undefined(result));
        vm->completion = (MalCompletion) {
            .kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()
        };
        free(input);
        mal_gc_collect(vm);
    }

    usize maximum = MAL_STRING_MAX_CODE_UNITS;
    byte *astral = malloc(maximum * 2 + 1);
    CHECK(astral != nullptr);
    const u8 pair[] = {0xf0, 0x9f, 0x98, 0x80};
    for (usize i = 0; i < maximum / 2; i++) memcpy(astral + i * 4, pair, 4);
    astral[maximum * 2] = 'x';
    MalUtf8DecodeStatus status;
    MalString *string = mal_string_from_utf8_report(
        &vm->heap, astral, maximum * 2, nullptr, &status);
    CHECK(string != nullptr && status == MAL_UTF8_DECODE_OK && string->length == maximum);
    CHECK(mal_string_code_unit_at(string, maximum - 2) == 0xd83d);
    CHECK(mal_string_code_unit_at(string, maximum - 1) == 0xde00);
    mal_gc_collect(vm);
    string = mal_string_from_utf8_report(&vm->heap, astral, maximum * 2 + 1, nullptr, &status);
    CHECK(string == nullptr && status == MAL_UTF8_DECODE_LENGTH_OVERFLOW);
    free(astral);
    mal_gc_unroot(&encoding_root);
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
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    bool passed = compact_decode_preserves_code_units_and_failures(&vm)
        && buffer_limit_counts_decoded_units(&vm)
        && adopted_utf8_storage_matches_output(&vm)
        && encoded_storage_trims_to_the_allocator_size_class(&vm);
    mal_vm_free(&vm);
    if (!passed) return 1;
    puts("utf8-string-storage PASS");
    return 0;
}
