#include "vm.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "host.h"
#include "net.h"
#include "scheduler.h"

/*
 * Host TCP socket acceptance test (isolate_todo.md — fetch-server groundwork).
 * A server fiber and a client fiber do a full loopback round-trip on the reactor:
 * the client connects (non-blocking), sends a message; the server accepts, reads,
 * echoes; the client reads the echo back and checks it. This exercises
 * listen/accept/connect + connect-completion (SO_ERROR) + read/write readiness —
 * the socket substrate the callback-driven HTTP server will reuse. Pure C (no JS),
 * so running it on fibers is fine.
 */

extern const MalVmDefinition mal_vm_definition;

#define MSG "ping-pong-42"

static int g_listen_fd = -1;
static u16 g_port = 0;
static bool g_server_ok = false;
static bool g_client_ok = false;

static void server_fiber(void *arg) {
    (void) arg;
    MalScheduler *s = mal_current_scheduler;

    mal_sched_wait_fd(s, g_listen_fd, MAL_IO_READ);
    int client = mal_net_accept(g_listen_fd);
    if (client < 0) {
        return;
    }

    char buf[64];
    mal_sched_wait_fd(s, client, MAL_IO_READ);
    ssize_t n = read(client, buf, sizeof(buf));
    if (n > 0) {
        mal_sched_wait_fd(s, client, MAL_IO_WRITE);
        ssize_t w = write(client, buf, (size_t) n); // echo
        g_server_ok = (w == n);
    }
    mal_net_close(client);
}

static void client_fiber(void *arg) {
    (void) arg;
    MalScheduler *s = mal_current_scheduler;

    int fd = mal_net_connect("127.0.0.1", g_port);
    if (fd < 0) {
        return;
    }
    // Non-blocking connect completes when the socket becomes writable.
    mal_sched_wait_fd(s, fd, MAL_IO_WRITE);
    if (mal_net_socket_error(fd) != 0) {
        mal_net_close(fd);
        return;
    }

    if (write(fd, MSG, strlen(MSG)) != (ssize_t) strlen(MSG)) {
        mal_net_close(fd);
        return;
    }

    char buf[64];
    mal_sched_wait_fd(s, fd, MAL_IO_READ);
    ssize_t n = read(fd, buf, sizeof(buf));
    if (n == (ssize_t) strlen(MSG) && memcmp(buf, MSG, (size_t) n) == 0) {
        g_client_ok = true;
    }
    mal_net_close(fd);
}

int main(void) {
    mal_gc_init();

    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);
    mal_host_attach(&vm);

    MalScheduler sched;
    mal_sched_init(&sched, &vm);

    g_listen_fd = mal_net_listen("127.0.0.1", 0, 16);
    bool listen_ok = g_listen_fd >= 0;
    if (listen_ok) {
        g_port = mal_net_local_port(g_listen_fd);
    }

    if (listen_ok && g_port != 0) {
        mal_sched_spawn(&sched, server_fiber, nullptr);
        mal_sched_spawn(&sched, client_fiber, nullptr);
        mal_sched_run(&sched);
    }
    mal_sched_shutdown();
    mal_net_close(g_listen_fd);

    struct {
        const char *name;
        bool ok;
    } checks[] = {
        {"listen bound to an ephemeral port", listen_ok && g_port != 0},
        {"server accepted + read + echoed", g_server_ok},
        {"client connected + round-tripped the message", g_client_ok},
    };
    int total = (int) (sizeof(checks) / sizeof(checks[0]));
    int passed = 0;
    for (int i = 0; i < total; i++) {
        if (checks[i].ok) {
            passed++;
        } else {
            printf("nettest CHECK FAIL: %s\n", checks[i].name);
        }
    }
    printf("nettest: port=%u server_ok=%d client_ok=%d\n", g_port, g_server_ok, g_client_ok);
    printf("nettest PASS %d/%d\n", passed, total);

    mal_gc_collect(&vm);
    mal_host_detach(&vm);
    mal_vm_free(&vm);
    return passed == total ? 0 : 1;
}
