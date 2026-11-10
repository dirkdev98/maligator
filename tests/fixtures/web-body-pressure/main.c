#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "gc.h"
#include "gc_process.h"
#include "function_object.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "object_ops.h"
#include "vm.h"
#include "vm_ops.h"
#include "web_fetch.h"
#include "web_request_object.h"
#include "web_response_object.h"
#include "web_readable_stream_object.h"

extern const MalRuntimeImage mal_runtime_image;

#define CHECK(condition) do { if (!(condition)) { fprintf(stderr, "line %d: %s\n", __LINE__, #condition); return false; } } while (0)

static usize expected_getter_charge;
static bool getter_saw_charge;

static MalValue observe_copied_body(MalVm *vm, MalValue self, const MalValue *args,
    i32 count, MalValue new_target, MalValue callee) {
    (void) self; (void) args; (void) count; (void) new_target; (void) callee;
    getter_saw_charge = mal_gc_process_bytes() >= expected_getter_charge;
    return mal_value_from_string(mal_intrinsic_ascii(vm, "POST"));
}

static bool define(MalVm *vm, MalObject *object, const char *name, MalValue value) {
    return mal_object_define_own(object, mal_intrinsic_string_key(vm, (const byte *) name),
        &(MalPropertyDesc) {.flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE,
            .value = value, .getter = MAL_VALUE_UNDEFINED, .setter = MAL_VALUE_UNDEFINED}) == MAL_DEFINE_OWN_APPLIED;
}

static bool bodies_charge_and_release(MalVm *vm) {
    const usize length = 2 * 1024 * 1024;
    MalValue roots[7] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED,
        MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    byte *bytes = malloc(length);
    CHECK(bytes != nullptr);
    memset(bytes, 'q', length);
    roots[0] = mal_value_from_string(mal_string_new_ascii(&vm->heap, bytes, length));
    free(bytes);
    roots[1] = mal_value_from_string(mal_intrinsic_ascii(vm, "http://example.test/body"));
    roots[2] = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    CHECK(define(vm, mal_value_to_object(roots[2]), "method", mal_value_from_string(mal_intrinsic_ascii(vm, "POST"))));
    CHECK(define(vm, mal_value_to_object(roots[2]), "body", roots[0]));
    CHECK(mal_vm_get_property(vm, vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS],
        mal_intrinsic_string_key(vm, (const byte *) "Request"), &roots[3]));
    mal_gc_collect(vm);
    CHECK(define(vm, mal_value_to_object(roots[2]), "method", mal_value_from_string(mal_intrinsic_ascii(vm, "GET"))));
    MalValue args[] = {roots[1], roots[2]};
    MalCompletion made = mal_vm_construct_value(vm, roots[3], args, countof(args));
    CHECK(made.kind == MAL_COMPLETION_THROW);
    usize failed_body_bytes = mal_gc_process_bytes();
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = MAL_VALUE_UNDEFINED};
    mal_gc_collect(vm);
    CHECK(mal_gc_process_bytes() <= failed_body_bytes - length);
    CHECK(define(vm, mal_value_to_object(roots[2]), "method", mal_value_from_string(mal_intrinsic_ascii(vm, "POST"))));
    usize before_clock = vm->heap.bytes_allocated;
    vm->heap.next_gc_at = before_clock + length / 2;
    made = mal_vm_construct_value(vm, roots[3], args, countof(args));
    CHECK(made.kind == MAL_COMPLETION_NORMAL && mal_value_is_request_object(made.value));
    roots[4] = made.value;
    MalRequestObject *request = mal_value_to_request_object(roots[4]);
    CHECK(request->body_len == length && request->body_charge == length);
    CHECK(vm->heap.bytes_allocated - before_clock >= length && mal_gc_poll_requested());
    MalValue clone_method;
    CHECK(mal_vm_get_property(vm, roots[4], mal_intrinsic_string_key(vm, (const byte *) "clone"), &clone_method));
    made = mal_vm_call_value(vm, clone_method, roots[4], nullptr, 0);
    CHECK(made.kind == MAL_COMPLETION_NORMAL && mal_value_is_request_object(made.value));
    roots[5] = made.value;
    MalRequestObject *copy = mal_value_to_request_object(roots[5]);
    CHECK(copy->body != request->body && copy->body_charge == length);
    CHECK(memcmp(copy->body, request->body, length) == 0);
    roots[2] = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    MalNativeFunctionObject *getter = mal_native_function_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "observeBodyCharge"), observe_copied_body);
    roots[0] = mal_value_from_native_function_object(getter);
    CHECK(mal_object_define_own(mal_value_to_object(roots[2]),
        mal_intrinsic_string_key(vm, (const byte *) "method"),
        &(MalPropertyDesc) {.flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
            .value = MAL_VALUE_UNDEFINED, .getter = roots[0], .setter = MAL_VALUE_UNDEFINED}) == MAL_DEFINE_OWN_APPLIED);
    usize deadline = vm->heap.next_gc_at;
    vm->heap.next_gc_at = SIZE_MAX;
    expected_getter_charge = mal_gc_process_bytes() + length;
    MalValue copied_args[] = {roots[5], roots[2]};
    made = mal_vm_construct_value(vm, roots[3], copied_args, countof(copied_args));
    vm->heap.next_gc_at = deadline;
    CHECK(made.kind == MAL_COMPLETION_NORMAL && getter_saw_charge);
    roots[6] = made.value;
    roots[0] = roots[1] = roots[2] = roots[3] = MAL_VALUE_UNDEFINED;
    mal_gc_collect(vm);
    CHECK(request->body[0] == 'q' && copy->body[length - 1] == 'q');
    usize retained = mal_gc_process_bytes();
    roots[4] = roots[5] = roots[6] = MAL_VALUE_UNDEFINED;
    mal_gc_collect(vm);
    CHECK(mal_gc_process_bytes() <= retained - 2 * length);

    byte *response_bytes = malloc(length);
    CHECK(response_bytes != nullptr);
    memset(response_bytes, 'r', length);
    MalResponseObject *response = mal_response_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_RESPONSE_PROTOTYPE]), 200, response_bytes, length);
    roots[0] = mal_value_from_response_object(response);
    CHECK(response->body_charge == length);
    mal_gc_collect(vm);
    CHECK(response->body[length - 1] == 'r');
    mal_gc_unroot(&span);
    return true;
}

int main(void) {
    mal_gc_test_precise_stack_roots = true;
    usize before = mal_gc_process_bytes();
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    mal_readable_stream_install(&vm, mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS]));
    mal_fetch_install(&vm, mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS]));
    bool ok = bodies_charge_and_release(&vm);
    mal_vm_free(&vm);
    if (!ok || mal_gc_process_bytes() != before) return 1;
    puts("web-body-pressure PASS");
    return 0;
}
