#include "vm.h"

#include <stdio.h>
#include <stdlib.h>

#include "host.h"
#include "host_timer.h" // mal_host_run_event_loop
#include "server.h"

/*
 * Server test binary: start an HTTP server on an ephemeral port, print it, and run
 * the event loop forever. The runner (scripts/servertest.ts) reads the port, drives
 * it with Node's fetch, asserts, and kills the process.
 */

extern const MalVmDefinition mal_vm_definition;

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);
    mal_host_attach(&vm);

    MalHttpServer *server = mal_http_server_start(&vm, "127.0.0.1", 0);
    if (server == nullptr) {
        fprintf(stderr, "listen failed\n");
        return 1;
    }
    printf("PORT %u\n", mal_http_server_port(server));
    fflush(stdout);

    mal_host_run_event_loop(&vm); // serves until killed (accept op always pending)
    return 0;
}
