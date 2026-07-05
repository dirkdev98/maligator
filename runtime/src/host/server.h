#pragma once

#include "./defaults.h"
#include "http.h"

typedef struct MalVm MalVm;
typedef struct MalHttpConn MalHttpConn;

/*
 * Callback-driven HTTP/1.1 server (host layer). Runs on the isolate's reactor +
 * event loop (mal_host_run_event_loop): a persistent accept op spawns a
 * per-connection state machine (read → parse → respond → keep-alive), all via
 * reactor readiness callbacks on the main context — no fibers. This is the
 * transport the WinterTC fetch handler (Mal.serve) will plug into; for now it
 * replies with a fixed response so the loop can be tested end-to-end against a real
 * HTTP client before the JS Request/Response objects exist.
 */

typedef struct MalHttpServer MalHttpServer;

/* Start listening on host:port (host numeric, null => 0.0.0.0; port 0 => ephemeral)
 * and register the accept op on the isolate's reactor. Returns the server, or null
 * on error. The caller then runs mal_host_run_event_loop(vm) to serve. */
MalHttpServer *mal_http_server_start(MalVm *vm, const char *host, u16 port);

/* The bound port (host byte order). */
u16 mal_http_server_port(const MalHttpServer *server);

/* Stop accepting, close the listener, and free the server (in-flight connections
 * are left to drain/close themselves). */
void mal_http_server_stop(MalHttpServer *server);

/*
 * Request handler hook, set by the runtime (Mal.serve). Called with a fully-parsed
 * request; `body`/`body_len` point into the connection's read buffer and are valid
 * only during the call (copy what you keep). The hook must arrange for
 * mal_http_conn_respond to be called on `conn`. When null, the server replies with a
 * built-in fixed response (the transport smoke test). Keeps the host layer free of
 * any runtime (Request/Response) type dependency.
 */
typedef void (*MalHttpHandler)(
    MalVm *vm, MalHttpConn *conn, const MalHttpRequest *req, const char *body, usize body_len);
extern MalHttpHandler mal_http_handler;

/*
 * Send a response on the connection: status line + the given header block (each
 * line "Name: Value\r\n"; pass null for a default text/plain Content-Type) + the
 * host-managed Content-Length + Connection framing + body bytes. The runtime passes
 * a serialized Headers block (Content-Type included, host-managed headers excluded).
 */
void mal_http_conn_respond(
    MalHttpConn *conn,
    int status,
    const char *reason,
    const char *headers,
    usize headers_len,
    const char *body,
    usize body_len);
