#pragma once

#include "./defaults.h"
#include "value.h"

typedef struct MalVm MalVm;
typedef struct MalString MalString;

/**
 * Install the RegExp constructor, RegExp.prototype (exec/test, the Symbol.*
 * protocol, the flag accessors, toString), and %RegExpStringIteratorPrototype%
 * on the VM intrinsics + globalThis.
 */
void mal_builtin_regexp_install(MalVm *vm);

/**
 * RegExpCreate(pattern, flags): allocate a RegExp with %RegExp.prototype% and
 * RegExpInitialize it. Returns the boxed RegExp, or sets a throw completion and
 * returns undefined on an invalid pattern/flags. Exposed for the compiler's
 * regex-literal lowering (mal_vm_op_create_regex) and String.prototype.
 */
MalValue mal_regexp_create(MalVm *vm, MalString *pattern, MalString *flags);

/**
 * Invoke an unmodified built-in RegExp String-protocol method without generic
 * property/call dispatch. Returns false when any observable customization means
 * the caller must use the ordinary protocol path.
 */
bool mal_regexp_try_exact_string_dispatch(
    MalVm *vm, MalValue regexp, i32 symbol_slot, MalValue string,
    const MalValue *extra, i32 extra_count, MalValue *out
);

/**
 * Handle String.prototype.matchAll's validation and exact dispatch for a
 * canonical RegExp. Returns false when observable customization requires the
 * ordinary IsRegExp / flags / protocol path.
 */
bool mal_regexp_try_canonical_match_all(
    MalVm *vm, MalValue regexp, MalValue string, MalValue *out
);

/**
 * Execute a canonical, non-global/non-sticky RegExp for a closed search
 * consumer. Returns false without side effects when observable customization
 * requires the full String/RegExp protocol path.
 */
bool mal_regexp_try_search_index_direct(
    MalVm *vm, MalValue regexp, MalValue string, MalValue *out
);

/**
 * Execute an exact built-in RegExp.prototype.exec call whose result is proven
 * closed over selected constant capture-index reads. A guarded hit returns null
 * or true when projection is possible. If an index is not an own match-result
 * property, it returns the fully materialized result Array from the same matcher
 * execution so inherited indexed properties remain observable.
 */
bool mal_regexp_exec_capture_projection(
    MalVm *vm,
    MalValue callee,
    MalValue regexp,
    MalValue string,
    const u32 *capture_indices,
    MalValue **capture_outputs,
    u32 capture_count,
    u8 capture_span_mask,
    i32 *capture_starts,
    i32 *capture_ends,
    MalValue *subject_output,
    MalValue *result_out
);

/** Materialize one participating capture span for a guarded scalar consumer. */
MalValue mal_regexp_materialize_capture_span(
    MalVm *vm, MalValue string, i32 start, i32 end
);

/**
 * Advance an exact RegExp String Iterator without materializing its disposable
 * IteratorResult wrapper. Returns 1 on success, 0 when generic stepping is
 * required, and -1 when the exact step threw.
 */
int mal_regexp_try_exact_iterator_step(
    MalVm *vm, MalValue iterator, MalValue next_method,
    MalValue *value_out, bool *done_out
);

/** Exact RegExp String Iterator step with selected capture spans. */
int mal_regexp_try_exact_iterator_capture_projection(
    MalVm *vm, MalValue iterator, MalValue next_method,
    const u32 *capture_indices, MalValue **capture_outputs, u32 capture_count,
    i32 *capture_starts, i32 *capture_ends, MalValue *subject_output,
    MalValue *value_out, bool *done_out
);
