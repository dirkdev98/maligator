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

/** Preserve the captured call while projecting a result observed only as null. */
MalValue mal_regexp_exec_result_projection(
    MalVm *vm, MalValue callee, MalValue regexp, MalValue string
);

/**
 * Call `callee` as `receiver.test(argument)`. The realm's own RegExp.prototype.test on
 * a canonical receiver and a string argument runs straight against the matcher, with
 * the ordinary lastIndex effects for g and y; anything else takes the ordinary call.
 * Returns the result, or undefined with a pending throw.
 */
MalValue mal_regexp_test_call(MalVm *vm, MalValue callee, MalValue receiver, MalValue argument);

/**
 * A regex literal evaluation whose object only reaches its own `test` call or an `exec`
 * call compared with null. The compiled site holds the VM-lifetime template matcher in
 * place of that object, which cannot be observed. A null `matcher` means the latest
 * evaluation built an ordinary object instead. The other fields keep the pair's
 * template for the activation's later evaluations.
 */
typedef struct MalRegExpLiteralSite {
    void *matcher;
    void *template_matcher;
    MalString *pattern;
    MalString *flags;
    u32 flag_bits;
} MalRegExpLiteralSite;

/**
 * Evaluate `new constructor(pattern, flags)` for a literal site. When the constructor
 * is the realm's %RegExp% and the string pair has a template, bind its matcher and
 * return true. Otherwise clear the site and return false: the caller constructs the
 * object as usual, which also reports an invalid pattern.
 */
bool mal_regexp_literal_bind(
    MalVm *vm, MalRegExpLiteralSite *site, MalValue constructor, MalValue pattern, MalValue flags
);

/**
 * The realm's RegExp.prototype.test on a bound site's object: a boolean, or undefined
 * with a pending throw.
 */
MalValue mal_regexp_literal_test(MalVm *vm, const MalRegExpLiteralSite *site, MalValue subject);

/**
 * The realm's RegExp.prototype.exec on a bound site's object, for a result compared
 * only with null: true for a match, else null, or undefined with a pending throw.
 */
MalValue mal_regexp_literal_exec(MalVm *vm, const MalRegExpLiteralSite *site, MalValue subject);

/**
 * Locked-world form for a fresh unaliased RegExp literal. Its property lookup,
 * callback identity, and Realm are compiler-proven; arbitrary input coercion is
 * still performed here in the same order as the builtin call.
 */
void mal_regexp_exec_capture_projection_locked(
    MalVm *vm,
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
