#include "vm.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "host.h"
#include "intrinsics.h"
#include "object_ops.h"
#include "scheduler.h"
#include "vm_ops.h"

extern const MalRuntimeImage mal_runtime_image;

enum { JSON_TEST_DEPTH = 1400 };

static MalVm *json_vm;
static MalValue held[7];
static int failed;
static int callbacks;
static bool introduce_tree;

static void check(bool ok, const char *message) {
    if (!ok) {
        printf("FAIL: %s\n", message);
        failed++;
    }
}

static MalValue identity(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target;
    (void) callee;
    callbacks++;
    if (introduce_tree && arg_count > 0 && mal_value_is_string(args[0]) &&
        mal_string_equals(mal_value_to_string(args[0]), mal_intrinsic_ascii(vm, "first"))) {
        mal_intrinsic_define_data(vm, mal_value_to_object(this_value), "later", held[0],
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    return arg_count >= 2 ? args[1] : mal_value_new_undefined();
}

static MalValue call_json(MalValue function, MalValue input, bool callback) {
    MalValue args[2] = {input, callback ? held[5] : mal_value_new_undefined()};
    MalCompletion completion = mal_vm_call_value(
        json_vm, function, held[6], args, callback ? 2 : 1);
    check(completion.kind == MAL_COMPLETION_NORMAL,
        "deep JSON traversal succeeds on a small fiber stack");
    held[4] = completion.kind == MAL_COMPLETION_NORMAL
        ? completion.value : mal_value_new_undefined();
    json_vm->completion = (MalCompletion) {
        .kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined(),
    };
    mal_gc_collect(json_vm);
    return held[4];
}

static void check_parse(MalValue parse, MalValue stringify, MalValue input, bool callback) {
    MalValue parsed = call_json(parse, input, callback);
    MalValue text = call_json(stringify, parsed, false);
    check(mal_value_is_string(text) &&
        mal_string_equals(mal_value_to_string(text), mal_value_to_string(input)),
        "fiber parse retains the complete nested value");
}

static void worker(void *arg) {
    (void) arg;
    MalValue methods[2] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan method_roots;
    mal_gc_root(&method_roots, methods, 2);
    check(mal_vm_get_property(json_vm, held[6],
        mal_intrinsic_string_key(json_vm, "parse"), &methods[0]), "JSON.parse exists");
    check(mal_vm_get_property(json_vm, held[6],
        mal_intrinsic_string_key(json_vm, "stringify"), &methods[1]), "JSON.stringify exists");
    callbacks = 0;
    check_parse(methods[0], methods[1], held[1], false);
    check_parse(methods[0], methods[1], held[1], true);
    check_parse(methods[0], methods[1], held[2], true);
    check(callbacks == 2 * (JSON_TEST_DEPTH + 1), "deep fiber parses visit every value");
    callbacks = 0;
    MalValue text = call_json(methods[1], held[0], true);
    check(mal_value_is_string(text) &&
        mal_string_equals(mal_value_to_string(text), mal_value_to_string(held[1])) &&
        callbacks == JSON_TEST_DEPTH + 1, "fiber stringify retains every callback and nested object");
    introduce_tree = true;
    callbacks = 0;
    MalValue introduced = call_json(methods[0], held[3], true);
    MalValue later;
    check(mal_vm_get_property(json_vm, introduced,
        mal_intrinsic_string_key(json_vm, "later"), &later) && later == held[0] &&
        callbacks == JSON_TEST_DEPTH + 3, "reviver-introduced trees finish on the fiber stack");
    introduce_tree = false;
    mal_gc_unroot(&method_roots);
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    mal_host_attach(&vm);
    json_vm = &vm;
    for (usize i = 0; i < sizeof(held) / sizeof(*held); i++) held[i] = mal_value_new_undefined();
    MalRootSpan roots;
    mal_gc_root(&roots, held, sizeof(held) / sizeof(*held));
    held[0] = mal_value_from_i32(0);
    usize depth = JSON_TEST_DEPTH;
    for (usize i = 0; i < depth; i++) {
        held[4] = mal_value_from_object(mal_intrinsic_new_object(&vm));
        mal_intrinsic_define_data(&vm, mal_value_to_object(held[4]), "next", held[0],
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
        held[0] = held[4];
    }
    byte *text = malloc(depth * 9 + 1);
    if (text == nullptr) abort();
    for (usize i = 0; i < depth; i++) memcpy(text + i * 8, "{\"next\":", 8);
    text[depth * 8] = '0';
    memset(text + depth * 8 + 1, '}', depth);
    held[1] = mal_value_from_string(mal_string_new_ascii(&vm.heap, text, depth * 9 + 1));
    memset(text, '[', depth);
    text[depth] = '0';
    memset(text + depth + 1, ']', depth);
    held[2] = mal_value_from_string(mal_string_new_ascii(&vm.heap, text, depth * 2 + 1));
    free(text);
    held[3] = mal_value_from_string(mal_intrinsic_ascii(&vm, "{\"first\":0,\"later\":1}"));
    held[5] = mal_value_from_native_function_object(mal_native_function_object_new_arity(
        &vm.heap, mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(&vm, "identity"), 3, identity));
    held[6] = vm.intrinsics[MAL_INTRINSIC_JSON];

    MalScheduler scheduler;
    mal_sched_init(&scheduler, &vm);
    mal_sched_spawn(&scheduler, worker, nullptr);
    mal_sched_run(&scheduler);
    mal_sched_shutdown();
    mal_gc_unroot(&roots);
    mal_gc_collect(&vm);
    mal_host_detach(&vm);
    mal_vm_free(&vm);
    puts(failed == 0 ? "json-fiber PASS" : "json-fiber FAIL");
    return failed != 0;
}
