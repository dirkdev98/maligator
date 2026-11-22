#include "vm.h"

#include <stdlib.h>
#include <string.h>

#include "array_buffer_object.h"
#include "builtin_promise.h"
#include "builtin_data_view.h"
#include "ascii.h"
#include "builtin_object.h"
#include "builtin_eval.h"
#include "builtin_regexp.h"
#include "eval_component.h"
#include "function_object.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "module_namespace_object.h"
#include "microtask.h"
#include "promise_object.h"
#include "typed_array_object.h"
#include "value.h"
#include "vm_ops.h"

// Runtime `eval` / `new Function` (eval Phase 4). Runtime compilation can collect,
// so public helpers explicitly root every transient MalValue. Native entry points
// lift only their own suppression once those roots are installed. The baked
// compiler's `__compile` closure and eval'd functions that outlive a call remain
// owned by vm->compiler_fn (a traced root) and vm->loaded_images.

static i32 eval_compiler_stress_interval(void) {
    const char *configured = getenv("MAL_EVAL_GC_STRESS_INTERVAL");
    if (configured == nullptr || configured[0] == '\0') {
        return 0;
    }
    long interval = strtol(configured, nullptr, 10);
    return interval > 1 && interval <= INT32_MAX ? (i32) interval : 0;
}

// Exact no-flags literals avoid one permanent runtime image per dynamic pattern;
// comments, embedded delimiters, flags, and surrounding syntax fall back.
static bool eval_try_regexp_literal(MalVm *vm, MalValue source, MalValue *result) {
    // The shortcut stands in for compiled code, so it needs both policies to allow it.
    if ((vm->engine_policy & (MAL_ENGINE_POLICY_NO_EVAL | MAL_ENGINE_POLICY_NO_REGEXP)) != 0 ||
        mal_eval_compiler == nullptr) {
        return false;
    }
    MalString *text = mal_value_to_string(source);
    usize length = mal_string_length(text);
    if (length < 3) {
        return false;
    }
    const c16 *units = mal_string_code_units(text);
    if (units[0] != '/' || units[length - 1] != '/' ||
        units[1] == '/' || units[1] == '*') {
        return false;
    }
    bool escaped = false;
    for (usize index = 1; index + 1 < length; index++) {
        c16 unit = units[index];
        if (unit == '\n' || unit == '\r' || unit == 0x2028 || unit == 0x2029 ||
            (unit == '/' && !escaped)) {
            return false;
        }
        escaped = unit == '\\' && !escaped;
        if (unit != '\\') {
            escaped = false;
        }
    }

    MalValue roots[2] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 2);
    roots[0] = mal_value_from_string(
        mal_string_new_slice(&vm->heap, text, 1, length - 2));
    roots[1] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) ""));
    *result = mal_regexp_create(
        vm, mal_value_to_string(roots[0]), mal_value_to_string(roots[1]));
    mal_gc_unroot(&root_span);
    return true;
}

const MalEvalCompiler *mal_eval_compiler;

static bool ensure_compiler(MalVm *vm) {
    if (vm->compiler_installed) {
        return true;
    }
    // Every dynamic-code path (eval, new Function, the async/generator Function
    // families, aliased indirect eval) reaches here, so this is the runtime gate the
    // static compile-time check cannot cover.
    if ((vm->engine_policy & MAL_ENGINE_POLICY_NO_EVAL) != 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_EVAL_ERROR_PROTOTYPE,
                           "eval is disabled in this build (engine.eval is false)");
        return false;
    }
    const MalEvalCompiler *compiler = mal_eval_compiler;
    if (compiler == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_EVAL_ERROR_PROTOTYPE,
                           "eval: this executable does not link the eval compiler");
        return false;
    }
    return compiler->install(vm);
}

// Compile `source` (a JS string value) to a runtime entry via the baked
// compiler. `direct` selects direct-eval mode (free identifiers resolve against
// the caller scope). Returns -1 with a pending throw on a compile or load
// failure.
static i32 compile_source(MalVm *vm, MalValue source, bool direct, bool caller_strict,
                          bool in_param_expr, bool in_field_initializer,
                          MalValue direct_eval_context, bool script, bool *splice_failed) {
    MalValue roots[8] = {source, mal_value_new_boolean(direct),
                          mal_value_new_boolean(caller_strict),
                          mal_value_new_boolean(in_param_expr),
                          mal_value_new_boolean(in_field_initializer),
                          direct_eval_context,
                          mal_value_new_boolean(script),
                          mal_value_new_undefined()};
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 8);
    i32 entry = -1;
    if (splice_failed != nullptr) {
        *splice_failed = false;
    }

    i32 compiler_stress_interval = eval_compiler_stress_interval();
    i32 previous_stress_interval = compiler_stress_interval == 0
        ? 0
        : mal_gc_swap_stress_interval(compiler_stress_interval);
    if (!ensure_compiler(vm)) {
        if (previous_stress_interval != 0) {
            mal_gc_swap_stress_interval(previous_stress_interval);
        }
        goto done;
    }
    MalCompletion compiled =
        mal_vm_call_value(vm, vm->compiler_fn, mal_value_new_undefined(), roots, 7);
    if (previous_stress_interval != 0) {
        mal_gc_swap_stress_interval(previous_stress_interval);
    }
    roots[7] = compiled.value;
    if (compiled.kind == MAL_COMPLETION_THROW) {
        vm->completion = compiled;
        goto done;
    }
    if (!mal_value_is_typed_array_object(roots[7])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_EVAL_ERROR_PROTOTYPE,
                            "eval: compiler did not return a byte buffer");
        goto done;
    }
    MalTypedArrayObject *buffer = mal_value_to_typed_array_object(roots[7]);
    if (buffer->runtime_image_entry >= 0) {
        entry = buffer->runtime_image_entry;
        goto done;
    }
    MalBufferSourceSpan span;
    if (mal_buffer_source_span(roots[7], &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_EVAL_ERROR_PROTOTYPE,
                            "eval: compiler returned a detached byte buffer");
        goto done;
    }
    // The loader copies what it keeps, so a shared buffer only needs a snapshot here.
    byte *owned;
    const u8 *data = (const u8 *) mal_buffer_source_span_private(&span, &owned);
    if (span.length > 0 && data == nullptr) {
        mal_vm_throw_allocation_error(vm);
        goto done;
    }
    bool failed = false;
    bool stateless = false;
    entry = mal_eval_compiler->splice(vm, data, span.length, &failed, &stateless);
    free(owned);
    if (failed && splice_failed != nullptr) {
        *splice_failed = true;
    }
    // Global slots carry per-compilation identity and state, including tagged
    // template registries and eval lexical bindings. Only stateless images can
    // safely reuse the already-relocated entry across separate eval calls.
    if (entry >= 0 && stateless) {
        buffer->runtime_image_entry = entry;
    }

done:
    mal_gc_unroot(&root_span);
    return entry;
}

static MalValue run_compiled_source(
    MalVm *vm, i32 entry, MalValue function_prototype
) {
    MalValue roots[3] = {
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        function_prototype,
    };
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 3);
    MalValue result = mal_value_new_undefined();

    roots[0] = mal_vm_op_create_function(vm, entry, nullptr);
    MalCompletion run = mal_vm_call_value(
        vm, roots[0], mal_value_new_undefined(), nullptr, 0);
    roots[1] = run.value;
    if (run.kind == MAL_COMPLETION_THROW) {
        vm->completion = run;
        goto done;
    }
    if (mal_value_is_object(roots[2]) && mal_value_is_object(roots[1])) {
        mal_object_set_prototype(
            mal_value_to_object(roots[1]), mal_value_to_object(roots[2]));
    }
    result = roots[1];

done:
    mal_gc_unroot(&root_span);
    return result;
}

static MalValue eval_source(MalVm *vm, MalValue source, bool script) {
    MalValue roots[1] = {source};
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 1);
    MalValue result = mal_value_new_undefined();
    if (eval_try_regexp_literal(vm, roots[0], &result)) {
        goto done;
    }

    // Indirect eval: always sloppy (no containing strict context), never a
    // parameter-expression or field-initializer context.
    i32 entry = compile_source(
        vm, roots[0], false, false, false, false, mal_value_new_undefined(), script, nullptr);
    if (entry < 0) {
        goto done;
    }
    result = run_compiled_source(vm, entry, mal_value_new_undefined());

done:
    mal_gc_unroot(&root_span);
    return result;
}

MalValue mal_vm_eval_source(MalVm *vm, MalValue source) {
    return eval_source(vm, source, false);
}

i32 mal_vm_compile_script(MalVm *vm, MalValue source) {
    return compile_source(
        vm, source, false, false, false, false, mal_value_new_undefined(), true, nullptr);
}

MalValue mal_vm_run_script_entry(MalVm *vm, i32 entry) {
    return run_compiled_source(vm, entry, mal_value_new_undefined());
}

#if MAL_REALMS
MalCompletion mal_realm_eval_script(MalVm *vm, MalRealm *realm, MalValue source) {
    // Embedding calls have no native-frame contribution to lift. The $262 native
    // wrapper lifts its own contribution before entering this neutral helper.
    MalRootSpan source_root;
    mal_gc_root(&source_root, &source, 1);

    MalRealm *caller_realm = vm->current_realm;
    mal_vm_realm_switch_to(vm, realm);
    MalValue value = eval_source(vm, source, true);
    MalCompletion completion = vm->completion.kind == MAL_COMPLETION_THROW
        ? vm->completion
        : (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
    mal_vm_realm_switch_to(vm, caller_realm);

    mal_gc_unroot(&source_root);
    vm->completion = completion;
    return completion;
}

MalCompletion mal_shadow_realm_eval_script(MalVm *vm, MalRealm *caller_realm,
                                            MalRealm *target_realm, MalValue source,
                                            MalShadowRealmEvalFailure *failure_out) {
    // ShadowRealm parses in the caller realm, but creates and runs the script's
    // entry closure in the target realm. This may be called without a native
    // frame, so keep every transient heap value visible to the collector.
    MalValue roots[3] = {
        source,
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 3);

    MalCompletion completion = {
        .kind = MAL_COMPLETION_NORMAL,
        .value = mal_value_new_undefined(),
    };
    *failure_out = MAL_SHADOW_REALM_EVAL_FAILURE_NONE;
    mal_vm_realm_switch_to(vm, caller_realm);

    bool splice_failed;
    i32 entry = compile_source(
        vm, source, false, false, false, false, mal_value_new_undefined(), false, &splice_failed);
    if (entry < 0) {
        if (splice_failed) {
            *failure_out = MAL_SHADOW_REALM_EVAL_FAILURE_SANITIZE;
            completion = vm->completion;
            goto done;
        }
        if (vm->compiler_installed) {
            // The baked compiler's errors can belong to the realm in which it was
            // first installed. Parse/early errors must instead be fresh caller errors.
            mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE,
                               "ShadowRealm evaluate: invalid source text");
            *failure_out = MAL_SHADOW_REALM_EVAL_FAILURE_CALLER_PARSE;
        } else {
            *failure_out = MAL_SHADOW_REALM_EVAL_FAILURE_CALLER_POLICY;
        }
        completion = vm->completion;
        goto done;
    }

    mal_vm_realm_switch_to(vm, target_realm);
    roots[1] = mal_vm_op_create_function(vm, entry, nullptr);
    completion = mal_vm_call_value(vm, roots[1], mal_value_new_undefined(), nullptr, 0);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        *failure_out = MAL_SHADOW_REALM_EVAL_FAILURE_SANITIZE;
    }

done:
    roots[2] = completion.value;
    mal_vm_realm_switch_to(vm, caller_realm);
    vm->completion = completion;
    mal_gc_unroot(&root_span);
    return completion;
}
#endif

// The private context is passed as an entry argument, outside dynamic name
// resolution, so actual with proxies cannot observe compiler bookkeeping keys.
MalValue mal_vm_eval_direct(MalVm *vm, MalValue source, MalValue context, MalValue records,
    bool caller_strict, bool in_field_initializer, MalValue caller_this,
    MalValue caller_new_target, MalValue direct_eval_context) {
    MalValue roots[6] = {source, context, records, caller_this, caller_new_target, direct_eval_context};
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    if (eval_try_regexp_literal(vm, roots[0], &result)) goto done;
    i32 entry = compile_source(vm, roots[0], true, caller_strict, false,
        in_field_initializer, roots[5], false, nullptr);
    if (entry >= 0) {
        result = mal_vm_run_entry_with_scope(vm, entry, roots[1], roots[2], roots[3], roots[4]);
    }
done:
    mal_gc_unroot(&root_span);
    return result;
}

// A small ASCII source fragment as a string value (for the Function wrapper).
static MalValue eval_ascii(MalVm *vm, const char *text) {
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, (const byte *) text, strlen(text)));
}

MalValue mal_vm_construct_function(MalVm *vm, const MalValue *args, i32 arg_count,
                                    MalDynamicFunctionKind kind, MalValue new_target,
                                    MalValue constructor) {
    // CreateDynamicFunction: the last argument is the body, the rest are the
    // parameter list (each ToString'd, joined by ","). Assemble the source
    // `(<kind> anonymous(<params>\n) {\n<body>\n})` — the wrapping parens make
    // the function expression the script's completion value, which eval returns.
    // The `kind` selects the leading keyword so `yield`/`await` parse in the
    // right context; the resulting function is created by the normal compiled
    // path, so it inherits the matching %GeneratorFunction/AsyncFunction% wiring.
    MalRootSpan args_span;
    mal_gc_root(&args_span, (MalValue *) args, arg_count);
    MalValue roots[7] = {
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_is_undefined(new_target) ? constructor : new_target,
        mal_value_new_undefined(),
    };
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 7);
    MalValue result = mal_value_new_undefined();
#if MAL_REALMS
    MalRealm *constructor_realm = vm->current_realm;
#endif

    roots[0] = eval_ascii(vm, ""); // params
    roots[1] = eval_ascii(vm, ""); // body
    if (arg_count > 0) {
        for (i32 i = 0; i < arg_count - 1; i++) {
            MalString *part = nullptr;
            if (!mal_vm_to_string(vm, args[i], &part)) {
                goto done; // ToString threw (e.g. a Symbol)
            }
            roots[3] = mal_value_from_string(part);
            if (i > 0) {
                roots[4] = eval_ascii(vm, ",");
                roots[0] = mal_vm_binary_op(vm, MAL_BIN_ADD, roots[0], roots[4]);
                if (vm->completion.kind == MAL_COMPLETION_THROW) {
                    goto done;
                }
            }
            roots[0] = mal_vm_binary_op(vm, MAL_BIN_ADD, roots[0], roots[3]);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                goto done;
            }
        }
        MalString *body_string = nullptr;
        if (!mal_vm_to_string(vm, args[arg_count - 1], &body_string)) {
            goto done;
        }
        roots[1] = mal_value_from_string(body_string);
    }

    const char *prefix;
    switch (kind) {
    case MAL_DYNAMIC_FUNCTION_GENERATOR:
        prefix = "(function* anonymous(";
        break;
    case MAL_DYNAMIC_FUNCTION_ASYNC:
        prefix = "(async function anonymous(";
        break;
    case MAL_DYNAMIC_FUNCTION_ASYNC_GENERATOR:
        prefix = "(async function* anonymous(";
        break;
    default:
        prefix = "(function anonymous(";
        break;
    }

    roots[2] = eval_ascii(vm, prefix); // source
    roots[2] = mal_vm_binary_op(vm, MAL_BIN_ADD, roots[2], roots[0]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        goto done;
    }
    roots[3] = eval_ascii(vm, "\n) {\n");
    roots[2] = mal_vm_binary_op(vm, MAL_BIN_ADD, roots[2], roots[3]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        goto done;
    }
    roots[2] = mal_vm_binary_op(vm, MAL_BIN_ADD, roots[2], roots[1]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        goto done;
    }
    roots[3] = eval_ascii(vm, "\n})");
    roots[2] = mal_vm_binary_op(vm, MAL_BIN_ADD, roots[2], roots[3]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        goto done;
    }

    bool splice_failed;
    i32 entry = compile_source(
        vm, roots[2], false, false, false, false, mal_value_new_undefined(), false, &splice_failed);
    if (entry < 0) {
        if (splice_failed) {
            goto done;
        }
        // Without an installed compiler the gate's EvalError stands. Otherwise the
        // baked compiler may belong to the realm where eval was first used, and
        // CreateDynamicFunction parse/early errors belong to the active constructor.
        if (vm->compiler_installed) {
#if MAL_REALMS
            mal_vm_realm_switch_to(vm, constructor_realm);
#endif
            mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE,
                               "CreateDynamicFunction: invalid source text");
        }
        goto done;
    }

    MalIntrinsic fallback_proto;
    switch (kind) {
    case MAL_DYNAMIC_FUNCTION_GENERATOR:
        fallback_proto = MAL_INTRINSIC_GENERATOR_FUNCTION_PROTOTYPE;
        break;
    case MAL_DYNAMIC_FUNCTION_ASYNC:
        fallback_proto = MAL_INTRINSIC_ASYNC_FUNCTION_PROTOTYPE;
        break;
    case MAL_DYNAMIC_FUNCTION_ASYNC_GENERATOR:
        fallback_proto = MAL_INTRINSIC_ASYNC_GENERATOR_FUNCTION_PROTOTYPE;
        break;
    default:
        fallback_proto = MAL_INTRINSIC_FUNCTION_PROTOTYPE;
        break;
    }
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, roots[5], fallback_proto, &prototype)) {
        goto done;
    }
    roots[6] = mal_value_from_object(prototype);
    result = run_compiled_source(vm, entry, roots[6]);

done:
    mal_gc_unroot(&roots_span);
    mal_gc_unroot(&args_span);
    return result;
}

static MalValue mal_builtin_eval(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
                                 MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue arg = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    // Indirect eval: a non-string argument is returned unchanged (no coercion).
    if (!mal_value_is_string(arg)) {
        return arg;
    }
    MalRootSpan root_span;
    mal_gc_root(&root_span, &arg, 1);
    mal_gc_native_rooted_begin(vm);
    MalValue result = mal_vm_eval_source(vm, arg);
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&root_span);
    return result;
}

// Caller records and private syntax state travel separately from name resolution.
static MalValue mal_builtin_direct_eval(MalVm *vm, MalValue this_value, const MalValue *args,
    i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value; (void) new_target; (void) callee;
    MalValue roots[6] = {
        arg_count > 0 ? args[0] : mal_value_new_undefined(),
        arg_count > 1 ? args[1] : mal_value_new_undefined(),
        arg_count > 2 ? args[2] : mal_value_new_undefined(),
        arg_count > 4 ? args[4] : mal_value_new_undefined(),
        arg_count > 5 ? args[5] : mal_value_new_undefined(),
        arg_count > 7 ? args[7] : mal_value_new_undefined(),
    };
    if (!mal_value_is_string(roots[0])) return roots[0];
    bool caller_strict = arg_count > 3 && mal_value_is_truthy(args[3]);
    bool in_field_initializer = arg_count > 6 && mal_value_is_truthy(args[6]);
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    mal_gc_native_rooted_begin(vm);
    MalValue result = mal_vm_eval_direct(vm, roots[0], roots[1], roots[2], caller_strict,
        in_field_initializer, roots[3], roots[4], roots[5]);
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&span);
    return result;
}

static MalValue mal_dynamic_import_promise(MalVm *vm) {
    MalPromiseObject *promise = mal_promise_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]));
    return mal_value_from_promise_object(promise);
}

static MalValue mal_dynamic_import_fulfill_module(MalVm *vm, MalValue this_value, const MalValue *args,
    i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm; (void) this_value; (void) args; (void) arg_count; (void) new_target;
    return mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
}

static MalValue mal_dynamic_import_evaluate(MalVm *vm, MalValue receiver,
    const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue roots[7] = {mal_native_function_object_get_slot(function, 0),
        mal_native_function_object_get_slot(function, 2), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
        mal_native_function_object_get_slot(function, 1)};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    i32 cells[4];
    for (i32 i = 0; i < 4; i++) cells[i] = mal_value_to_i32(mal_native_function_object_get_slot(function, i + 3));
    mal_gc_native_rooted_begin(vm);
    if (cells[0] < 0) {
        mal_promise_settle_direct(vm, roots[0], vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR],
            false, roots[1]);
    } else {
        roots[2] = mal_module_evaluate(vm, roots[6], cells[0], cells[1], cells[2], cells[3], -1);
        if (vm->completion.kind == MAL_COMPLETION_NORMAL) {
            mal_promise_create_resolving(vm, roots[0], &roots[3], &roots[4]);
            roots[5] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
                &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, ""), mal_dynamic_import_fulfill_module, &roots[1], 1));
            mal_promise_perform_then(vm, roots[2], roots[5], mal_value_new_undefined(), roots[3], roots[4]);
        }
    }
    if (vm->completion.kind != MAL_COMPLETION_NORMAL) {
        roots[1] = vm->completion.value;
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        mal_promise_reject(vm, mal_value_to_promise_object(roots[0]), roots[1]);
    }
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&span);
    return mal_value_new_undefined();
}

/* EvaluateImportCall steps 7-9: options may carry only string-valued, supported
 * attributes; every failure rejects the import's promise. */
static bool mal_dynamic_import_options(MalVm *vm, MalValue options, MalValue *type) {
    if (mal_value_is_undefined(options)) return true;
    if (!mal_value_is_object(options)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The options of import() must be an object");
        return false;
    }
    MalValue roots[5] = {options, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, roots, 5);
    bool valid = false;
    if (!mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "with"),
            &roots[1]))
        goto done;
    if (mal_value_is_undefined(roots[1])) {
        valid = true;
        goto done;
    }
    if (!mal_value_is_object(roots[1])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The 'with' option of import() must be an object");
        goto done;
    }
    roots[2] = mal_builtin_object_enumerable_entries(vm, roots[1]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    u32 count = mal_array_object_length(mal_value_to_array_object(roots[2]));
    bool supported = true;
    for (u32 index = 0; index < count; index++) {
        if (!mal_vm_get_property(vm, roots[2], mal_key_index(index), &roots[3]) ||
            !mal_vm_get_property(vm, roots[3], mal_key_index(0), &roots[4]) ||
            !mal_vm_get_property(vm, roots[3], mal_key_index(1), &roots[3]))
            goto done;
        if (!mal_value_is_string(roots[3])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "Import attribute values must be strings");
            goto done;
        }
        if (mal_string_equals_ascii(mal_value_to_string(roots[4]), "type")) {
            *type = roots[3];
        } else {
            supported = false;
        }
    }
    if (!supported) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE,
            "Unsupported import attribute");
        goto done;
    }
    valid = true;
done:
    mal_gc_unroot(&span);
    return valid;
}

static MalValue mal_builtin_dynamic_import(MalVm *vm, MalValue this_value, const MalValue *args,
    i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    const MalEvalCompiler *compiler = mal_eval_compiler;
    if (arg_count == 1 && mal_value_is_module_namespace_object(this_value)) {
        return compiler == nullptr ? this_value
            : compiler->intern_builtin_namespace(vm, args[0], this_value);
    }
    MalValue roots[3] = {mal_dynamic_import_promise(vm), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalString *specifier_string = nullptr;
    if (!mal_vm_to_string(vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &specifier_string))
        goto reject_completion;
    roots[1] = mal_value_from_string(specifier_string);
    if (!mal_dynamic_import_options(
            vm, arg_count > 1 ? args[1] : mal_value_new_undefined(), &roots[2]))
        goto reject_completion;
    if (arg_count == 2 && compiler != nullptr) {
        compiler->import_builtin(vm, roots[1], roots[2], roots[0]);
        goto done;
    }
    /* After the specifier and options, each target has init, namespace, status, error,
     * record and evaluation-context cells. */
    i32 target = 2;
    for (i32 index = 8; index + 6 < arg_count; index += 7) {
        if (mal_value_is_string(args[index]) &&
            mal_string_equals(specifier_string, mal_value_to_string(args[index]))) {
            target = index + 1;
            break;
        }
    }
    if (target + 5 >= arg_count) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Invalid dynamic import target");
        goto reject_completion;
    }
    MalValue init_fn = args[target];
    roots[1] = args[target + 1];
    if (!mal_value_is_callable(init_fn) && mal_value_is_undefined(roots[1])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Cannot resolve dynamic import in the compiled module graph");
        goto reject_completion;
    }
    i32 cells[4];
    for (i32 index = 0; index < 4; index++)
        cells[index] = mal_value_is_int32(args[target + 2 + index])
            ? mal_value_to_i32(args[target + 2 + index]) : -1;
    MalValue captured[7] = {roots[0], init_fn, roots[1], mal_value_from_i32(cells[0]),
        mal_value_from_i32(cells[1]), mal_value_from_i32(cells[2]), mal_value_from_i32(cells[3])};
    roots[2] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, ""), mal_dynamic_import_evaluate, captured, 7));
    /* Evaluation starts after the current module's DFS and synchronous body have completed. */
    mal_vm_enqueue_reaction_job(vm, roots[2], false, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined());
    goto done;
reject_completion:
    roots[1] = vm->completion.value;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    mal_promise_reject(vm, mal_value_to_promise_object(roots[0]), roots[1]);
done:
    mal_gc_unroot(&span);
    return roots[0];
}

static MalValue mal_builtin_configure_deferred_namespace(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    if (arg_count < 6 ||
        !mal_value_is_module_namespace_object(args[0]) ||
        (!mal_value_is_callable(args[1]) && !mal_value_is_undefined(args[1])) ||
        !mal_value_is_int32(args[2]) ||
        !mal_value_is_int32(args[3]) || !mal_value_is_int32(args[4]) ||
        !mal_value_is_int32(args[5])) {
        mal_vm_throw_error(
            vm,
            MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Invalid deferred module namespace configuration"
        );
        return mal_value_new_undefined();
    }
    mal_module_namespace_configure_deferred(
        mal_value_to_module_namespace_object(args[0]),
        args[1],
        mal_value_to_i32(args[2]),
        mal_value_to_i32(args[3]), mal_value_to_i32(args[4]), mal_value_to_i32(args[5])
    );
    return args[0];
}

static MalValue mal_builtin_evaluate_module_sync(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    if (arg_count == 6) {
        for (i32 index = 1; index < 6; index++) {
            if (!mal_value_is_int32(args[index])) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "Invalid asynchronous module evaluation request");
                return mal_value_new_undefined();
            }
        }
        MalValue init = args[0];
        MalRootSpan span;
        mal_gc_root(&span, &init, 1);
        // Module initialization can run an arbitrarily long allocating body before returning.
        mal_gc_native_rooted_begin(vm);
        MalValue result = mal_module_evaluate(vm, init, mal_value_to_i32(args[1]),
            mal_value_to_i32(args[2]), mal_value_to_i32(args[3]),
            mal_value_to_i32(args[4]), mal_value_to_i32(args[5]));
        mal_gc_native_rooted_end(vm);
        mal_gc_unroot(&span);
        return result;
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "Invalid module evaluation request");
    return mal_value_new_undefined();
}

void mal_intrinsics_init_eval(MalVm *vm, MalObject *global_this) {
    // Defines `eval` on globalThis with { writable, configurable } — the spec
    // attributes for the global eval function (non-enumerable) — and records it
    // in the intrinsic slot the compiler's LOAD_INTRINSIC resolves the bare
    // `eval` identifier to.
    vm->intrinsics[MAL_INTRINSIC_EVAL] =
        mal_intrinsic_define_method_n(vm, global_this, "eval", 1, mal_builtin_eval);

    // The direct-eval intrinsic is internal — the compiler emits it as the callee
    // of a direct `eval(...)` call, never exposed on globalThis. A bare native
    // function value parked in its intrinsic slot.
    vm->intrinsics[MAL_INTRINSIC_DIRECT_EVAL] = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, "eval"), 1, mal_builtin_direct_eval));

    vm->intrinsics[MAL_INTRINSIC_DYNAMIC_IMPORT] = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, "import"), 1, mal_builtin_dynamic_import));
    vm->intrinsics[MAL_INTRINSIC_CONFIGURE_DEFERRED_NAMESPACE] =
        mal_value_from_native_function_object(
            mal_native_function_object_new_arity(
                &vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, ""),
                4,
                mal_builtin_configure_deferred_namespace));
    vm->intrinsics[MAL_INTRINSIC_EVALUATE_MODULE_SYNC] =
        mal_value_from_native_function_object(
            mal_native_function_object_new_arity(
                &vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, ""),
                4,
                mal_builtin_evaluate_module_sync));
}

#include "generated/known_native_builtin_eval_c.inc"
