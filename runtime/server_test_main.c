#include "vm.h"

#include <stdio.h>
#include <stdlib.h>

#include "host.h"
#include "web_host_timer.h" // mal_host_run_event_loop
#include "server.h"

/*
 * Server test binary: start an HTTP server on an ephemeral port, print it, and run
 * the event loop forever. The runner (`tests/native/server.test.ts`) reads the port,
 * drives it with Node's fetch, asserts, and kills the process.
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
    if (getenv("MAL_HTTP_TEST_LIMITS") != nullptr) {
        MalHttpServerLimits limits = {
            .headers_timeout_ms = 150,
            .request_timeout_ms = 150,
            .keep_alive_timeout_ms = 150,
            .max_connections = 1,
        };
        if (!mal_http_server_configure_limits(server, &limits)) {
            fprintf(stderr, "limit configuration failed\n");
            return 1;
        }
    }
    printf("PORT %u\n", mal_http_server_port(server));
    fflush(stdout);

    mal_host_run_event_loop(&vm); // serves until killed (accept op always pending)
    return 0;
}
