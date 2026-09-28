#include <stdio.h>
#include <string.h>

#include "gc.h"
#include "heap.h"
#include "text_buffer.h"
#include "value.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

#define CHECK(condition) \
    do { \
        if (!(condition)) { \
            printf("%s:%d CHECK FAIL: %s\n", __func__, __LINE__, #condition); \
            return false; \
        } \
    } while (0)

static bool compact_output_promotes_and_rolls_back(MalVm *vm) {
    MalTextBuffer buffer = {.heap = &vm->heap};
    const u8 compact[] = {'a', 0, 0x80, 0xff};
    const c16 wide[] = {0x100, 0xd800, 0xdc00, 0xffff};
    CHECK(mal_text_buffer_append_latin1(&buffer, compact, countof(compact)) == MAL_TEXT_BUFFER_OK);
    CHECK(!buffer.utf16 && buffer.length == countof(compact));
    CHECK(memcmp(buffer.data, compact, sizeof(compact)) == 0);
    CHECK(mal_text_buffer_append_units(&buffer, wide, countof(wide)) == MAL_TEXT_BUFFER_OK);
    CHECK(buffer.utf16 && buffer.length == countof(compact) + countof(wide));
    for (usize i = 0; i < countof(compact); i++) {
        CHECK(mal_text_buffer_code_unit_at(&buffer, i) == compact[i]);
    }
    for (usize i = 0; i < countof(wide); i++) {
        CHECK(mal_text_buffer_code_unit_at(&buffer, countof(compact) + i) == wide[i]);
    }
    mal_text_buffer_truncate(&buffer, countof(compact));
    CHECK(mal_text_buffer_append_i32(&buffer, INT32_MIN) == MAL_TEXT_BUFFER_OK);
    const char expected[] = "-2147483648";
    for (usize i = 0; i < sizeof(expected) - 1; i++) {
        CHECK(mal_text_buffer_code_unit_at(&buffer, countof(compact) + i) == expected[i]);
    }
    usize length = buffer.length;
    CHECK(mal_text_buffer_append_buffer(&buffer, &buffer) == MAL_TEXT_BUFFER_OK);
    CHECK(buffer.length == 2 * length);
    for (usize i = 0; i < length; i++) {
        CHECK(mal_text_buffer_code_unit_at(&buffer, i) == mal_text_buffer_code_unit_at(&buffer, length + i));
    }
    mal_text_buffer_dispose(&buffer);

    const c16 narrow_units[] = {'x', 0xe9, 0xff};
    buffer.heap = &vm->heap;
    CHECK(mal_text_buffer_append_units(&buffer, narrow_units, countof(narrow_units)) == MAL_TEXT_BUFFER_OK);
    CHECK(!buffer.utf16);
    CHECK(mal_text_buffer_append_buffer(&buffer, &buffer) == MAL_TEXT_BUFFER_OK);
    CHECK(buffer.length == 2 * countof(narrow_units) && !buffer.utf16);
    MalString *copy = mal_text_buffer_copy(&vm->heap, &buffer);
    CHECK(copy != nullptr && copy->latin1 && copy->length == buffer.length);
    for (usize i = 0; i < buffer.length; i++) {
        CHECK(mal_string_code_unit_at(copy, i) == narrow_units[i % countof(narrow_units)]);
    }
    CHECK(mal_text_buffer_push(&buffer, '!') == MAL_TEXT_BUFFER_OK);
    CHECK(copy->length + 1 == buffer.length);
    mal_text_buffer_dispose(&buffer);
    return true;
}

static bool appends_rope_ranges_without_materialization(MalVm *vm) {
    u8 left_units[128];
    c16 right_units[128];
    for (usize i = 0; i < countof(left_units); i++) {
        left_units[i] = (u8) i;
        right_units[i] = (c16) (0xd800 + i);
    }
    MalString *left = mal_string_new_latin1_copy(&vm->heap, left_units, countof(left_units));
    MalString *right = mal_string_new_copy(&vm->heap, right_units, countof(right_units));
    MalString *rope;
    CHECK(mal_string_new_cons_checked(&vm->heap, left, right, &rope));
    CHECK(rope->storage == MAL_STRING_STORAGE_CONS);

    MalTextBuffer buffer = {.heap = &vm->heap};
    CHECK(mal_text_buffer_append_range(&buffer, rope, 64, 128) == MAL_TEXT_BUFFER_OK);
    CHECK(buffer.utf16 && buffer.length == 128);
    CHECK(rope->storage == MAL_STRING_STORAGE_CONS && left->latin1);
    for (usize i = 0; i < 64; i++) {
        CHECK(mal_text_buffer_code_unit_at(&buffer, i) == left_units[64 + i]);
        CHECK(mal_text_buffer_code_unit_at(&buffer, 64 + i) == right_units[i]);
    }
    mal_text_buffer_dispose(&buffer);
    buffer.heap = &vm->heap;
    CHECK(mal_text_buffer_append_range(&buffer, rope, 0, 128) == MAL_TEXT_BUFFER_OK);
    CHECK(!buffer.utf16 && buffer.length == 128);
    CHECK(rope->storage == MAL_STRING_STORAGE_CONS && left->latin1);
    mal_text_buffer_dispose(&buffer);
    return true;
}

static bool finish_transfers_storage_and_survives_collection(MalVm *vm) {
    for (usize width = 1; width <= 2; width++) {
        MalTextBuffer buffer = {.heap = &vm->heap};
        for (usize i = 0; i < 256; i++) {
            CHECK(mal_text_buffer_push(&buffer, (c16) (i + (width == 1 ? 0 : 0x100))) == MAL_TEXT_BUFFER_OK);
        }
        void *owned = buffer.data;
        MalString *string = mal_text_buffer_finish(&vm->heap, &buffer);
        CHECK(buffer.data == nullptr && buffer.length == 0 && buffer.capacity == 0);
        CHECK(buffer.heap == nullptr && buffer.status == MAL_TEXT_BUFFER_OK);
        CHECK(string != nullptr && string->storage == MAL_STRING_STORAGE_OWNED);
        CHECK(string->latin1 == (width == 1));
        CHECK((string->latin1 ? (const void *) string->latin1_units : (const void *) string->code_units) == owned);
        MalValue root = mal_value_from_string(string);
        MalRootSpan span;
        mal_gc_root(&span, &root, 1);
        mal_gc_collect(vm);
        for (usize i = 0; i < 256; i++) {
            CHECK(mal_string_code_unit_at(string, i) == i + (width == 1 ? 0 : 0x100));
        }
        mal_gc_unroot(&span);
        mal_gc_collect(vm);
    }
    MalTextBuffer empty = {.heap = &vm->heap};
    CHECK(mal_string_length(mal_text_buffer_finish(&vm->heap, &empty)) == 0);
    return true;
}

static bool failures_preserve_owner_and_pressure(MalVm *vm) {
    MalHeap *heap = &vm->heap;
    MalTextBuffer buffer = {.heap = heap};
    usize initial_owned = mal_heap_usage(heap).raw_owned_bytes;
    heap->fail_next_raw_allocation = true;
    CHECK(mal_text_buffer_push(&buffer, 'x') == MAL_TEXT_BUFFER_ALLOCATION_FAILURE);
    CHECK(buffer.data == nullptr && buffer.length == 0);
    CHECK(!heap->fail_next_raw_allocation);
    CHECK(mal_heap_usage(heap).raw_owned_bytes == initial_owned);
    mal_text_buffer_dispose(&buffer);

    for (usize capacity = 16; capacity <= 32768; capacity *= 2048) {
        buffer.heap = heap;
        CHECK(mal_text_buffer_reserve(&buffer, capacity) == MAL_TEXT_BUFFER_OK);
        CHECK(mal_text_buffer_append_ascii(&buffer, "preserved") == MAL_TEXT_BUFFER_OK);
        void *owned = buffer.data;
        usize length = buffer.length;
        usize charged = heap->bytes_allocated;
        usize owned_bytes = mal_heap_usage(heap).raw_owned_bytes;
        heap->fail_next_raw_allocation = true;
        CHECK(mal_text_buffer_reserve(&buffer, buffer.capacity) == MAL_TEXT_BUFFER_ALLOCATION_FAILURE);
        CHECK(buffer.data == owned && buffer.length == length && !buffer.utf16);
        CHECK(heap->bytes_allocated == charged && mal_heap_usage(heap).raw_owned_bytes == owned_bytes);
        CHECK(memcmp(buffer.data, "preserved", length) == 0);
        CHECK(!heap->fail_next_raw_allocation);
        CHECK(mal_text_buffer_push(&buffer, 0x100) == MAL_TEXT_BUFFER_ALLOCATION_FAILURE);
        CHECK(buffer.data == owned && !buffer.utf16);
        mal_text_buffer_truncate(&buffer, 0);
        CHECK(buffer.status == MAL_TEXT_BUFFER_ALLOCATION_FAILURE);
        mal_text_buffer_dispose(&buffer);
        CHECK(mal_heap_usage(heap).raw_owned_bytes == initial_owned);
    }

    buffer.heap = heap;
    CHECK(mal_text_buffer_reserve(&buffer, 32768) == MAL_TEXT_BUFFER_OK);
    CHECK(mal_text_buffer_append_ascii(&buffer, "promote") == MAL_TEXT_BUFFER_OK);
    void *owned = buffer.data;
    heap->fail_next_raw_allocation = true;
    CHECK(mal_text_buffer_push(&buffer, 0xd800) == MAL_TEXT_BUFFER_ALLOCATION_FAILURE);
    CHECK(buffer.data == owned && !buffer.utf16 && buffer.length == 7);
    CHECK(memcmp(buffer.data, "promote", 7) == 0);
    CHECK(mal_text_buffer_finish(heap, &buffer) == nullptr);
    CHECK(buffer.data == nullptr && mal_heap_usage(heap).raw_owned_bytes == initial_owned);

    buffer.heap = heap;
    CHECK(mal_text_buffer_append_units(&buffer, nullptr, MAL_STRING_MAX_CODE_UNITS + 1)
        == MAL_TEXT_BUFFER_LENGTH_OVERFLOW);
    CHECK(buffer.data == nullptr && buffer.length == 0);
    mal_text_buffer_dispose(&buffer);
    return true;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    bool passed = compact_output_promotes_and_rolls_back(&vm)
        && appends_rope_ranges_without_materialization(&vm)
        && finish_transfers_storage_and_survives_collection(&vm)
        && failures_preserve_owner_and_pressure(&vm);
    mal_vm_free(&vm);
    if (!passed) return 1;
    puts("text-buffer PASS");
    return 0;
}
