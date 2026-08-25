#include "vm.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "host.h"
#include "web_host_timer.h" // mal_host_run_event_loop
#include "server.h"

/*
 * Server test binary: start an HTTP server on an ephemeral port, print it, and run
 * the event loop forever. The runner (`tests/native/server.test.ts`) reads the port,
 * drives it with Node's fetch, asserts, and kills the process.
 */

extern const MalProgramImage mal_vm_definition;

/* 8 MiB dwarfs any socket buffer pair, so a peer that stops reading leaves this
 * response permanently mid-flight — the case the transaction deadline exists for. */
#define STALL_BODY_BYTES ((usize) 8 * 1024 * 1024)

static void limits_handler(
    void *data, MalVm *vm, MalHttpConn *conn, const MalHttpCodecHead *head) {
    (void) data;
    (void) vm;
    const char *target = (const char *) mal_http_codec_head_target(head);
    if (head->target_length == 6 && memcmp(target, "/stall", 6) == 0) {
        char *body = malloc(STALL_BODY_BYTES);
        if (body == nullptr) {
            mal_http_conn_abort(conn);
            return;
        }
        memset(body, 'x', STALL_BODY_BYTES);
        mal_http_conn_respond(conn, 200, "OK", nullptr, 0, body, STALL_BODY_BYTES);
        free(body);
        return;
    }
    char msg[512];
    int n = snprintf(
        msg, sizeof(msg), "Maligator: %.*s %.*s\n",
        (int) head->method_length, (const char *) mal_http_codec_head_method(head),
        (int) head->target_length, target);
    mal_http_conn_respond(conn, 200, "OK", nullptr, 0, msg, n > 0 ? (usize) n : 0);
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);
    mal_host_attach(&vm);

    bool limited = getenv("MAL_HTTP_TEST_LIMITS") != nullptr;
    MalHttpServer *server = limited
        ? mal_http_server_start_stream_handler(
              &vm, "127.0.0.1", 0, limits_handler, nullptr)
        : mal_http_server_start(&vm, "127.0.0.1", 0);
    if (server == nullptr) {
        fprintf(stderr, "listen failed\n");
        return 1;
    }
    if (limited) {
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
