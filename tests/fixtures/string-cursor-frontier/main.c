#include <stdio.h>
#include <stdlib.h>

#include "builtin_iterator.h"
#include "builtin_string.h"
#include "gc.h"
#include "heap_string.h"
#include "perf_stats.h"
#include "vm.h"
#include "vm_ops.h"

extern const MalRuntimeImage mal_runtime_image;

#define CHECK(condition) do { if (!(condition)) { \
    fprintf(stderr, "%s:%d: %s\n", __func__, __LINE__, #condition); return false; \
} } while (0)

static MalString *rope(MalVm *vm, const c16 *units, usize length) {
    if (length <= 31) return mal_string_new_copy(&vm->heap, units, length);
    usize split = ((length + 30) / 31 / 2) * 31;
    MalString *left = rope(vm, units, split);
    MalString *right = rope(vm, units + split, length - split);
    MalString *result;
    if (!mal_string_new_cons_checked(&vm->heap, left, right, &result)) abort();
    return result;
}

static bool string_iteration(MalVm *vm, usize leaves, bool materialize) {
    usize length = 31 * leaves;
    c16 *units = malloc(sizeof(*units) * length);
    for (usize i = 0; i < length; i++) units[i] = (c16) ('a' + i % 23);
    // Includes a pair spanning leaves and a lead whose lookahead must remain unconsumed.
    units[92] = 0xd83d;
    units[93] = 0xde00;
    units[123] = 0xd800;
    units[200] = 0x100;
    units[201] = 0xff;
    MalValue roots[2] = {mal_value_from_string(rope(vm, units, length)), MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, 2);
    roots[1] = mal_vm_new_builtin_iterator(vm, MAL_ITERATOR_STRING_VALUES, roots[0]);
    MalIteratorObject *iterator = mal_value_to_iterator_object(roots[1]);
    mal_gc_collect(vm);
    u64 before = mal_perf_stats.string_iterator_nodes;
    usize position = 0;
    usize hits = 0;
    while (position < length) {
        MalValue value;
        bool done;
        MalStringCursor *cursor = iterator->string_cursor;
        usize local = cursor == nullptr ? 0 : cursor->local;
        usize cursor_position = cursor == nullptr ? 0 : cursor->position;
        u64 allocated = mal_gc_allocated_bytes(vm);
        if (mal_vm_iterator_try_string_cursor_step(vm, iterator, &value, &done)) {
            CHECK(mal_gc_allocated_bytes(vm) == allocated);
            hits++;
        } else {
            CHECK(iterator->index == position && iterator->string_cursor == cursor);
            CHECK(cursor == nullptr || (cursor->local == local && cursor->position == cursor_position));
            CHECK(mal_vm_iterator_step_protocol_cursor(vm, iterator, &value, &done));
        }
        CHECK(!done && mal_value_is_string(value));
        usize count = position == 92 ? 2 : 1;
        MalString *actual = mal_value_to_string(value);
        CHECK(actual->length == count);
        for (usize i = 0; i < count; i++) CHECK(mal_string_code_unit_at(actual, i) == units[position + i]);
        position += count;
        if (position == 1) {
            CHECK(mal_heap_mark_is_old(iterator->object.header.mark));
            CHECK(iterator->string_cursor != nullptr);
            vm->heap.next_gc_at = 1;
            mal_gc_poll = true;
            mal_gc_safepoint(vm);
            CHECK(mal_heap_mark_is_old(iterator->string_cursor->header.mark));
        }
        if (materialize && position == 1) {
            CHECK(iterator->string_cursor != nullptr);
            MalStringIterator *frontier = iterator->string_cursor->iterator;
            CHECK(frontier->count < 60 && frontier->current.string->latin1);
            mal_string_code_units((MalString *) frontier->current.string);
            mal_string_code_units(mal_value_to_string(roots[0]));
            mal_gc_collect(vm);
        }
        if (materialize && position % 257 == 0) mal_gc_collect(vm);
    }
    MalValue value;
    bool done;
    CHECK(mal_vm_iterator_step_protocol_cursor(vm, iterator, &value, &done) && done);
    CHECK(iterator->string_cursor == nullptr);
    CHECK(hits > 0);
    u64 visited = mal_perf_stats.string_iterator_nodes - before;
    CHECK(visited > 0 && visited <= (materialize ? 4 : 2) * leaves + 64);
    printf("iteration leaves=%zu materialize=%d nodes=%llu\n", leaves, materialize,
        (unsigned long long) visited);
    mal_gc_unroot(&span);
    free(units);
    return true;
}

static bool projected_split(MalVm *vm, usize fields, bool materialize) {
    usize length = fields * 33;
    c16 *units = malloc(sizeof(*units) * length);
    for (usize i = 0; i < length; i++) units[i] = i % 33 < 31 ? 'x' : ':';
    units[30] = 0xd800;
    MalValue roots[4] = {mal_value_from_string(rope(vm, units, length)),
        MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED,
        mal_value_from_string(mal_string_new_ascii(&vm->heap, "::", 2))};
    MalRootSpan span;
    mal_gc_root(&span, roots, 4);
    MalStringSplitCursor state;
    CHECK(mal_builtin_string_split_cursor_init_locked(vm, roots[0], roots[3],
        &roots[1], &roots[2], &state));
    u64 before = mal_perf_stats.string_iterator_nodes;
    for (usize i = 0; i <= fields; i++) {
        usize start, end;
        CHECK(mal_builtin_string_split_cursor_next(roots[1], roots[2], &state, &start, &end));
        CHECK(start == i * 33 && end == (i == fields ? length : start + 31));
        if (materialize && i == 0) {
            MalStringCursor *cursor = (MalStringCursor *) mal_value_to_heap(roots[2]);
            CHECK(cursor->iterator->count < 60 && cursor->iterator->current.string->latin1);
            mal_string_code_units((MalString *) cursor->iterator->current.string);
            mal_string_code_units(mal_value_to_string(roots[0]));
            mal_gc_collect(vm);
        }
        if (materialize && i % 127 == 0) mal_gc_collect(vm);
    }
    usize start, end;
    CHECK(!mal_builtin_string_split_cursor_next(roots[1], roots[2], &state, &start, &end));
    MalStringCursor *cursor = (MalStringCursor *) mal_value_to_heap(roots[2]);
    CHECK(cursor->iterator == nullptr && cursor->scratch == nullptr);
    usize leaves = (length + 30) / 31;
    u64 visited = mal_perf_stats.string_iterator_nodes - before;
    CHECK(visited > 0 && visited <= (materialize ? 4 : 2) * leaves + 64);
    printf("split fields=%zu materialize=%d nodes=%llu\n", fields, materialize,
        (unsigned long long) visited);
    // An abandoned projection owns its buffers until its root leaves scope.
    CHECK(mal_builtin_string_split_cursor_init_locked(vm, roots[0], roots[3],
        &roots[1], &roots[2], &state));
    CHECK(mal_builtin_string_split_cursor_next(roots[1], roots[2], &state, &start, &end));
    roots[2] = MAL_VALUE_UNDEFINED;
    mal_gc_collect(vm);
    mal_gc_unroot(&span);
    free(units);
    return true;
}

static bool split_patterns(MalVm *vm) {
    MalValue roots[4] = {mal_value_from_string(mal_string_new_ascii(&vm->heap, "", 0)),
        MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, 4);
    c16 units[4096];
    for (usize i = 0; i < countof(units); i++) units[i] = 'a';
    roots[3] = mal_value_from_string(rope(vm, units, countof(units)));
    MalStringSplitCursor state;
    u64 nodes = mal_perf_stats.string_iterator_nodes;
    u64 comparisons = mal_perf_stats.string_search_linear_comparisons;
    u64 allocated = mal_gc_allocated_bytes(vm);
    CHECK(mal_builtin_string_split_cursor_init_locked(vm, roots[0], roots[3],
        &roots[1], &roots[2], &state));
    CHECK(mal_value_is_string(roots[2]) && mal_gc_allocated_bytes(vm) == allocated);
    usize start, end;
    CHECK(mal_builtin_string_split_cursor_next(roots[1], roots[2], &state, &start, &end));
    CHECK(start == 0 && end == 0);
    CHECK(mal_perf_stats.string_iterator_nodes == nodes);
    CHECK(mal_perf_stats.string_search_linear_comparisons == comparisons);
    roots[0] = mal_value_from_string(rope(vm, units, 40));
    CHECK(mal_value_to_string(roots[0])->storage == MAL_STRING_STORAGE_CONS);
    nodes = mal_perf_stats.string_iterator_nodes;
    comparisons = mal_perf_stats.string_search_linear_comparisons;
    allocated = mal_gc_allocated_bytes(vm);
    CHECK(mal_builtin_string_split_cursor_init_locked(vm, roots[0], roots[3],
        &roots[1], &roots[2], &state));
    CHECK(mal_value_is_string(roots[2]) && mal_gc_allocated_bytes(vm) == allocated);
    CHECK(mal_builtin_string_split_cursor_next(roots[1], roots[2], &state, &start, &end));
    CHECK(start == 0 && end == 40);
    CHECK(mal_perf_stats.string_iterator_nodes == nodes);
    CHECK(mal_perf_stats.string_search_linear_comparisons == comparisons);
    const c16 pattern[] = {'a', 'b', 'a', 'b', 'a', 'c'};
    for (usize i = 0; i < 28; i++) units[i] = i % 2 == 0 ? 'a' : 'b';
    for (usize i = 28; i < 40; i++) units[i] = pattern[(i - 28) % 6];
    roots[0] = mal_value_from_string(rope(vm, units, 40));
    roots[3] = mal_value_from_string(mal_string_new_copy(&vm->heap, pattern, countof(pattern)));
    CHECK(mal_builtin_string_split_cursor_init_locked(vm, roots[0], roots[3],
        &roots[1], &roots[2], &state));
    const usize expected[][2] = {{0, 28}, {34, 34}, {40, 40}};
    for (usize i = 0; i < countof(expected); i++) {
        CHECK(mal_builtin_string_split_cursor_next(roots[1], roots[2], &state, &start, &end));
        CHECK(start == expected[i][0] && end == expected[i][1]);
    }
    CHECK(!mal_builtin_string_split_cursor_next(roots[1], roots[2], &state, &start, &end));
    mal_gc_unroot(&span);
    return true;
}

static bool flat_split_without_frontier(MalVm *vm, bool dependent) {
    c16 units[256];
    for (usize i = 0; i < countof(units); i++) units[i] = i % 4 < 2 ? 'a' : '|';
    MalString *subject = mal_string_new_copy(&vm->heap, units, dependent ? 256 : 128);
    if (dependent) subject = mal_string_new_slice(&vm->heap, subject, 16, 128);
    CHECK(!dependent || subject->storage == MAL_STRING_STORAGE_DEPENDENT);
    MalValue roots[4] = {mal_value_from_string(subject), MAL_VALUE_UNDEFINED,
        MAL_VALUE_UNDEFINED, mal_value_from_string(mal_string_new_ascii(&vm->heap, "||", 2))};
    MalRootSpan span;
    mal_gc_root(&span, roots, 4);
    MalStringSplitCursor state;
    u64 allocated = mal_gc_allocated_bytes(vm);
    CHECK(mal_builtin_string_split_cursor_init_locked(vm, roots[0], roots[3],
        &roots[1], &roots[2], &state));
    CHECK(mal_value_is_string(roots[2]) && mal_gc_allocated_bytes(vm) == allocated);
    for (usize i = 0; i <= 32; i++) {
        usize start, end;
        CHECK(mal_builtin_string_split_cursor_next(roots[1], roots[2], &state, &start, &end));
        CHECK(start == i * 4 && end == (i == 32 ? 128 : start + 2));
        if (i == 0) {
            CHECK(mal_gc_allocated_bytes(vm) == allocated);
            mal_string_code_units(subject);
            mal_gc_collect(vm);
        }
    }
    usize start, end;
    CHECK(!mal_builtin_string_split_cursor_next(roots[1], roots[2], &state, &start, &end));
    mal_gc_unroot(&span);
    return true;
}

static bool projected_trim_spans(MalVm *vm, bool wide, bool flat, bool dependent) {
    const c16 whitespace[] = {' ', '\t', '\n', 0xa0, 0xfeff, 0x1680, 0x2000, 0x2028, 0x3000};
    const usize leading[] = {40, 64, 0, 1};
    const usize trailing[] = {20, 0, 0, 1};
    c16 units[260];
    for (usize field = 0; field < countof(leading); field++) {
        for (usize i = 0; i < 64; i++) {
            bool space = i < leading[field] || i >= 64 - trailing[field];
            units[field * 65 + i] = space
                ? whitespace[i % (wide ? countof(whitespace) : 4)]
                : (wide ? (i % 2 == 0 ? 0x200b : 0xd800) : (c16) ('a' + i % 23));
        }
        units[field * 65 + 64] = '|';
    }
    MalString *source = flat || dependent
        ? mal_string_new_copy(&vm->heap, units, countof(units))
        : rope(vm, units, countof(units));
    // A bounded view checks offsets into a flat parent without retaining a rope view.
    usize offset = dependent ? 65 : 0;
    usize length = dependent ? 130 : countof(units);
    if (dependent) source = mal_string_new_slice(&vm->heap, source, offset, length);
    CHECK(source->storage == (dependent ? MAL_STRING_STORAGE_DEPENDENT
        : flat ? MAL_STRING_STORAGE_OWNED : MAL_STRING_STORAGE_CONS));
    CHECK(source->latin1 == !wide);
    u8 storage = source->storage;
    MalValue roots[5] = {mal_value_from_string(source), MAL_VALUE_UNDEFINED,
        MAL_VALUE_UNDEFINED, mal_value_from_string(mal_string_new_ascii(&vm->heap, "|", 1)),
        MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalStringSplitCursor state;
    CHECK(mal_builtin_string_split_cursor_init_locked(vm, roots[0], roots[3],
        &roots[1], &roots[2], &state));
    usize fields = length / 65;
    for (usize field = 0; field <= fields; field++) {
        usize start, end;
        CHECK(mal_builtin_string_split_cursor_next(roots[1], roots[2], &state, &start, &end));
        CHECK(start == field * 65 && end == (field == fields ? length : start + 64));
        CHECK(mal_builtin_string_trim_span_direct_locked(vm, roots[1], start, end, &roots[4]));
        if (flat || dependent) CHECK(source->storage == storage && source->latin1 == !wide);
        if (dependent) CHECK(source->parent->latin1 == !wide);
        usize original = offset / 65 + field;
        usize expected_length = field == fields ? 0 : 64 - leading[original] - trailing[original];
        MalString *actual = mal_value_to_string(roots[4]);
        CHECK(actual->length == expected_length);
        for (usize i = 0; i < expected_length; i++) {
            CHECK(mal_string_code_unit_at(actual, i) == units[offset + start + leading[original] + i]);
        }
        mal_gc_collect(vm);
    }
    usize start, end;
    CHECK(!mal_builtin_string_split_cursor_next(roots[1], roots[2], &state, &start, &end));
    mal_gc_unroot(&span);
    return true;
}

static bool split_scratch_collection(MalVm *vm) {
    c16 units[16384];
    for (usize i = 0; i < countof(units); i++) units[i] = 'a';
    MalValue roots[4] = {mal_value_from_string(rope(vm, units, countof(units))),
        MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED,
        mal_value_from_string(mal_string_new_copy(&vm->heap, units, countof(units) / 2))};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    mal_gc_collect(vm);
    usize owned = mal_heap_usage(&vm->heap).raw_owned_bytes;
    for (usize i = 0; i < 16; i++) {
        u64 allocated = mal_gc_allocated_bytes(vm);
        vm->heap.next_gc_at = allocated + 4096;
        MalStringSplitCursor state;
        CHECK(mal_builtin_string_split_cursor_init_locked(vm, roots[0], roots[3],
            &roots[1], &roots[2], &state));
        CHECK(mal_gc_allocated_bytes(vm) > vm->heap.next_gc_at && mal_gc_poll);
        CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes > owned + 4096);
        usize start, end;
        CHECK(mal_builtin_string_split_cursor_next(roots[1], roots[2], &state, &start, &end));
        CHECK(start == 0 && end == 0 && !state.done);
        // Early exit drops an unfinished cursor. Its scratch must request collection.
        roots[2] = MAL_VALUE_UNDEFINED;
        mal_gc_safepoint(vm);
        mal_gc_finish_pending_cycle(vm);
        CHECK(vm->heap.next_gc_at > mal_gc_allocated_bytes(vm));
        CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes == owned);
    }
    mal_gc_unroot(&span);
    return true;
}

static bool cursor_spilled_frontier(MalVm *vm) {
    MalValue roots[2] = {mal_value_from_string(mal_string_new_ascii(&vm->heap,
        "abcdefghijklmnopqrstuvwxyz01234", 31)), MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    // Shared halves give an 18-level frontier without allocating every logical leaf.
    for (usize depth = 0; depth < 18; depth++) {
        MalString *child = mal_value_to_string(roots[0]);
        MalString *parent;
        CHECK(mal_string_new_cons_checked(&vm->heap, child, child, &parent));
        roots[0] = mal_value_from_string(parent);
    }
    mal_gc_collect(vm);
    usize owned = mal_heap_usage(&vm->heap).raw_owned_bytes;
    MalStringCursor *cursor = mal_string_cursor_new(&vm->heap, mal_value_to_string(roots[0]));
    roots[1] = mal_value_from_heap(&cursor->header);
    MalStringSegment segment;
    CHECK(mal_string_cursor_segment(cursor, &segment));
    CHECK(cursor->iterator->stack != cursor->iterator->inline_stack);
    CHECK(cursor->iterator->count > countof(cursor->iterator->inline_stack));
    CHECK(segment.length == 31 && mal_string_segment_code_unit_at(&segment, 0) == 'a');
    mal_string_cursor_consume(cursor, segment.length);
    mal_gc_collect(vm);
    CHECK(mal_string_cursor_segment(cursor, &segment));
    CHECK(segment.length == 31 && mal_string_segment_code_unit_at(&segment, 30) == '4');
    mal_string_cursor_dispose(cursor);
    CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes == owned);
    mal_string_cursor_dispose(cursor);
    CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes == owned);
    mal_gc_unroot(&span);
    return true;
}

int main(void) {
    mal_perf_stats_init();
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    bool passed = string_iteration(&vm, 512, false) && string_iteration(&vm, 2048, false)
        && string_iteration(&vm, 256, true) && projected_split(&vm, 512, false)
        && projected_split(&vm, 2048, false) && projected_split(&vm, 256, true)
        && split_patterns(&vm) && flat_split_without_frontier(&vm, false)
        && flat_split_without_frontier(&vm, true) && split_scratch_collection(&vm)
        && cursor_spilled_frontier(&vm)
        && projected_trim_spans(&vm, false, false, false)
        && projected_trim_spans(&vm, true, false, false)
        && projected_trim_spans(&vm, false, true, false)
        && projected_trim_spans(&vm, true, true, false)
        && projected_trim_spans(&vm, false, false, true)
        && projected_trim_spans(&vm, true, false, true);
    mal_vm_free(&vm);
    if (!passed) return 1;
    puts("string-cursor-frontier PASS");
    return 0;
}
