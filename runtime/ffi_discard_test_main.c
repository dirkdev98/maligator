#include "vm.h"
#include "ffi/mal_ffi.h"
#include "builtin_promise.h"
#include "gc.h"
#include "host.h"
#include "intrinsics.h"
#include "web_host_timer.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

extern const MalRuntimeImage mal_runtime_image;

static int destroyed;
static bool rejected;
static bool completed;
static bool released;
static int recycled;
static bool recycled_open;
static bool destroy_resource(void *value) {
    destroyed++;
    if (value == &recycled) { assert(recycled_open); recycled_open = false; }
    else free(value);
    return true;
}
static const MalFfiHandleType resource_type = {
    .name = "DiscardResource", .destroy_name = "destroy_resource",
    .destroy = destroy_resource, .collect = true,
};
static const MalFfiLibrary library = {.specifier = "maligator:ffi/discard-test"};

typedef struct DiscardCall {
    int *value;
    bool ran;
    bool observed;
    MalFfiDiscards discards;
    MalFfiDiscardedHandle items[1];
} DiscardCall;

static bool reject_wake(void *data) { (void)data; return false; }
static void run(void *data) { ((DiscardCall *)data)->ran = true; }
static MalValue complete(MalVm *vm, void *data, bool ran) {
    DiscardCall *call = data;
    if (!ran) return mal_ffi_undefined();
    assert(mal_ffi_threw(vm));
    call->observed = true;
    assert(!mal_ffi_discard_claim(vm, &call->discards, &resource_type, call->value, false));
    completed = true;
    return mal_ffi_undefined();
}
static void release(void *data) {
    DiscardCall *call = data;
    if (call->ran && !call->observed
        && mal_ffi_discard_claim(nullptr, &call->discards, &resource_type, call->value, false))
        destroy_resource(call->value);
    mal_ffi_discards_finish(&call->discards);
    free(call);
    released = true;
}
static MalValue reject(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void)vm; (void)self; (void)args; (void)argc; (void)new_target; (void)callee;
    rejected = true;
    return mal_ffi_undefined();
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    MalHost *host = mal_host_attach(&vm);
    assert(host != nullptr);
    // A failed wake rolls back posting after C finishes; reaping must still reject
    // the promise and clean its result while this VM remains available.
    mal_host_posted_tasks_free(&host->posted_tasks);
    assert(mal_host_posted_tasks_init(&host->posted_tasks, reject_wake, nullptr));
    mal_ffi_install(&vm, &library, nullptr, 0);
    MalValue roots[3] = {mal_ffi_undefined(), mal_ffi_undefined(), mal_ffi_undefined()};
    MalFfiRoots root;
    mal_ffi_root(&root, roots, 3);
    bool fresh_test = getenv("MAL_FFI_DISCARD_FRESH") != nullptr;
    int *value = fresh_test ? &recycled : malloc(sizeof(*value));
    assert(value != nullptr);
    recycled_open = fresh_test;
    *value = 7;
    roots[0] = mal_ffi_new_handle(&vm, &library, &resource_type, value, true, false);
    assert(!mal_ffi_threw(&vm));
    if (fresh_test) {
        MalFfiDiscardedHandle items[3];
        MalFfiDiscards claims[3] = {
            {.items = &items[0], .capacity = 1},
            {.items = &items[1], .capacity = 1},
            {.items = &items[2], .capacity = 1},
        };
        assert(!mal_ffi_discard_claim(&vm, &claims[0], &resource_type, value, true));
        MalFfiSite site = {"recycle", "resource", nullptr};
        void *pointer, *pin;
        assert(mal_ffi_to_handle(&vm, roots[0], &resource_type, false, &site, &pointer, &pin));
        assert(mal_ffi_begin_handle_close(&vm, pin, false, &site));
        destroy_resource(value);
        recycled_open = true;
        assert(!mal_ffi_discard_claim(&vm, &claims[1], &resource_type, value, false));
        assert(mal_ffi_discard_claim(&vm, &claims[2], &resource_type, value, true));
        destroy_resource(value);
        mal_ffi_finish_handle_close(roots[0], true);
        mal_ffi_unpin_handle(pin);
        mal_host_detach(&vm);
        mal_ffi_unroot(&root);
        mal_vm_free(&vm);
        assert(destroyed == 2 && !recycled_open);
        puts("ffi fresh discard passed");
        return 0;
    }
    DiscardCall *call = calloc(1, sizeof(*call));
    assert(call != nullptr);
    call->value = value;
    assert(mal_ffi_discards_init(&vm, &call->discards, call->items, 1));
    assert(mal_ffi_async(&vm, call, run, complete, release, roots, 1, nullptr,
        nullptr, 0, &roots[1], false));
    roots[2] = mal_intrinsic_define_method(&vm,
        mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS]),
        (const byte *)"rejectDelivery", reject);
    mal_promise_perform_then(&vm, roots[1], mal_ffi_undefined(), roots[2],
        mal_ffi_undefined(), mal_ffi_undefined());
    mal_host_run_event_loop(&vm);
    assert(vm.completion.kind != MAL_COMPLETION_THROW);
    assert(rejected && completed && released && destroyed == 0 && *value == 7);
    mal_host_detach(&vm);
    mal_ffi_unroot(&root);
    mal_vm_free(&vm);
    assert(destroyed == 1);
    puts("ffi discarded delivery passed");
    return 0;
}
