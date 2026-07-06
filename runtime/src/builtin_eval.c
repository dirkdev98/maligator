#include "vm.h"

#include <stdlib.h>
#include <string.h>

#include "array_buffer_object.h"
#include "builtin_promise.h"
#include "builtin_eval.h"
#include "compiler_wire.h"
#include "function_object.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "promise_object.h"
#include "typed_array_object.h"
#include "value.h"
#include "vm_load.h"
#include "vm_ops.h"

// Runtime `eval` / `new Function` (eval Phase 4). A native builtin, so the
// collector is suppressed for its whole duration (gc_native_frames >= 1; see the
// gate in mal_gc_safepoint): the transient values it holds in C locals across
// the nested compile + run — the source string, the returned wire buffer, the
// entry closure — cannot be swept, so no explicit rooting is needed. The baked
// compiler's `__compile` closure and the eval'd functions, which must outlive
// this call, are kept by vm->compiler_fn (a traced root) and vm->loaded_defs.

// Retain a runtime-spliced definition so its arena outlives the spliced
// functions, which reference their instruction data in-place within it.
static void retain_loaded(MalVm *vm, MalLoadedDefinition *loaded) {
    if (vm->loaded_def_count == vm->loaded_def_capacity) {
        vm->loaded_def_capacity = vm->loaded_def_capacity == 0 ? 4 : vm->loaded_def_capacity * 2;
        vm->loaded_defs =
            realloc(vm->loaded_defs, sizeof(MalLoadedDefinition *) * (usize) vm->loaded_def_capacity);
    }
    vm->loaded_defs[vm->loaded_def_count++] = loaded;
}

// Install the baked compiler on first use: splice it, run its top level (which
// assigns globalThis.__compile), capture that into the rooted vm->compiler_fn,
// then delete the global so eval leaves nothing on globalThis. Returns false
// with a pending throw on failure.
static bool ensure_compiler(MalVm *vm) {
#if !MAL_EVAL
    // eval-disabled build (`engine.eval: false`): the baked compiler is not
    // embedded. Every dynamic-code path (eval, new Function, the async/generator
    // Function families, aliased indirect eval) reaches here, so this single
    // throw is the runtime gate the static compile-time check cannot cover.
    mal_vm_throw_error(vm, MAL_INTRINSIC_EVAL_ERROR_PROTOTYPE,
                       "eval is disabled in this build (engine.eval is false)");
    return false;
#else
    if (vm->compiler_installed) {
        return true;
    }
    usize len = 0;
    const u8 *bytes = mal_compiler_wire_bytes(&len);
    const char *err = "ok";
    MalLoadedDefinition *loaded = mal_vm_load_definition(bytes, len, &err);
    if (loaded == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_EVAL_ERROR_PROTOTYPE, "eval: baked compiler failed to load");
        return false;
    }
    retain_loaded(vm, loaded);
    i32 entry = mal_vm_splice_definition(vm, mal_loaded_definition_get(loaded));
    if (entry < 0) {
        return false; // splice set a pending RangeError (constant-table overflow)
    }
    MalValue closure = mal_vm_op_create_function(vm, entry, nullptr);
    MalCompletion run = mal_vm_call_value(vm, closure, mal_value_new_undefined(), nullptr, 0);
    if (run.kind == MAL_COMPLETION_THROW) {
        vm->completion = run;
        return false;
    }

    MalValue global = vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS];
    MalKey key = mal_intrinsic_string_key(vm, "__compile");
    MalValue fn = mal_value_new_undefined();
    if (!mal_vm_get_property(vm, global, key, &fn)) {
        return false;
    }
    vm->compiler_fn = fn;
    mal_vm_delete_property(vm, global, key);
    vm->compiler_installed = true;
    return true;
#endif
}

// Compile `source` (a JS string value) to a loaded definition via the baked
// compiler. `direct` selects direct-eval mode (free identifiers resolve against
// the caller scope). Returns nullptr with a pending throw on a compile or load
// failure.
static MalLoadedDefinition *compile_source(MalVm *vm, MalValue source, bool direct, bool caller_strict,
                                           bool in_param_expr, bool in_field_initializer) {
    if (!ensure_compiler(vm)) {
        return nullptr;
    }
    MalValue compile_args[5] = {source, mal_value_new_boolean(direct),
                                mal_value_new_boolean(caller_strict),
                                mal_value_new_boolean(in_param_expr),
                                mal_value_new_boolean(in_field_initializer)};
    MalCompletion compiled =
        mal_vm_call_value(vm, vm->compiler_fn, mal_value_new_undefined(), compile_args, 5);
    if (compiled.kind == MAL_COMPLETION_THROW) {
        vm->completion = compiled;
        return nullptr;
    }
    if (!mal_value_is_typed_array_object(compiled.value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_EVAL_ERROR_PROTOTYPE,
                           "eval: compiler did not return a byte buffer");
        return nullptr;
    }
    MalTypedArrayObject *buffer = mal_value_to_typed_array_object(compiled.value);
    usize len = mal_typed_array_object_byte_length(buffer);
    const u8 *data = buffer->buffer->data + buffer->byte_offset;
    const char *err = "ok";
    // A parse error surfaces as a compiler throw above; a load failure here means
    // the wire buffer itself is malformed, which is an internal error.
    MalLoadedDefinition *loaded = mal_vm_load_definition(data, len, &err);
    if (loaded == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, err);
        return nullptr;
    }
    return loaded;
}

MalValue mal_vm_eval_source(MalVm *vm, MalValue source) {
    // Indirect eval: always sloppy (no containing strict context), never a
    // parameter-expression or field-initializer context.
    MalLoadedDefinition *loaded = compile_source(vm, source, false, false, false, false);
    if (loaded == nullptr) {
        return mal_value_new_undefined();
    }
    retain_loaded(vm, loaded);
    i32 entry = mal_vm_splice_definition(vm, mal_loaded_definition_get(loaded));
    if (entry < 0) {
        return mal_value_new_undefined(); // splice set a pending RangeError
    }
    MalValue closure = mal_vm_op_create_function(vm, entry, nullptr);
    MalCompletion run = mal_vm_call_value(vm, closure, mal_value_new_undefined(), nullptr, 0);
    if (run.kind == MAL_COMPLETION_THROW) {
        vm->completion = run;
        return mal_value_new_undefined();
    }
    return run.value;
}

// Direct eval: compile in direct mode, then run the entry with `scope_object`
// injected into its with-stack so the eval'd code's free identifiers (compiled
// as with-dynamic reads) resolve against the caller's marshaled scope before the
// global. Run via push + run_until_frame_count (not call_value) so the injection
// lands between pushing the frame and executing its body.
MalValue mal_vm_eval_direct(MalVm *vm, MalValue source, MalValue scope_object, bool caller_strict,
                            bool in_param_expr, bool in_field_initializer, MalValue caller_this,
                            MalValue caller_new_target) {
    MalLoadedDefinition *loaded = compile_source(vm, source, true, caller_strict, in_param_expr, in_field_initializer);
    if (loaded == nullptr) {
        return mal_value_new_undefined();
    }
    retain_loaded(vm, loaded);
    i32 entry = mal_vm_splice_definition(vm, mal_loaded_definition_get(loaded));
    if (entry < 0) {
        return mal_value_new_undefined();
    }
    // Runs the entry with the caller scope injected into its with-stack and the
    // caller's this/new.target bound; leaves the completion in vm->completion.
    return mal_vm_run_entry_with_scope(vm, entry, scope_object, caller_this, caller_new_target);
}

// A small ASCII source fragment as a string value (for the Function wrapper).
static MalValue eval_ascii(MalVm *vm, const char *text) {
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, (const byte *) text, strlen(text)));
}

MalValue mal_vm_construct_function(MalVm *vm, const MalValue *args, i32 arg_count,
                                   MalDynamicFunctionKind kind) {
    // CreateDynamicFunction: the last argument is the body, the rest are the
    // parameter list (each ToString'd, joined by ","). Assemble the source
    // `(<kind> anonymous(<params>\n) {\n<body>\n})` — the wrapping parens make
    // the function expression the script's completion value, which eval returns.
    // The `kind` selects the leading keyword so `yield`/`await` parse in the
    // right context; the resulting function is created by the normal compiled
    // path, so it inherits the matching %GeneratorFunction/AsyncFunction% wiring.
    // GC is suppressed for this native frame, so the intermediate string values
    // held here survive the concatenations without explicit rooting.
    MalValue params = eval_ascii(vm, "");
    MalValue body = eval_ascii(vm, "");
    if (arg_count > 0) {
        for (i32 i = 0; i < arg_count - 1; i++) {
            MalString *part = nullptr;
            if (!mal_vm_to_string(vm, args[i], &part)) {
                return mal_value_new_undefined(); // ToString threw (e.g. a Symbol)
            }
            if (i > 0) {
                params = mal_vm_binary_op(vm, MAL_BIN_ADD, params, eval_ascii(vm, ","));
            }
            params = mal_vm_binary_op(vm, MAL_BIN_ADD, params, mal_value_from_string(part));
        }
        MalString *body_string = nullptr;
        if (!mal_vm_to_string(vm, args[arg_count - 1], &body_string)) {
            return mal_value_new_undefined();
        }
        body = mal_value_from_string(body_string);
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

    MalValue source = eval_ascii(vm, prefix);
    source = mal_vm_binary_op(vm, MAL_BIN_ADD, source, params);
    source = mal_vm_binary_op(vm, MAL_BIN_ADD, source, eval_ascii(vm, "\n) {\n"));
    source = mal_vm_binary_op(vm, MAL_BIN_ADD, source, body);
    source = mal_vm_binary_op(vm, MAL_BIN_ADD, source, eval_ascii(vm, "\n})"));

    return mal_vm_eval_source(vm, source);
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
    return mal_vm_eval_source(vm, arg);
}

// The direct-eval intrinsic (compiler-emitted callee for `eval(...)`). args[0] is
// the source; args[1] is the scope object the caller marshaled from its visible
// bindings. A non-string source passes through unchanged.
static MalValue mal_builtin_direct_eval(MalVm *vm, MalValue this_value, const MalValue *args,
                                        i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue source = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue scope = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    bool caller_strict = arg_count >= 3 && mal_value_is_truthy(args[2]);
    bool in_param_expr = arg_count >= 4 && mal_value_is_truthy(args[3]);
    if (!mal_value_is_string(source)) {
        return source;
    }
    // Direct eval inherits the caller's this/new.target, passed explicitly by the
    // compiler (a compiled caller has no script frame to read them from).
    MalValue caller_this = arg_count >= 5 ? args[4] : mal_value_new_undefined();
    MalValue caller_new_target = arg_count >= 6 ? args[5] : mal_value_new_undefined();
    bool in_field_initializer = arg_count >= 7 && mal_value_is_truthy(args[6]);
    return mal_vm_eval_direct(vm, source, scope, caller_strict, in_param_expr, in_field_initializer,
                              caller_this, caller_new_target);
}

static MalValue mal_dynamic_import_promise(MalVm *vm) {
    MalPromiseObject *promise = mal_promise_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]));
    return mal_value_from_promise_object(promise);
}

static MalValue mal_dynamic_import_fulfill_module(MalVm *vm, MalValue this_value, const MalValue *args,
                                                  i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    MalNativeFunctionObject *fn = mal_value_to_native_function_object(callee);
    MalValue namespace = mal_native_function_object_get_slot(fn, 0);
    MalValue status = mal_native_function_object_get_slot(fn, 1);
    if (mal_value_is_int32(status)) {
        vm->globals[mal_value_to_i32(status)] = mal_value_new_boolean(true);
    }
    return namespace;
}

static MalValue mal_builtin_dynamic_import(MalVm *vm, MalValue this_value, const MalValue *args,
                                           i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;

    MalValue promise_value = mal_dynamic_import_promise(vm);
    MalPromiseObject *promise = mal_value_to_promise_object(promise_value);

    MalValue specifier = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue init_fn = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    MalValue namespace = arg_count >= 3 ? args[2] : mal_value_new_undefined();
    i32 status_slot = arg_count >= 4 && mal_value_is_int32(args[3]) ? mal_value_to_i32(args[3]) : -1;
    MalString *specifier_string = nullptr;
    if (!mal_vm_to_string(vm, specifier, &specifier_string)) {
        MalValue reason = vm->completion.value;
        vm->completion = (MalCompletion) { .kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined() };
        mal_promise_reject(vm, promise, reason);
        return promise_value;
    }

    (void) specifier_string;
    if (mal_value_is_callable(init_fn) && status_slot >= 0 && !mal_value_is_truthy(vm->globals[status_slot])) {
        MalCompletion completion = mal_vm_call_value(vm, init_fn, mal_value_new_undefined(), nullptr, 0);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            mal_promise_reject(vm, promise, completion.value);
            return promise_value;
        }
        if (mal_value_is_promise_object(completion.value)) {
            MalValue resolve = mal_value_new_undefined();
            MalValue reject = mal_value_new_undefined();
            mal_promise_create_resolving(vm, promise_value, &resolve, &reject);
            MalValue slots[2] = { namespace, mal_value_from_i32(status_slot) };
            MalValue on_fulfilled = mal_value_from_native_function_object(
                mal_native_function_object_new_with_slots(
                    &vm->heap,
                    mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                    mal_intrinsic_ascii(vm, ""),
                    mal_dynamic_import_fulfill_module,
                    slots,
                    2));
            mal_promise_perform_then(vm, completion.value, on_fulfilled, reject, resolve, reject);
            return promise_value;
        }
        vm->globals[status_slot] = mal_value_new_boolean(true);
    }
    mal_promise_fulfill(vm, promise, namespace);
    return promise_value;
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
}
