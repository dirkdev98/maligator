#include <stdio.h>
#include "gc.h"
#include "vm.h"
#include "worker_manifest.h"
#include "workers.h"

extern const MalRuntimeImage mal_runtime_image;

int main(int argc, char **argv) {
    if (argc != 3) return 1;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    MalWorkerDomainUsage before = mal_worker_domain_usage();
    MalWorkerDomain *domain = mal_worker_manifest_load(&vm, argv[1]);
    if (domain == nullptr || vm.completion.kind != MAL_COMPLETION_NORMAL) return 2;
    mal_gc_collect(&vm);
    MalWorkerDomainUsage loaded = mal_worker_domain_usage();
    if (loaded.live_domains != before.live_domains + 1 || loaded.wire_bytes <= before.wire_bytes) return 3;
    mal_worker_domain_release(domain);
    mal_gc_collect(&vm);
    if (mal_worker_manifest_load(&vm, argv[2]) != nullptr || vm.completion.kind != MAL_COMPLETION_THROW) return 4;
    MalWorkerDomainUsage after = mal_worker_domain_usage();
    if (after.live_domains != before.live_domains || after.wire_bytes != before.wire_bytes) return 5;
    vm.completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = MAL_VALUE_UNDEFINED};
    mal_vm_free(&vm);
    puts("worker-manifest-growth PASS");
    return 0;
}
