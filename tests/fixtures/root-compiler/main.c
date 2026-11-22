#include "dev_runner.h"
#include "gc_process.h"
#include "workers.h"
#include <stdio.h>

int main(int argc, char **argv) {
    if (argc != 4) return 2;
    const char *wires[] = {argv[1]};
    char *program[] = {argv[0], argv[3]};
    int code = mal_dev_run_wires(wires, 1, nullptr, 2, program, argv[2], true);
    MalWorkerDomainUsage domains = mal_worker_domain_usage();
    if (mal_workers_live_count() != 0 || mal_gc_process_bytes() != 0 || domains.live_domains != 0 || domains.wire_bytes != 0) return 1;
    if (code == 0) puts("root compiler joined PASS");
    return code;
}
