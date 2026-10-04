#include "vm.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

#include "gc_process.h"
#include "host.h"
#include "intrinsics.h"
#include "object.h"
#include "personality.h"
#include "serialize.h"
#include "utf8.h"
#include "web_host_timer.h"
#include "worker_manifest.h"
#include "workers.h"

extern const MalRuntimeImage mal_runtime_image;

typedef struct TestRun {
    const char *initial_manifest;
    const char *next_manifest;
    const char *initial_generation;
    bool switched;
    bool save;
    bool saved_phase;
    bool passed;
    int code;
} TestRun;

static MAL_ISOLATE_LOCAL TestRun *current_run;
static MalSerializedValue *saved_url;

static MalValue switch_domain(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt; (void) callee;
    TestRun *run = current_run;
    if (mal_worker_manifest_register(vm, run->switched ? run->initial_manifest : run->next_manifest)) {
        run->switched = !run->switched;
    }
    return mal_value_new_undefined();
}

static MalValue save_domain_url(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    if (argc != 1 || saved_url != nullptr) abort();
    MalSerializeLimits limits = {.max_bytes = 4096};
    const char *error = nullptr;
    saved_url = mal_serialize(vm, args[0], mal_value_new_undefined(), &limits,
        mal_workers_get_serialize_hooks(vm), &error);
    if (saved_url == nullptr || !mal_serialize_commit(vm, saved_url)) abort();
    return mal_value_new_undefined();
}

static MalValue take_domain_url(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt; (void) callee;
    if (saved_url == nullptr) abort();
    MalValue value = mal_value_new_undefined();
    bool decoded = mal_deserialize_take(vm, saved_url, mal_workers_get_serialize_hooks(vm), &value);
    mal_serialized_value_release(saved_url);
    saved_url = nullptr;
    return decoded ? value : mal_value_new_undefined();
}

static MalValue domain_passed(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) vm; (void) self; (void) args; (void) argc; (void) nt; (void) callee;
    current_run->passed = true;
    return mal_value_new_undefined();
}

static void *run_image(void *data) {
    TestRun *run = data;
    current_run = run;
    run->code = 2;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    if (mal_host_attach(&vm) == nullptr) {
        mal_vm_free(&vm);
        return nullptr;
    }
    if (!mal_worker_manifest_register(&vm, run->initial_manifest)) {
        if (mal_value_is_object(vm.completion.value)) {
            MalPropertyLookup message = mal_object_get_own(mal_value_to_object(vm.completion.value),
                mal_intrinsic_string_key(&vm, "message"));
            if (message.present && mal_value_is_string(message.desc.value)) {
                char *text = nullptr;
                usize length;
                if (mal_string_to_utf8_c_string(mal_value_to_string(message.desc.value), &text, &length)
                    == MAL_UTF8_C_STRING_OK) {
                    fprintf(stderr, "initial worker domain: %s\n", text);
                    free(text);
                }
            }
        }
        goto cleanup;
    }
    mal_runtime_personality_install(&vm, true, false);
    const MalHostLaunchContext launch = {.script_path = mal_runtime_image.entry_path};
    mal_vm_run_host_installs(&vm, &launch);
    MalObject *global = mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    mal_intrinsic_define_data(&vm, global, "initialGeneration",
        mal_value_from_string(mal_intrinsic_ascii(&vm, run->initial_generation)), 0);
    mal_intrinsic_define_data(&vm, global, "savePhase", mal_value_new_boolean(run->save), 0);
    mal_intrinsic_define_data(&vm, global, "savedPhase", mal_value_new_boolean(run->saved_phase), 0);
    mal_intrinsic_define_method_n(&vm, global, "switchImageDomain", 0, switch_domain);
    mal_intrinsic_define_method_n(&vm, global, "saveDomainUrl", 1, save_domain_url);
    mal_intrinsic_define_method_n(&vm, global, "takeDomainUrl", 0, take_domain_url);
    mal_intrinsic_define_method_n(&vm, global, "domainPassed", 0, domain_passed);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);
    mal_host_run_event_loop(&vm);
    run->code = mal_host_finish_process(&vm, vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0);
    mal_vm_free_callable(callable);
cleanup:
    mal_workers_shutdown(&vm);
    mal_host_timers_free(&vm);
    mal_host_detach(&vm);
    mal_vm_free(&vm);
    current_run = nullptr;
    return nullptr;
}

int main(int argc, char **argv) {
    if (argc != 3) return 2;
    TestRun runs[] = {
        {.initial_manifest = argv[1], .next_manifest = argv[2], .initial_generation = "first", .save = true},
        {.initial_manifest = argv[2], .next_manifest = argv[1], .initial_generation = "second"},
    };
    pthread_t threads[countof(runs)];
    pthread_attr_t attributes;
    pthread_attr_init(&attributes);
    pthread_attr_setstacksize(&attributes, 16u << 20);
    for (usize index = 0; index < countof(runs); index++) {
        if (pthread_create(&threads[index], &attributes, run_image, &runs[index]) != 0) abort();
    }
    pthread_attr_destroy(&attributes);
    for (usize index = 0; index < countof(runs); index++) pthread_join(threads[index], nullptr);
    bool passed = true;
    for (usize index = 0; index < countof(runs); index++) {
        passed = passed && runs[index].code == 0 && runs[index].passed;
    }
    MalWorkerDomainUsage escaped = mal_worker_domain_usage();
    passed = passed && escaped.live_domains == 1 && escaped.wire_bytes > 0;
    if (!passed || saved_url == nullptr) {
        fprintf(stderr, "image roots did not complete: first=%d/%d second=%d/%d snapshot=%d\n",
            runs[0].code, runs[0].passed, runs[1].code, runs[1].passed, saved_url != nullptr);
        if (saved_url != nullptr) mal_serialized_value_release(saved_url);
        return 1;
    }
    TestRun saved = {.initial_manifest = argv[2], .initial_generation = "second", .saved_phase = true};
    run_image(&saved);
    MalWorkerDomainUsage released = mal_worker_domain_usage();
    passed = passed && saved.code == 0 && saved.passed && mal_workers_live_count() == 0
        && mal_gc_process_bytes() == 0 && released.live_domains == 0 && released.wire_bytes == 0;
    if (saved_url != nullptr) mal_serialized_value_release(saved_url);
    if (!passed) return 1;
    puts("image domains PASS");
    return 0;
}
