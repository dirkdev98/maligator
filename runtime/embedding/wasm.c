#include <stdlib.h>
#include "vm.h"
#include "vm_ops.h"
#include "gc.h"
#include "utf8.h"

#if !defined(__wasi__) || defined(__wasm_atomics__)
#error "This embedding requires a single-threaded WASI reactor"
#endif
#if MAL_EVAL || MAL_REALMS || MAL_INTL || MAL_TEMPORAL || MAL_NODE || MAL_WEB_PLATFORM || MAL_PROFILE
#error "The Wasm reactor requires the engine-only feature profile"
#endif

#ifndef MAL_WASM_MAX_INPUT_BYTES
#define MAL_WASM_MAX_INPUT_BYTES (512 * 1024)
#endif
#ifndef MAL_WASM_MAX_OUTPUT_BYTES
#define MAL_WASM_MAX_OUTPUT_BYTES (8 * 1024 * 1024)
#endif

extern const MalRuntimeImage mal_runtime_image;
static MalVm vm;
static bool initialized;
static byte *output;
static usize output_length;
static int status;

int mal_wasm_abi_version(void) { return 1; }
usize mal_wasm_output_length(void) { return output_length; }
int mal_wasm_status(void) { return status; }
u64 mal_wasm_collection_count(void) { return initialized ? mal_gc_collection_count(&vm) : 0; }

void mal_wasm_release(void) {
    free(output);
    output = nullptr;
    output_length = 0;
    status = 0;
}

static void set_output(MalValue value) {
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    // Diagnostic coercion must run outside the caught throw while retaining its value.
    vm.completion = (MalCompletion) { .kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined() };
    MalString *text;
    if (!mal_vm_to_string(&vm, value, &text)) {
        status = 2;
    } else if (mal_string_utf8_length(text) > MAL_WASM_MAX_OUTPUT_BYTES) {
        status = 3;
    } else {
        output = mal_string_to_utf8(text, &output_length);
        if (output == nullptr) status = 3;
    }
    mal_gc_unroot(&root);
}

int mal_wasm_init(void) {
    if (initialized) return 2;
    mal_vm_init(&vm, &mal_runtime_image);
    initialized = true;
    MalCallable *entry = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, entry);
    mal_vm_free_callable(entry);
    if (vm.completion.kind == MAL_COMPLETION_THROW) {
        status = 1;
        set_output(vm.completion.value);
    }
    return status;
}

const byte *mal_wasm_call(const byte *name, usize name_length, const byte *input, usize input_length) {
    mal_wasm_release();
    if (!initialized || name == nullptr || name_length == 0 || name_length > 256 || (input == nullptr && input_length != 0)) {
        status = 2;
        return nullptr;
    }
    if (input_length > MAL_WASM_MAX_INPUT_BYTES) {
        status = 3;
        return nullptr;
    }
    vm.completion = (MalCompletion) { .kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined() };
    MalValue roots[3] = { mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined() };
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    roots[0] = mal_value_from_string(mal_string_from_utf8(&vm.heap, name, name_length));
    if (!mal_vm_get_property(&vm, vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS], mal_key_from_value(roots[0]), &roots[1])) {
        status = 1;
        set_output(vm.completion.value);
    } else {
        roots[2] = mal_value_from_string(mal_string_from_utf8(&vm.heap, input, input_length));
        MalCompletion completion = mal_vm_call_value(&vm, roots[1], mal_value_new_undefined(), &roots[2], 1);
        status = completion.kind == MAL_COMPLETION_THROW ? 1 : 0;
        set_output(completion.value);
    }
    mal_gc_unroot(&root);
    return output;
}

void mal_wasm_dispose(void) {
    mal_wasm_release();
    if (initialized) {
        mal_vm_free(&vm);
        initialized = false;
    }
}
