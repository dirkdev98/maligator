#pragma once

#include "vm.h"

typedef enum MalNodeDeepEqualMode {
    MAL_NODE_DEEP_EQUAL_LOOSE,
    MAL_NODE_DEEP_EQUAL_STRICT,
    MAL_NODE_DEEP_EQUAL_PARTIAL,
} MalNodeDeepEqualMode;

/**
 * Node's isDeepEqual / isDeepStrictEqual / partialDeepStrictEqual comparison (expected is the
 * partial side). Returns false with a pending throw when a getter or proxy trap throws.
 */
bool mal_node_deep_equal(
    MalVm *vm, MalValue actual, MalValue expected, MalNodeDeepEqualMode mode, bool *equal);

typedef bool (*MalNodeDiffEqual)(void *data, usize actual_index, usize expected_index);

/** One Myers edit: 0 keeps both items, 1 inserts actual[actual], -1 deletes expected[expected]. */
typedef struct MalNodeDiffOp {
    i32 op;
    usize actual;
    usize expected;
} MalNodeDiffOp;

/** Node's myersDiff; ops come in its backtracking order (last edit first). Free *ops with free(). */
bool mal_node_myers_diff(
    usize actual_count, usize expected_count, MalNodeDiffEqual equal, void *data,
    MalNodeDiffOp **ops, usize *op_count);
