#pragma once

#include "./defaults.h"
#include "http_codec.h"

typedef struct MalVm MalVm;
typedef struct MalHttpConn MalHttpConn;

/*
 * Callback-driven HTTP/1.1 server (host layer). Runs on the isolate's reactor +
 * event loop (mal_host_run_event_loop): a persistent accept op spawns a
 * per-connection state machine (read → parse → respond → keep-alive), all via
 * reactor readiness callbacks on the main context — no fibers.
 *
 * Every connection parses through MalHttpCodec (llhttp) in strict mode. That is
 * the single security boundary for inbound framing: a second parser with its own
 * interpretation of bare LF, obs-fold, duplicate Content-Length or Transfer-Encoding
 * is a request-smuggling differential, so `node:http` and `Mal.serve` share this one.
 */

typedef struct MalHttpServer MalHttpServer;
typedef void (*MalHttpServerCloseCallback)(void *data);
typedef void (*MalHttpResponseCompleteCallback)(void *data, bool success);
typedef void (*MalHttpResponseWriteCallback)(void *data, u64 token);
typedef void (*MalHttpRequestDataCallback)(
    void *data, byte *owned_bytes, usize length);
typedef void (*MalHttpRequestEndCallback)(void *data, bool success);
typedef void (*MalHttpServerStreamHandler)(
    void *data,
    MalVm *vm,
    MalHttpConn *conn,
    const MalHttpCodecHead *head);

/* Transport resource policy. Zero selects the secure default for each field —
 * a limit can be widened or tightened but never disabled. Reconfiguration is
 * allowed while the server runs; it governs newly armed deadlines and subsequent
 * accepts, leaving the deadlines of connections already in flight untouched. */
typedef struct MalHttpServerLimits {
    u32 headers_timeout_ms;
    u32 request_timeout_ms;
    u32 keep_alive_timeout_ms;
    usize max_connections;
} MalHttpServerLimits;

/* Start listening on host:port (host numeric, null => 0.0.0.0; port 0 => ephemeral)
 * with the built-in fixed-response handler, and register the accept op on the
 * isolate's reactor. Transport smoke test only. Returns the server, or null on
 * error. The caller then runs mal_host_run_event_loop(vm) to serve. */
MalHttpServer *mal_http_server_start(MalVm *vm, const char *host, u16 port);

/* Streaming handler. The head is borrowed for the callback. Body
 * buffers are transferred to the registered data callback under explicit credit. */
MalHttpServer *mal_http_server_start_stream_handler(
    MalVm *vm,
    const char *host,
    u16 port,
    MalHttpServerStreamHandler handler,
    void *data);

bool mal_http_server_configure_limits(
    MalHttpServer *server, const MalHttpServerLimits *limits);

/* The bound port (host byte order). */
u16 mal_http_server_port(const MalHttpServer *server);

/* Stop accepting and complete once all accepted connections have drained. Close
 * is idempotent; the callback is invoked from the native reactor path and must not
 * call into JavaScript. */
void mal_http_server_close(
    MalHttpServer *server, MalHttpServerCloseCallback callback, void *data);

/* Close accepted connections without changing the listening state. The all-
 * connections form is the forceful companion to close(); the idle-only form
 * preserves requests or responses that are still in flight. */
void mal_http_server_close_connections(MalHttpServer *server, bool idle_only);

/* Host-only convenience wrapper when no close completion is needed. */
void mal_http_server_stop(MalHttpServer *server);

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

/* Response variant for methods/statuses whose transmitted body length differs
 * from the declared Content-Length. A negative declared length omits the field. */
void mal_http_conn_respond_framed(
    MalHttpConn *conn,
    int status,
    const char *reason,
    const char *headers,
    usize headers_len,
    const char *body,
    usize body_len,
    i64 declared_content_length);

/* Incremental response transport. Start commits the head and selects fixed-length
 * or chunked framing. `expected_body_length` validates transferred bytes separately
 * from framing (HEAD advertises a length but transfers none). Successful writes
 * take ownership of `bytes`; each non-final token is reported after its bytes reach
 * the socket. `end_stream` drives the response-complete callback after flush. */
bool mal_http_conn_response_start(
    MalHttpConn *conn,
    int status,
    const char *reason,
    const char *headers,
    usize headers_len,
    i64 declared_content_length,
    i64 expected_body_length,
    bool chunked);
bool mal_http_conn_response_write_owned(
    MalHttpConn *conn,
    byte *bytes,
    usize length,
    u64 token,
    bool end_stream);
void mal_http_conn_on_response_write(
    MalHttpConn *conn, MalHttpResponseWriteCallback callback, void *data);
void mal_http_conn_abort(MalHttpConn *conn);
void mal_http_conn_on_request_stream(
    MalHttpConn *conn,
    MalHttpRequestDataCallback data_callback,
    MalHttpRequestEndCallback end_callback,
    void *data);
bool mal_http_conn_request_read_credit(MalHttpConn *conn, usize bytes);

/* Keep the request-body credit topped up from the transport's own loop for the rest
 * of this message. Buffered consumers want the whole body and must not call
 * mal_http_conn_request_read_credit from inside a transport callback — that
 * re-enters the connection's drain loop underneath an active frame. Per-turn read
 * budgets and the codec's body-event cap still apply; a total-size limit is the
 * consumer's responsibility. */
void mal_http_conn_request_autoread(MalHttpConn *conn);
void mal_http_conn_request_discard(MalHttpConn *conn);
void mal_http_conn_request_release(MalHttpConn *conn);

/* Configure the next response before mal_http_conn_respond. The completion
 * callback runs from the reactor path after the bytes flush or the connection
 * fails, and must not enter JavaScript. */
void mal_http_conn_close_after_response(MalHttpConn *conn);
void mal_http_conn_on_response_complete(
    MalHttpConn *conn, MalHttpResponseCompleteCallback callback, void *data);
