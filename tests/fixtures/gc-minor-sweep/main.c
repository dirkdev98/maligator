#include "gc.h"
#include "heap.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct TestCell {
    MalHeapHeader header;
    u32 id;
    u64 signature;
    void *owned;
} TestCell;

static MalHeap *g_heap;
static u32 g_next_id;
static u32 g_finalized[256];
static bool g_invalid_finalizer;

#define CHECK(condition) \
    do { \
        if (!(condition)) { \
            printf("%s:%d CHECK FAIL: %s\n", __func__, __LINE__, #condition); \
            return false; \
        } \
    } while (0)

static u64 signature(u32 id) {
    return UINT64_C(0x1020304050607080) ^ id;
}

static TestCell *new_cell(MalHeap *heap, usize size) {
    TestCell *cell = mal_heap_alloc(heap, size, MAL_HEAP_BIGINT);
    cell->id = ++g_next_id;
    cell->signature = signature(cell->id);
    cell->owned = nullptr;
    return cell;
}

static void finalize_cell(MalHeapHeader *header) {
    TestCell *cell = (TestCell *) header;
    if (cell->id >= countof(g_finalized) || cell->signature != signature(cell->id)) {
        g_invalid_finalizer = true;
        return;
    }
    g_finalized[cell->id]++;
    if (cell->owned != nullptr) {
        gc_free_raw(g_heap, cell->owned);
        cell->owned = nullptr;
    }
}

#if MAL_GC_GENERATIONAL
static bool live_cell(const TestCell *cell, u32 id) {
    return cell->header.mark == MAL_MARK_BLACK && cell->id == id
        && cell->signature == signature(id) && g_finalized[id] == 0;
}

static bool contains(TestCell *const *cells, usize count, const TestCell *target) {
    for (usize i = 0; i < count; i++) {
        if (cells[i] == target) return true;
    }
    return false;
}
#endif

static bool major_reclaims_once_and_recycles_blocks(MalHeap *heap) {
    TestCell *live = new_cell(heap, 512);
    TestCell *dead = new_cell(heap, 512);
    u32 live_id = live->id;
    u32 dead_id = dead->id;
    live->header.mark = MAL_MARK_BLACK;
    mal_heap_sweep(heap, finalize_cell);
    CHECK(heap->live_bytes == mal_heap_allocation_charge(512));
    CHECK(g_finalized[dead_id] == 1);

    live->header.mark = MAL_MARK_WHITE;
    mal_heap_sweep(heap, finalize_cell);
    CHECK(heap->live_bytes == 0);
    CHECK(g_finalized[live_id] == 1 && g_finalized[dead_id] == 1);
    CHECK(heap->free_blocks != nullptr);

    void *raw = mal_heap_alloc_raw(heap, 2048);
    memset(raw, 0x71, 2048);
    TestCell *reused = new_cell(heap, 4096);
    u32 reused_id = reused->id;
    reused->header.mark = MAL_MARK_BLACK;
    mal_heap_sweep(heap, finalize_cell);
    CHECK(heap->live_bytes == mal_heap_allocation_charge(4096));
    for (usize i = 0; i < 2048; i++) CHECK(((u8 *) raw)[i] == 0x71);
    gc_free_raw(heap, raw);

    reused->header.mark = MAL_MARK_WHITE;
    mal_heap_sweep(heap, finalize_cell);
    CHECK(heap->live_bytes == 0);
    CHECK(g_finalized[reused_id] == 1);
    CHECK(g_finalized[live_id] == 1 && g_finalized[dead_id] == 1);
    return true;
}

#if MAL_GC_GENERATIONAL
static bool minor_preserves_old_cells_and_free_list_members(MalHeap *heap) {
    TestCell *cells[8];
    for (usize i = 0; i < countof(cells); i++) cells[i] = new_cell(heap, 512);
    cells[0]->header.mark = MAL_MARK_BLACK;
    cells[1]->header.mark = MAL_MARK_BLACK;
    mal_heap_sweep(heap, finalize_cell);
    CHECK(heap->live_bytes == 2 * mal_heap_allocation_charge(512));
    for (u32 id = 3; id <= 8; id++) CHECK(g_finalized[id] == 1);

    TestCell *young_live = new_cell(heap, 512);
    CHECK(contains(cells + 2, 6, young_live));
    young_live->header.mark = MAL_MARK_BLACK;
    TestCell *young_dead = new_cell(heap, 512);
    CHECK(contains(cells + 2, 6, young_dead) && young_dead != young_live);
    young_dead->owned = mal_heap_alloc_raw(heap, 64);
    mal_heap_sweep_minor(heap, finalize_cell);
    CHECK(live_cell(cells[0], 1) && live_cell(cells[1], 2));
    CHECK(live_cell(young_live, 9));
    CHECK(g_finalized[10] == 1);
    CHECK(heap->live_bytes == 3 * mal_heap_allocation_charge(512));

    u32 epoch = heap->epoch;
    mal_heap_sweep_minor(heap, finalize_cell);
    CHECK(heap->epoch == epoch + 1);
    CHECK(heap->live_bytes == 3 * mal_heap_allocation_charge(512));
    for (u32 id = 3; id <= 8; id++) CHECK(g_finalized[id] == 1);
    CHECK(g_finalized[10] == 1);

    // Drain both the pre-existing free entries and the newly finalized entry.
    TestCell *reused[6];
    for (usize i = 0; i < countof(reused); i++) {
        reused[i] = new_cell(heap, 512);
        CHECK(reused[i] != cells[0] && reused[i] != cells[1] && reused[i] != young_live);
        CHECK(!contains(reused, i, reused[i]));
        CHECK(contains(cells + 2, 6, reused[i]) == (i < 5));
        reused[i]->header.mark = MAL_MARK_BLACK;
    }
    mal_heap_sweep_minor(heap, finalize_cell);
    CHECK(heap->live_bytes == 9 * mal_heap_allocation_charge(512));
    for (usize i = 0; i < countof(reused); i++) CHECK(live_cell(reused[i], 11 + (u32) i));
    CHECK(live_cell(cells[0], 1) && live_cell(cells[1], 2) && live_cell(young_live, 9));
    return true;
}

static bool minor_reenrolls_reused_cells_in_untouched_blocks(MalHeap *heap) {
    TestCell *small_live = new_cell(heap, 512);
    TestCell *small_dead = new_cell(heap, 512);
    TestCell *large_live = new_cell(heap, 1024);
    TestCell *large_dead = new_cell(heap, 1024);
    small_live->header.mark = MAL_MARK_BLACK;
    large_live->header.mark = MAL_MARK_BLACK;
    mal_heap_sweep(heap, finalize_cell);
    usize old_bytes = mal_heap_allocation_charge(512) + mal_heap_allocation_charge(1024);
    CHECK(heap->live_bytes == old_bytes);

    TestCell *small_reused = new_cell(heap, 512);
    CHECK(small_reused == small_dead);
    mal_heap_sweep_minor(heap, finalize_cell);
    CHECK(g_finalized[5] == 1 && heap->live_bytes == old_bytes);

    TestCell *large_reused = new_cell(heap, 1024);
    CHECK(large_reused == large_dead);
    mal_heap_sweep_minor(heap, finalize_cell);
    CHECK(g_finalized[6] == 1 && heap->live_bytes == old_bytes);
    TestCell *large_promoted = new_cell(heap, 1024);
    CHECK(large_promoted == large_reused);
    large_promoted->header.mark = MAL_MARK_BLACK;
    mal_heap_sweep_minor(heap, finalize_cell);
    usize promoted_bytes = old_bytes + mal_heap_allocation_charge(1024);
    CHECK(heap->live_bytes == promoted_bytes && live_cell(large_promoted, 7));

    CHECK(new_cell(heap, 512) == small_reused);
    mal_heap_sweep_minor(heap, finalize_cell);
    CHECK(g_finalized[8] == 1 && heap->live_bytes == promoted_bytes);
    CHECK(live_cell(small_live, 1) && live_cell(large_live, 3));
    CHECK(g_finalized[2] == 1 && g_finalized[4] == 1);
    return true;
}

static bool minor_reenrolls_a_reclaimed_cell_away_from_the_bump_block(MalHeap *heap) {
    TestCell *cells[8];
    for (usize i = 0; i < countof(cells); i++) {
        cells[i] = new_cell(heap, 8192);
        if (i != 1) cells[i]->header.mark = MAL_MARK_BLACK;
    }
    mal_heap_sweep(heap, finalize_cell);
    usize old_bytes = 7 * mal_heap_allocation_charge(8192);
    CHECK(heap->live_bytes == old_bytes && g_finalized[2] == 1);

    CHECK(new_cell(heap, 8192) == cells[1]);
    mal_heap_sweep_minor(heap, finalize_cell);
    CHECK(heap->live_bytes == old_bytes && g_finalized[9] == 1);
    TestCell *promoted = new_cell(heap, 8192);
    CHECK(promoted == cells[1]);
    promoted->header.mark = MAL_MARK_BLACK;
    mal_heap_sweep_minor(heap, finalize_cell);
    CHECK(heap->live_bytes == old_bytes + mal_heap_allocation_charge(8192));
    CHECK(live_cell(promoted, 10));
    for (usize i = 0; i < countof(cells); i++) {
        if (i != 1) CHECK(live_cell(cells[i], (u32) i + 1));
    }
    return true;
}

static bool major_resets_minor_tracking_before_block_reassignment(MalHeap *heap) {
    TestCell *old = new_cell(heap, 512);
    old->header.mark = MAL_MARK_BLACK;
    mal_heap_sweep(heap, finalize_cell);
    CHECK(heap->live_bytes == mal_heap_allocation_charge(512));

    new_cell(heap, 2048);
    mal_heap_sweep_minor(heap, finalize_cell);
    CHECK(g_finalized[2] == 1 && heap->live_bytes == mal_heap_allocation_charge(512));
    old->header.mark = MAL_MARK_WHITE;
    new_cell(heap, 4096);
    mal_heap_sweep(heap, finalize_cell);
    CHECK(heap->live_bytes == 0 && g_finalized[1] == 1 && g_finalized[3] == 1);
    CHECK(heap->free_blocks != nullptr);
    mal_heap_sweep_minor(heap, finalize_cell);
    CHECK(heap->live_bytes == 0);

    void *raw = mal_heap_alloc_raw(heap, 2048);
    memset(raw, 0x71, 2048);
    new_cell(heap, 512);
    mal_heap_sweep_minor(heap, finalize_cell);
    CHECK(g_finalized[4] == 1 && heap->live_bytes == 0);
    for (usize i = 0; i < 2048; i++) CHECK(((u8 *) raw)[i] == 0x71);
    mal_heap_sweep(heap, finalize_cell);
    gc_free_raw(heap, raw);

    TestCell *survivor = new_cell(heap, 4096);
    survivor->header.mark = MAL_MARK_BLACK;
    mal_heap_sweep_minor(heap, finalize_cell);
    CHECK(live_cell(survivor, 5) && heap->live_bytes == mal_heap_allocation_charge(4096));
    survivor->header.mark = MAL_MARK_WHITE;
    mal_heap_sweep(heap, finalize_cell);
    CHECK(heap->live_bytes == 0);
    for (u32 id = 1; id <= 5; id++) CHECK(g_finalized[id] == 1);
    return true;
}

#if MAL_GC_CONCURRENT
static bool incremental_major_keeps_allocations_after_a_block_was_swept(MalHeap *heap) {
    TestCell *first = new_cell(heap, 512);
    new_cell(heap, 512);
    TestCell *second = new_cell(heap, 1024);
    new_cell(heap, 1024);
    first->header.mark = MAL_MARK_BLACK;
    second->header.mark = MAL_MARK_BLACK;
    mal_heap_sweep(heap, finalize_cell);

    mal_heap_sweep_begin(heap);
    mal_gc_black_alloc = true;
    CHECK(!mal_heap_sweep_step(heap, finalize_cell, 1));
    TestCell *after_visit = new_cell(heap, 512);
    TestCell *before_visit = new_cell(heap, 1024);
    CHECK(after_visit->header.mark == MAL_MARK_BLACK);
    CHECK(before_visit->header.mark == MAL_MARK_BLACK);

    // Exceed the current chunk so some BLACK allocations sit ahead of its cursor.
    TestCell *new_chunk_cells[200];
    for (usize i = 0; i < countof(new_chunk_cells); i++) {
        new_chunk_cells[i] = new_cell(heap, 8192);
    }
    CHECK(mal_heap_sweep_step(heap, finalize_cell, (usize) -1));
    mal_gc_black_alloc = false;

    // The first block's new BLACK cell was allocated after its major-sweep visit.
    mal_heap_sweep_minor(heap, finalize_cell);
    usize live_bytes = 2 * mal_heap_allocation_charge(512) + 2 * mal_heap_allocation_charge(1024)
        + countof(new_chunk_cells) * mal_heap_allocation_charge(8192);
    CHECK(heap->live_bytes == live_bytes);
    CHECK(live_cell(first, 1) && live_cell(second, 3));
    CHECK(live_cell(after_visit, 5) && live_cell(before_visit, 6));
    for (usize i = 0; i < countof(new_chunk_cells); i++) {
        CHECK(live_cell(new_chunk_cells[i], 7 + (u32) i));
    }
    mal_heap_sweep_minor(heap, finalize_cell);
    CHECK(heap->live_bytes == live_bytes && g_finalized[2] == 1 && g_finalized[4] == 1);
    return true;
}
#endif
#endif

static bool run_check(bool (*check)(MalHeap *)) {
    MalHeap heap;
    mal_heap_init(&heap, 0);
    g_heap = &heap;
    g_next_id = 0;
    memset(g_finalized, 0, sizeof(g_finalized));
    g_invalid_finalizer = false;
    mal_heap_sweep_sticky = true;
    bool ok = check(&heap);
    mal_heap_sweep_sticky = false;
#if MAL_GC_CONCURRENT
    mal_gc_black_alloc = false;
#endif
    mal_heap_free(&heap);
    return ok && !g_invalid_finalizer;
}

int main(void) {
    mal_heap_poison_on_free = getenv("MAL_GC_VERIFY") != nullptr;
    bool (*checks[])(MalHeap *) = {
        major_reclaims_once_and_recycles_blocks,
#if MAL_GC_GENERATIONAL
        minor_preserves_old_cells_and_free_list_members,
        minor_reenrolls_reused_cells_in_untouched_blocks,
        minor_reenrolls_a_reclaimed_cell_away_from_the_bump_block,
        major_resets_minor_tracking_before_block_reassignment,
#if MAL_GC_CONCURRENT
        incremental_major_keeps_allocations_after_a_block_was_swept,
#endif
#endif
    };
    usize passed = 0;
    for (usize i = 0; i < countof(checks); i++) {
        if (run_check(checks[i])) passed++;
    }
    printf("gc-minor-sweep PASS %zu/%zu\n", passed, (usize) countof(checks));
    return passed == countof(checks) ? 0 : 1;
}
