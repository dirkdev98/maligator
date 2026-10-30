#include "server.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/uio.h>
#include <unistd.h>

#include "host.h"
#if MAL_NODE
#include "mal_tls.h"
#endif
#include "net.h"
#include "reactor.h"
#include "vm.h"

#define MAL_HTTP_RBUF_INIT 4096
#define MAL_HTTP_READ_TURN (64 * 1024)
#define MAL_HTTP_READ_CREDIT_MAX (256 * 1024)
#define MAL_HTTP_WRITE_TURN (64 * 1024)
#define MAL_HTTP_WRITE_MAX (256 * 1024)
#define MAL_HTTP_WRITE_IOV 16
#define MAL_HTTP_DEFAULT_HEADERS_TIMEOUT_MS 60000u
#define MAL_HTTP_DEFAULT_REQUEST_TIMEOUT_MS 300000u
#define MAL_HTTP_DEFAULT_KEEP_ALIVE_TIMEOUT_MS 5000u
#define MAL_HTTP_DEFAULT_MAX_CONNECTIONS 1024u

/*
 * Every connection is always inside exactly one armed phase, so no state can park
 * a socket indefinitely:
 *   HEADERS    accepted (or first byte of a reused connection) until the head parses
 *   REQUEST    the whole transaction: head parsed until the response has flushed,
 *              including a stalled write and an application that never releases
 *   KEEP_ALIVE response flushed until the next request's first byte
 * REQUEST is an absolute deadline. Refreshing it on socket activity would let a peer
 * that reads its response one byte at a time hold a connection slot forever.
 */
typedef enum MalHttpTimeoutPhase {
    MAL_HTTP_TIMEOUT_NONE,
    MAL_HTTP_TIMEOUT_HEADERS,
    MAL_HTTP_TIMEOUT_REQUEST,
    MAL_HTTP_TIMEOUT_KEEP_ALIVE,
} MalHttpTimeoutPhase;

struct MalHttpServer {
    MalVm *vm;
    int listen_fd;
    MalOp accept_op;
    MalHttpServerStreamHandler stream_handler;
    void *handler_data;
    struct MalHttpConn *connections;
    usize connection_count;
    i64 headers_timeout_ns;
    i64 request_timeout_ns;
    i64 keep_alive_timeout_ns;
    usize max_connections;
    bool closing;
    MalHttpServerCloseCallback close_callback;
    void *close_data;
    /* Owned; accepted connections then speak TLS in the server role. */
    MalTlsServerConfig *tls_config;
    MalHttpServerTlsCallback tls_callback;
    void *tls_data;
    MalHttpServerTlsHelloCallback tls_hello;
};

typedef struct MalHttpWireWrite {
    byte prefix[32];
    usize prefix_length;
    usize prefix_offset;
    byte *bytes;
    usize length;
    usize offset;
    byte suffix[8];
    usize suffix_length;
    usize suffix_offset;
    usize plain_length;
    u64 token;
    bool notify;
    bool final;
    bool bytes_inline;
    struct MalHttpWireWrite *next;
} MalHttpWireWrite;

typedef struct MalHttpConn {
    MalVm *vm;
    int fd;
    MalOp read_op;
    MalOp write_op;
    MalTimer timeout;
    MalHttpTimeoutPhase timeout_phase;

    /* Transport staging only: bytes are handed to the codec and compacted out
     * every turn, so this never has to hold a whole message. Capped at
     * MAL_HTTP_READ_TURN — message-size limits belong to the codec. */
    char *rbuf;
    usize rcap;
    usize rlen;

    MalHttpCodec codec;
    usize request_read_credit;
    bool codec_initialized;
    bool request_stream_open;
    bool request_message_complete;
    bool request_has_body;
    bool request_autoread;
    bool request_discard;
    bool request_released;
    bool response_finished;
    MalHttpRequestDataCallback request_data_callback;
    MalHttpRequestEndCallback request_end_callback;
    void *request_data;

    MalHttpWireWrite *write_head;
    MalHttpWireWrite *write_tail;
    usize queued_plain_bytes;
    i64 response_remaining;

    bool keep_alive;
    bool awaiting_response;
    bool response_started;
    bool response_chunked;
    bool response_ended;
    bool read_ended;
    bool in_handler;
    bool close_pending;
    MalHttpResponseCompleteCallback response_callback;
    void *response_data;
    MalHttpResponseWriteCallback write_callback;
    void *write_data;
    MalHttpServer *server;
    void *context;
    MalHttpConnectionCloseCallback context_close;
    struct MalHttpConn *next;
    // A connected socket keeps its endpoints, yet every keep-alive request asks again.
    MalNetEndpoint local_endpoint;
    MalNetEndpoint remote_endpoint;
    bool local_endpoint_known;
    bool remote_endpoint_known;
    MalTlsClient *tls;
    /* Ciphertext the socket has not accepted yet; it precedes every later record. */
    byte *tls_out;
    usize tls_out_length;
    usize tls_out_offset;
    /* The last plaintext read filled its buffer, so the session may hold more. */
    bool tls_maybe_buffered;
    bool tls_secure;
    int tls_error;
    struct MalTlsAcceptor *tls_acceptor;
    /* The ClientHello is with JavaScript; reads stay off until a config is selected. */
    bool tls_selecting;
} MalHttpConn;

void *mal_http_conn_context(const MalHttpConn *conn) {
    return conn == nullptr ? nullptr : conn->context;
}

bool mal_http_conn_attach_context(
    MalHttpConn *conn, void *context, MalHttpConnectionCloseCallback close) {
    if (conn == nullptr || conn->context != nullptr || context == nullptr || close == nullptr)
        return false;
    conn->context = context;
    conn->context_close = close;
    return true;
}

bool mal_http_conn_local_endpoint(MalHttpConn *conn, MalNetEndpoint *out) {
    if (conn == nullptr) return false;
    if (!conn->local_endpoint_known) {
        if (!mal_net_local_endpoint(conn->fd, &conn->local_endpoint)) return false;
        conn->local_endpoint_known = true;
    }
    *out = conn->local_endpoint;
    return true;
}

bool mal_http_conn_remote_endpoint(MalHttpConn *conn, MalNetEndpoint *out) {
    if (conn == nullptr) return false;
    if (!conn->remote_endpoint_known) {
        if (!mal_net_remote_endpoint(conn->fd, &conn->remote_endpoint)) return false;
        conn->remote_endpoint_known = true;
    }
    *out = conn->remote_endpoint;
    return true;
}

static MalReactor *conn_reactor(MalHttpConn *c) {
    return &mal_host(c->vm)->reactor;
}

static bool conn_arm_read(MalHttpConn *c);
static bool conn_arm_write(MalHttpConn *c);
static void conn_process_stream(MalHttpConn *c);
static void conn_stream_reset_request(MalHttpConn *c);
static void conn_close(MalHttpConn *c);
static void conn_wire_write_free(MalHttpWireWrite *write);

static i64 server_timeout_ns(u32 configured, u32 fallback) {
    u32 milliseconds = configured == 0 ? fallback : configured;
    return (i64) milliseconds * 1000000;
}

static void conn_cancel_timeout(MalHttpConn *c) {
    mal_reactor_cancel_timer(conn_reactor(c), &c->timeout);
    c->timeout_phase = MAL_HTTP_TIMEOUT_NONE;
}

static void conn_timeout_cb(void *data) {
    MalHttpConn *c = data;
    c->timeout_phase = MAL_HTTP_TIMEOUT_NONE;
    conn_close(c);
}

static void conn_arm_timeout(
    MalHttpConn *c, MalHttpTimeoutPhase phase, i64 duration_ns) {
    // Second-scale limits tolerate the loop clock's lag of one callback batch.
    i64 now = mal_reactor_loop_now_ns(conn_reactor(c));
    c->timeout.waker = (MalWaker) {.fn = conn_timeout_cb, .data = c};
    c->timeout_phase = phase;
    mal_reactor_rearm_timer(
        conn_reactor(c), &c->timeout,
        duration_ns > INT64_MAX - now ? INT64_MAX : now + duration_ns);
}

static void conn_arm_headers_timeout(MalHttpConn *c) {
    conn_arm_timeout(c, MAL_HTTP_TIMEOUT_HEADERS, c->server->headers_timeout_ns);
}

static void conn_arm_request_timeout(MalHttpConn *c) {
    conn_arm_timeout(c, MAL_HTTP_TIMEOUT_REQUEST, c->server->request_timeout_ns);
}

// Node's keepAliveTimeoutBuffer: an idle socket closes a second after keepAliveTimeout,
// so a client that reuses it near that deadline does not race the close.
#define MAL_HTTP_KEEP_ALIVE_CLOSE_BUFFER_NS ((i64) 1000 * 1000000)

static void conn_arm_keep_alive_timeout(MalHttpConn *c) {
    conn_arm_timeout(c, MAL_HTTP_TIMEOUT_KEEP_ALIVE,
        c->server->keep_alive_timeout_ns + MAL_HTTP_KEEP_ALIVE_CLOSE_BUFFER_NS);
}

static void server_finish_close(MalHttpServer *server) {
    MalHttpServerCloseCallback callback = server->close_callback;
    void *data = server->close_data;
#if MAL_NODE
    mal_tls_server_config_free(&server->tls_config);
#endif
    free(server);
    if (callback != nullptr) {
        callback(data);
    }
}

static void conn_close(MalHttpConn *c) {
    if (c->in_handler) {
        c->close_pending = true;
        return;
    }
    MalHttpServer *server = c->server;
#if MAL_NODE
    if ((c->tls != nullptr || c->tls_acceptor != nullptr) && !c->tls_secure && server->tls_callback != nullptr) {
        c->tls_secure = true;
        server->tls_callback(server->tls_data, c, c->tls_error != 0 ? c->tls_error : ECONNRESET);
    }
#endif
    conn_cancel_timeout(c);
    (void) mal_reactor_cancel_op(conn_reactor(c), &c->read_op);
    (void) mal_reactor_cancel_op(conn_reactor(c), &c->write_op);
    mal_net_close(c->fd);
    MalHttpConn **link = &server->connections;
    while (*link != nullptr && *link != c) {
        link = &(*link)->next;
    }
    if (*link == c) {
        *link = c->next;
        server->connection_count--;
    }
    free(c->rbuf);
#if MAL_NODE
    mal_tls_client_free(&c->tls);
    mal_tls_acceptor_free(&c->tls_acceptor);
#endif
    free(c->tls_out);
    if (c->codec_initialized) mal_http_codec_free(&c->codec);
    MalHttpWireWrite *write = c->write_head;
    while (write != nullptr) {
        MalHttpWireWrite *next = write->next;
        conn_wire_write_free(write);
        write = next;
    }
    MalHttpResponseCompleteCallback response_callback = c->response_callback;
    void *response_data = c->response_data;
    MalHttpRequestEndCallback request_end_callback = c->request_end_callback;
    void *request_data = c->request_data;
    bool request_stream_open = c->request_stream_open;
    bool finish_server = server->closing && server->connection_count == 0;
    MalHttpConnectionCloseCallback context_close = c->context_close;
    void *context = c->context;
    free(c);
    if (request_stream_open && request_end_callback != nullptr) {
        request_end_callback(request_data, false);
    }
    if (response_callback != nullptr) response_callback(response_data, false);
    if (context_close != nullptr) context_close(context);
    if (finish_server) server_finish_close(server);
}

static void conn_read_cb(void *data);
static void conn_write_cb(void *data);

static bool conn_arm_read(MalHttpConn *c) {
    if (c->tls_selecting) return true;
    c->read_op.fd = c->fd;
    c->read_op.interest = MAL_IO_READ;
    c->read_op.waker = (MalWaker) {.fn = conn_read_cb, .data = c};
    // Plaintext buffered inside the session never makes the socket readable.
    if (c->tls != nullptr && c->tls_maybe_buffered) {
        return mal_reactor_defer_op(conn_reactor(c), &c->read_op);
    }
    return mal_reactor_add_op(conn_reactor(c), &c->read_op);
}

static bool conn_arm_write(MalHttpConn *c) {
    c->write_op.fd = c->fd;
    c->write_op.interest = MAL_IO_WRITE;
    c->write_op.waker = (MalWaker) {.fn = conn_write_cb, .data = c};
    return mal_reactor_add_op(conn_reactor(c), &c->write_op);
}

static bool conn_defer_write(MalHttpConn *c) {
    c->write_op.fd = c->fd;
    c->write_op.interest = MAL_IO_WRITE;
    c->write_op.waker = (MalWaker) {.fn = conn_write_cb, .data = c};
    return mal_reactor_defer_op(conn_reactor(c), &c->write_op);
}

static bool conn_size_add(usize *total, usize added) {
    if (added > SIZE_MAX - *total) return false;
    *total += added;
    return true;
}

static usize conn_u64_decimal(byte *out, u64 value) {
    byte reversed[20];
    usize length = 0;
    do {
        reversed[length++] = (byte) ('0' + value % 10);
        value /= 10;
    } while (value != 0);
    for (usize i = 0; i < length; i++) {
        out[i] = reversed[length - i - 1];
    }
    return length;
}

static bool conn_queue_write(MalHttpConn *c, MalHttpWireWrite *write) {
    bool was_empty = c->write_tail == nullptr;
    if (was_empty) c->write_head = write;
    else c->write_tail->next = write;
    c->write_tail = write;
    if (was_empty && !c->write_op.active && !conn_defer_write(c)) {
        c->write_head = nullptr;
        c->write_tail = nullptr;
        return false;
    }
    return true;
}

static void conn_wire_write_free(MalHttpWireWrite *write) {
    if (!write->bytes_inline) free(write->bytes);
    free(write);
}

/* A non-null `body` completes the response in the head's own write: one allocation
 * and one queue entry instead of a head write plus an owned body write. */
static bool conn_response_start(
    MalHttpConn *c,
    int status,
    const char *reason,
    const char *headers,
    usize headers_len,
    i64 declared_content_length,
    i64 expected_body_length,
    bool chunked,
    MalHttpResponseHeadSink head_sink,
    void *head_data,
    const byte *body,
    usize body_len) {
    static const char default_ct[] = "Content-Type: text/plain; charset=utf-8\r\n";
    if (c == nullptr || reason == nullptr || status < 100 || status > 999
        || c->response_started || c->response_ended
        || (chunked && (declared_content_length >= 0 || expected_body_length >= 0))
        || (body != nullptr && (chunked || expected_body_length != (i64) body_len))) {
        return false;
    }
    bool keep_alive = c->keep_alive && !c->server->closing;
    byte status_prefix[] = "HTTP/1.1 000 ";
    status_prefix[9] = (byte) ('0' + status / 100);
    status_prefix[10] = (byte) ('0' + status / 10 % 10);
    status_prefix[11] = (byte) ('0' + status % 10);
    usize status_prefix_length = sizeof(status_prefix) - 1;
    usize reason_length = strlen(reason);
    byte framing_buffer[96];
    const char *framing;
    usize framing_length;
    if (chunked) {
        static const char keep_alive_framing[] =
            "Transfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n";
        static const char close_framing[] =
            "Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
        if (keep_alive) {
            framing = keep_alive_framing;
            framing_length = sizeof(keep_alive_framing) - 1;
        } else {
            framing = close_framing;
            framing_length = sizeof(close_framing) - 1;
        }
    } else if (declared_content_length >= 0) {
        static const char prefix[] = "Content-Length: ";
        static const char keep_alive_suffix[] =
            "\r\nConnection: keep-alive\r\n\r\n";
        static const char close_suffix[] = "\r\nConnection: close\r\n\r\n";
        memcpy(framing_buffer, prefix, sizeof(prefix) - 1);
        framing_length = sizeof(prefix) - 1;
        framing_length += conn_u64_decimal(
            framing_buffer + framing_length, (u64) declared_content_length);
        const char *suffix;
        usize suffix_length;
        if (keep_alive) {
            suffix = keep_alive_suffix;
            suffix_length = sizeof(keep_alive_suffix) - 1;
        } else {
            suffix = close_suffix;
            suffix_length = sizeof(close_suffix) - 1;
        }
        memcpy(framing_buffer + framing_length, suffix, suffix_length);
        framing_length += suffix_length;
        framing = (const char *) framing_buffer;
    } else {
        static const char keep_alive_framing[] =
            "Connection: keep-alive\r\n\r\n";
        static const char close_framing[] = "Connection: close\r\n\r\n";
        if (keep_alive) {
            framing = keep_alive_framing;
            framing_length = sizeof(keep_alive_framing) - 1;
        } else {
            framing = close_framing;
            framing_length = sizeof(close_framing) - 1;
        }
    }
    const char *header_bytes = headers == nullptr ? default_ct : headers;
    usize header_length = headers == nullptr ? sizeof(default_ct) - 1 : headers_len;
    usize total = 0;
    if (framing_length > sizeof(framing_buffer)
        || !conn_size_add(&total, status_prefix_length)
        || !conn_size_add(&total, reason_length)
        || !conn_size_add(&total, 2)
        || !conn_size_add(&total, header_length)
        || !conn_size_add(&total, framing_length)) {
        return false;
    }
    usize head_length = total;
    if (body != nullptr && !conn_size_add(&total, body_len)) return false;
    if (total > SIZE_MAX - sizeof(MalHttpWireWrite)) return false;
    MalHttpWireWrite *write = calloc(1, sizeof(*write) + total);
    if (write == nullptr) return false;
    write->bytes = (byte *) (write + 1);
    write->bytes_inline = true;
    usize offset = 0;
    memcpy(write->bytes + offset, status_prefix, status_prefix_length);
    offset += status_prefix_length;
    memcpy(write->bytes + offset, reason, reason_length);
    offset += reason_length;
    memcpy(write->bytes + offset, "\r\n", 2);
    offset += 2;
    if (header_length > 0) {
        memcpy(write->bytes + offset, header_bytes, header_length);
        offset += header_length;
    }
    memcpy(write->bytes + offset, framing, framing_length);
    offset += framing_length;
    if (body != nullptr && body_len > 0) memcpy(write->bytes + offset, body, body_len);
    write->length = total;
    // Like an owned body written with the transport limit waived, a complete
    // response is not counted against the streaming write budget.
    write->final = body != nullptr;
    // The queue may send and free the write before this returns.
    if (head_sink != nullptr) head_sink(head_data, write->bytes, head_length);
    c->response_started = true;
    c->response_chunked = chunked;
    c->response_remaining = body != nullptr ? 0 : expected_body_length;
    c->response_ended = body != nullptr;
    c->awaiting_response = false;
    if (!conn_queue_write(c, write)) {
        c->response_started = false;
        c->response_chunked = false;
        c->response_remaining = 0;
        c->response_ended = false;
        c->awaiting_response = true;
        conn_wire_write_free(write);
        return false;
    }
    return true;
}

bool mal_http_conn_response_start(
    MalHttpConn *c,
    int status,
    const char *reason,
    const char *headers,
    usize headers_len,
    i64 declared_content_length,
    i64 expected_body_length,
    bool chunked,
    MalHttpResponseHeadSink head_sink,
    void *head_data) {
    return conn_response_start(c, status, reason, headers, headers_len,
        declared_content_length, expected_body_length, chunked, head_sink, head_data,
        nullptr, 0);
}

static bool conn_response_write_owned(
    MalHttpConn *c,
    byte *bytes,
    usize length,
    u64 token,
    bool end_stream,
    bool enforce_limit) {
    if (c == nullptr || bytes == nullptr || !c->response_started || c->response_ended
        || (enforce_limit && length > MAL_HTTP_WRITE_MAX - c->queued_plain_bytes)
        || (c->response_remaining >= 0
            && (u64) length > (u64) c->response_remaining)
        || (end_stream && c->response_remaining >= 0
            && (u64) length != (u64) c->response_remaining)) {
        return false;
    }
    MalHttpWireWrite *write = calloc(1, sizeof(*write));
    if (write == nullptr) return false;
    write->bytes = bytes;
    write->length = length;
    write->plain_length = length;
    write->token = token;
    write->notify = !end_stream;
    write->final = end_stream;
    if (c->response_chunked) {
        if (length > 0) {
            int prefix_length = snprintf(
                (char *) write->prefix, sizeof(write->prefix), "%zx\r\n", length);
            if (prefix_length < 0 || (usize) prefix_length >= sizeof(write->prefix)) {
                free(write);
                return false;
            }
            write->prefix_length = (usize) prefix_length;
            const char *suffix = end_stream ? "\r\n0\r\n\r\n" : "\r\n";
            write->suffix_length = end_stream ? 7 : 2;
            memcpy(write->suffix, suffix, write->suffix_length);
        } else if (end_stream) {
            memcpy(write->suffix, "0\r\n\r\n", 5);
            write->suffix_length = 5;
        }
    }
    c->queued_plain_bytes += length;
    if (c->response_remaining >= 0) c->response_remaining -= (i64) length;
    if (end_stream) c->response_ended = true;
    if (!conn_queue_write(c, write)) {
        c->queued_plain_bytes -= length;
        if (c->response_remaining >= 0) c->response_remaining += (i64) length;
        if (end_stream) c->response_ended = false;
        write->bytes = nullptr;
        free(write);
        return false;
    }
    return true;
}

bool mal_http_conn_response_write_owned(
    MalHttpConn *c,
    byte *bytes,
    usize length,
    u64 token,
    bool end_stream) {
    return conn_response_write_owned(c, bytes, length, token, end_stream, true);
}

void mal_http_conn_respond_framed(
    MalHttpConn *c,
    int status,
    const char *reason,
    const char *headers,
    usize headers_len,
    const char *body,
    usize body_len,
    i64 declared_content_length) {
    if (!conn_response_start(
            c, status, reason, headers, headers_len,
            declared_content_length, (i64) body_len, false, nullptr, nullptr,
            body != nullptr ? (const byte *) body : (const byte *) "", body_len)) {
        conn_close(c);
    }
}

void mal_http_conn_respond(
    MalHttpConn *c,
    int status,
    const char *reason,
    const char *headers,
    usize headers_len,
    const char *body,
    usize body_len) {
    mal_http_conn_respond_framed(
        c, status, reason, headers, headers_len, body, body_len, (i64) body_len);
}

void mal_http_conn_close_after_response(MalHttpConn *c) {
    c->keep_alive = false;
}

void mal_http_conn_on_response_complete(
    MalHttpConn *c, MalHttpResponseCompleteCallback callback, void *data) {
    c->response_callback = callback;
    c->response_data = data;
}

void mal_http_conn_on_response_write(
    MalHttpConn *c, MalHttpResponseWriteCallback callback, void *data) {
    c->write_callback = callback;
    c->write_data = data;
}

void mal_http_conn_abort(MalHttpConn *c) {
    if (c != nullptr) conn_close(c);
}

void mal_http_conn_on_request_stream(
    MalHttpConn *c,
    MalHttpRequestDataCallback data_callback,
    MalHttpRequestEndCallback end_callback,
    void *data) {
    if (c == nullptr) return;
    c->request_data_callback = data_callback;
    c->request_end_callback = end_callback;
    c->request_data = data;
}

bool mal_http_conn_request_read_credit(MalHttpConn *c, usize bytes) {
    if (c == nullptr || bytes == 0 || !c->request_stream_open
        || c->request_message_complete || c->request_discard
        || bytes > MAL_HTTP_READ_CREDIT_MAX - c->request_read_credit) {
        return false;
    }
    c->request_read_credit += bytes;
    conn_process_stream(c);
    return true;
}

void mal_http_conn_request_autoread(MalHttpConn *c) {
    if (c == nullptr || !c->request_stream_open || c->request_message_complete) return;
    c->request_autoread = true;
    // Credit is refreshed inside conn_process_stream, never from a callback frame.
}

void mal_http_conn_request_discard(MalHttpConn *c) {
    if (c == nullptr || !c->request_stream_open || c->request_message_complete) return;
    c->request_discard = true;
    c->request_read_credit = MAL_HTTP_READ_CREDIT_MAX;
    if (!c->in_handler) conn_process_stream(c);
}

void mal_http_conn_request_release(MalHttpConn *c) {
    if (c == nullptr || !c->request_message_complete) return;
    c->request_released = true;
    if (!c->response_finished) return;
    if (!c->keep_alive || c->server->closing) {
        conn_close(c);
        return;
    }
    conn_stream_reset_request(c);
    conn_arm_keep_alive_timeout(c);
    conn_process_stream(c);
}

static void conn_send_error(MalHttpConn *c, int status, const char *reason) {
    // The error response still has to reach a peer that may never read it.
    conn_arm_request_timeout(c);
    c->keep_alive = false;
    mal_http_conn_respond(c, status, reason, nullptr, 0, reason, strlen(reason));
}

static void conn_consume_read(MalHttpConn *c, usize consumed) {
    if (consumed == 0) return;
    usize remaining = c->rlen - consumed;
    memmove(c->rbuf, c->rbuf + consumed, remaining);
    c->rlen = remaining;
}

/* A framing error is diagnosable only while this transaction still owns the write
 * side: a bare FIN is indistinguishable from a crashed server, so answer 400 and
 * close after it flushes. Once any response byte has been queued or sent, a second
 * status line would desynchronize the peer, so the only safe move left is to close. */
static void conn_stream_error(MalHttpConn *c) {
    if (!c->response_started && !c->response_ended && !c->response_finished) {
        MalHttpRequestEndCallback request_end_callback = c->request_end_callback;
        void *request_data = c->request_data;
        MalHttpResponseCompleteCallback response_callback = c->response_callback;
        void *response_data = c->response_data;
        bool request_stream_open = c->request_stream_open;
        c->request_read_credit = 0;
        c->request_stream_open = false;
        c->request_message_complete = true;
        c->request_has_body = false;
        c->request_autoread = false;
        c->request_discard = false;
        c->request_released = true;
        c->request_data_callback = nullptr;
        c->request_end_callback = nullptr;
        c->request_data = nullptr;
        c->response_callback = nullptr;
        c->response_data = nullptr;
        c->in_handler = true;
        if (request_stream_open && request_end_callback != nullptr) {
            request_end_callback(request_data, false);
        }
        if (response_callback != nullptr) response_callback(response_data, false);
        c->in_handler = false;
        if (c->close_pending) {
            conn_close(c);
            return;
        }
        if (c->codec.chunk_extensions_overflow) conn_send_error(c, 413, "Payload Too Large");
        else conn_send_error(c, 400, "Bad Request");
    } else {
        conn_close(c);
    }
}

static void conn_stream_reset_request(MalHttpConn *c) {
    c->request_read_credit = 0;
    c->request_stream_open = false;
    c->request_message_complete = false;
    c->request_has_body = false;
    c->request_autoread = false;
    c->request_discard = false;
    c->request_released = false;
    c->response_finished = false;
    c->request_data_callback = nullptr;
    c->request_end_callback = nullptr;
    c->request_data = nullptr;
}

static bool conn_stream_handle_event(MalHttpConn *c) {
    MalHttpCodecEventKind event = mal_http_codec_event(&c->codec);
    if (event == MAL_HTTP_CODEC_EVENT_HEAD) {
        if (c->request_stream_open || c->request_message_complete) {
            conn_stream_error(c);
            return false;
        }
        MalHttpCodecHead *head = mal_http_codec_take_head(&c->codec);
        if (head == nullptr || head->upgrade) {
            mal_http_codec_head_free(head);
            conn_stream_error(c);
            return false;
        }
        c->keep_alive = head->keep_alive && !c->read_ended;
        c->awaiting_response = true;
        c->request_stream_open = true;
        c->request_message_complete = false;
        c->request_has_body = head->chunked || head->content_length > 0;
        c->request_read_credit = 0;
        c->request_autoread = false;
        c->request_discard = false;
        c->request_released = false;
        c->response_finished = false;
        conn_arm_request_timeout(c);
        c->in_handler = true;
        c->server->stream_handler(
            c->server->handler_data, c->vm, c, head);
        c->in_handler = false;
        mal_http_codec_release_head(&c->codec, head);
        if (c->close_pending) {
            conn_close(c);
            return false;
        }
        if (c->request_end_callback == nullptr) {
            c->request_discard = true;
            c->request_read_credit = MAL_HTTP_READ_CREDIT_MAX;
            c->request_released = true;
        }
        return true;
    }
    if (event == MAL_HTTP_CODEC_EVENT_BODY) {
        usize length = 0;
        byte *bytes = mal_http_codec_take_body(&c->codec, &length);
        if (bytes == nullptr || !c->request_stream_open
            || (!c->request_discard && length > c->request_read_credit)) {
            free(bytes);
            conn_stream_error(c);
            return false;
        }
        if (length <= c->request_read_credit) c->request_read_credit -= length;
        else c->request_read_credit = 0;
        if (c->request_discard || c->request_data_callback == nullptr) {
            free(bytes);
        } else {
            c->in_handler = true;
            c->request_data_callback(c->request_data, bytes, length);
            c->in_handler = false;
            if (c->close_pending) {
                conn_close(c);
                return false;
            }
        }
        return true;
    }
    if (event == MAL_HTTP_CODEC_EVENT_COMPLETE) {
        mal_http_codec_clear_event(&c->codec);
        if (!c->request_stream_open) {
            conn_stream_error(c);
            return false;
        }
        c->request_stream_open = false;
        c->request_message_complete = true;
        // The transaction deadline stays armed: a fully received request whose
        // response is still queued, stalled on a full socket, or held by an
        // application that never releases it must not own a slot indefinitely.
        MalHttpRequestEndCallback callback = c->request_end_callback;
        void *data = c->request_data;
        c->request_data_callback = nullptr;
        c->request_end_callback = nullptr;
        c->request_data = nullptr;
        c->in_handler = true;
        if (callback != nullptr) callback(data, true);
        c->in_handler = false;
        if (c->close_pending) {
            conn_close(c);
            return false;
        }
        if (!c->response_finished || !c->request_released) return false;
        if (!c->keep_alive || c->server->closing) {
            conn_close(c);
            return false;
        }
        conn_stream_reset_request(c);
        conn_arm_keep_alive_timeout(c);
        return true;
    }
    return true;
}

static void conn_process_stream(MalHttpConn *c) {
    if (!c->codec_initialized) return;
    usize turn = 0;
    while (turn < MAL_HTTP_READ_TURN) {
        MalHttpCodecEventKind pending = mal_http_codec_event(&c->codec);
        if (pending != MAL_HTTP_CODEC_EVENT_NONE) {
            if (!conn_stream_handle_event(c)) return;
            continue;
        }
        if (c->request_message_complete) return;
        if (c->request_autoread && c->request_stream_open && !c->request_discard
            && c->request_read_credit < MAL_HTTP_READ_CREDIT_MAX) {
            c->request_read_credit = MAL_HTTP_READ_CREDIT_MAX;
        }
        bool body_blocked = c->request_stream_open && c->request_has_body
            && !c->request_discard && c->request_read_credit == 0;
        if (body_blocked) return;

        usize supplied = c->rlen;
        if (supplied > MAL_HTTP_CODEC_BODY_MAX) supplied = MAL_HTTP_CODEC_BODY_MAX;
        if (supplied > MAL_HTTP_READ_TURN - turn) {
            supplied = MAL_HTTP_READ_TURN - turn;
        }
        if (c->request_stream_open && c->request_has_body
            && !c->request_discard && supplied > c->request_read_credit) {
            supplied = c->request_read_credit;
        }
        usize consumed = 0;
        MalHttpCodecResult result = mal_http_codec_execute(
            &c->codec, (const byte *) c->rbuf, supplied, &consumed);
        if (consumed > supplied) {
            conn_stream_error(c);
            return;
        }
        conn_consume_read(c, consumed);
        turn += consumed;
        if (result == MAL_HTTP_CODEC_ERROR) {
            conn_stream_error(c);
            return;
        }
        if (result == MAL_HTTP_CODEC_EVENT) continue;
        if (consumed > 0) continue;
        if (c->read_ended) {
            result = mal_http_codec_finish(&c->codec);
            if (result == MAL_HTTP_CODEC_ERROR) {
                conn_close(c);
                return;
            }
            if (result == MAL_HTTP_CODEC_EVENT) continue;
            conn_close(c);
            return;
        }
        if (!c->read_op.active && !conn_arm_read(c)) conn_close(c);
        return;
    }
    if (c->rlen > 0) {
        if (!c->read_op.active && !conn_arm_read(c)) conn_close(c);
    } else if (!c->read_ended && !c->read_op.active && !conn_arm_read(c)) {
        conn_close(c);
    }
}

#if MAL_NODE
/* Writes queued ciphertext; false with errno EAGAIN while the socket is full. */
static bool conn_tls_flush(MalHttpConn *c) {
    for (;;) {
        if (c->tls_out == nullptr) {
            if (mal_tls_client_wants_write(c->tls) <= 0) return true;
            c->tls_out = malloc(MAL_HTTP_WRITE_TURN);
            if (c->tls_out == nullptr) {
                errno = ENOMEM;
                return false;
            }
            usize produced = 0;
            if (mal_tls_client_write_ciphertext(c->tls, c->tls_out, MAL_HTTP_WRITE_TURN, &produced)
                != MAL_TLS_STATUS_OK) {
                errno = EPROTO;
                return false;
            }
            c->tls_out_length = produced;
            c->tls_out_offset = 0;
        }
        while (c->tls_out_offset < c->tls_out_length) {
            ssize_t n = mal_net_write(c->fd, c->tls_out + c->tls_out_offset,
                c->tls_out_length - c->tls_out_offset);
            if (n > 0) {
                c->tls_out_offset += (usize) n;
                continue;
            }
            if (n < 0 && errno == EINTR) continue;
            if (n == 0) errno = EIO;
            return false;
        }
        free(c->tls_out);
        c->tls_out = nullptr;
        c->tls_out_length = 0;
        c->tls_out_offset = 0;
    }
}

/* Flushes, arming the write op when the socket is full; false after closing. */
static bool conn_tls_drain(MalHttpConn *c) {
    if (conn_tls_flush(c)) return true;
    if ((errno == EAGAIN || errno == EWOULDBLOCK) && (c->write_op.active || conn_arm_write(c))) {
        return false;
    }
    conn_close(c);
    return false;
}

static ssize_t conn_tls_hello_read(MalHttpConn *c) {
    if (c->tls_selecting) {
        errno = EAGAIN;
        return -1;
    }
    byte cipher[16384];
    ssize_t n = read(c->fd, cipher, sizeof(cipher));
    if (n <= 0) return n;
    if (mal_tls_acceptor_read(c->tls_acceptor, cipher, (usize) n) != MAL_TLS_STATUS_OK) {
        c->tls_error = EPROTO;
        errno = EPROTO;
        return -1;
    }
    byte name[256];
    intptr_t length = mal_tls_acceptor_server_name(c->tls_acceptor, name, sizeof(name));
    errno = EAGAIN;
    if (length == -2) return -1;
    c->tls_selecting = true;
    usize copied = length > 0 ? ((usize) length < sizeof(name) ? (usize) length : sizeof(name)) : 0;
    c->server->tls_hello(c->server->tls_data, c, length >= 0 ? name : nullptr, copied);
    errno = EAGAIN;
    return -1;
}

static ssize_t conn_tls_read(MalHttpConn *c, char *out, usize length) {
    if (c->tls_acceptor != nullptr) return conn_tls_hello_read(c);
    for (;;) {
        usize total = 0;
        while (total < length) {
            usize produced = 0;
            if (mal_tls_client_read_plaintext(c->tls, (byte *) out + total, length - total, &produced)
                != MAL_TLS_STATUS_OK) {
                errno = EPROTO;
                return -1;
            }
            if (produced == 0) break;
            total += produced;
        }
        c->tls_maybe_buffered = total == length;
        if (total > 0) return (ssize_t) total;
        if (mal_tls_client_peer_closed(c->tls)) return 0;
        byte cipher[16384];
        ssize_t n = read(c->fd, cipher, sizeof(cipher));
        if (n <= 0) return n;
        usize consumed = 0;
        int status = mal_tls_client_read_ciphertext(c->tls, cipher, (usize) n, &consumed);
        // The handshake replies, or the alert explaining a failure, go out before reading on.
        bool flushed = conn_tls_flush(c);
        if (status != MAL_TLS_STATUS_OK || consumed != (usize) n) {
            c->tls_error = EPROTO;
            errno = EPROTO;
            return -1;
        }
        if (!c->tls_secure && mal_tls_client_is_handshaking(c->tls) == 0) {
            c->tls_secure = true;
            if (c->server->tls_callback != nullptr) {
                c->server->tls_callback(c->server->tls_data, c, 0);
            }
        }
        if (!flushed) {
            if (errno != EAGAIN && errno != EWOULDBLOCK) return -1;
            if (!c->write_op.active && !conn_arm_write(c)) return -1;
        }
    }
}

static ssize_t conn_tls_writev(MalHttpConn *c, const struct iovec *iov, int count) {
    if (!conn_tls_flush(c)) return -1;
    usize total = 0;
    for (int i = 0; i < count; i++) {
        usize consumed = 0;
        if (mal_tls_client_write_plaintext(c->tls, iov[i].iov_base, iov[i].iov_len, &consumed)
            != MAL_TLS_STATUS_OK) {
            errno = EPROTO;
            return -1;
        }
        total += consumed;
        if (consumed < iov[i].iov_len) break;
    }
    if (!conn_tls_flush(c) && errno != EAGAIN && errno != EWOULDBLOCK) return -1;
    if (total == 0) {
        errno = EAGAIN;
        return -1;
    }
    return (ssize_t) total;
}
#endif

static ssize_t conn_read(MalHttpConn *c, char *out, usize length) {
#if MAL_NODE
    if (c->tls != nullptr || c->tls_acceptor != nullptr) return conn_tls_read(c, out, length);
#endif
    return read(c->fd, out, length);
}

static ssize_t conn_writev(MalHttpConn *c, const struct iovec *iov, int count) {
#if MAL_NODE
    if (c->tls != nullptr) return conn_tls_writev(c, iov, count);
#endif
    return mal_net_writev(c->fd, iov, count);
}

static void conn_read_cb(void *data) {
    MalHttpConn *c = data;
    usize turn = 0;

    // A short read can yield to the codec: level-triggered re-arming still
    // reports unread bytes. Full staging buffers wait for codec read credit.
    while (turn < MAL_HTTP_READ_TURN) {
        if (c->rlen == c->rcap && c->rcap < MAL_HTTP_READ_TURN) {
            usize ncap = c->rcap * 2;
            if (ncap > MAL_HTTP_READ_TURN) ncap = MAL_HTTP_READ_TURN;
            char *nbuf = realloc(c->rbuf, ncap);
            if (nbuf == nullptr) {
                conn_close(c);
                return;
            }
            c->rbuf = nbuf;
            c->rcap = ncap;
        }
        usize available = c->rcap - c->rlen;
        if (available > MAL_HTTP_READ_TURN - turn) {
            available = MAL_HTTP_READ_TURN - turn;
        }
        if (available == 0) break;
        ssize_t n = conn_read(c, c->rbuf + c->rlen, available);
        if (n > 0) {
            usize count = (usize) n;
            if (c->timeout_phase == MAL_HTTP_TIMEOUT_KEEP_ALIVE) {
                conn_arm_headers_timeout(c);
            }
            c->rlen += count;
            turn += count;
            if (count < available) break;
            continue;
        }
        if (n == 0) { // peer finished its request side
            c->read_ended = true;
            c->keep_alive = false;
            break;
        }
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            break;
        }
        conn_close(c);
        return;
    }

    conn_process_stream(c);
}

static void conn_write_cb(void *data) {
    MalHttpConn *c = data;
    usize turn = 0;
#if MAL_NODE
    if (c->tls != nullptr && !conn_tls_drain(c)) return;
#endif
    while (c->write_head != nullptr && turn < MAL_HTTP_WRITE_TURN) {
        MalHttpWireWrite *write = c->write_head;
        if (write->prefix_offset == write->prefix_length
            && write->offset == write->length
            && write->suffix_offset == write->suffix_length) {
#if MAL_NODE
            // A response is complete only once its records have reached the socket.
            if (c->tls != nullptr && !conn_tls_drain(c)) return;
#endif
            c->write_head = write->next;
            if (c->write_head == nullptr) c->write_tail = nullptr;
            bool final = write->final;
            bool notify = write->notify;
            u64 token = write->token;
            conn_wire_write_free(write);
            if (notify && c->write_callback != nullptr) {
                c->write_callback(c->write_data, token);
            }
            if (!final) continue;

            c->response_started = false;
            c->response_chunked = false;
            c->response_ended = false;
            c->response_remaining = 0;
            c->response_finished = true;
            MalHttpResponseCompleteCallback response_callback = c->response_callback;
            void *response_data = c->response_data;
            c->response_callback = nullptr;
            c->response_data = nullptr;
            c->write_callback = nullptr;
            c->write_data = nullptr;
            c->in_handler = true;
            if (response_callback != nullptr) response_callback(response_data, true);
            c->in_handler = false;
            if (c->close_pending) {
                conn_close(c);
                return;
            }
            // A response may finish before its request body. Even when the peer
            // asked for Connection: close, keep the read side alive until the
            // application consumes or discards the declared body; closing here
            // races a client that submits the remainder from its response
            // callback.
            if (!c->request_message_complete) {
                conn_process_stream(c);
                return;
            }
            if (!c->request_released) return;
            if (!c->keep_alive || c->server->closing) {
                conn_close(c);
                return;
            }
            conn_stream_reset_request(c);
            conn_arm_keep_alive_timeout(c);
            conn_process_stream(c);
            return;
        }

        struct iovec iov[MAL_HTTP_WRITE_IOV];
        int iov_count = 0;
        usize available = MAL_HTTP_WRITE_TURN - turn;
        for (MalHttpWireWrite *cursor = write;
             cursor != nullptr && available > 0 && iov_count < MAL_HTTP_WRITE_IOV;
             cursor = cursor->next) {
            byte *parts[] = {
                cursor->prefix + cursor->prefix_offset,
                cursor->bytes == nullptr ? nullptr : cursor->bytes + cursor->offset,
                cursor->suffix + cursor->suffix_offset,
            };
            usize lengths[] = {
                cursor->prefix_length - cursor->prefix_offset,
                cursor->length - cursor->offset,
                cursor->suffix_length - cursor->suffix_offset,
            };
            for (int part = 0;
                 part < 3 && available > 0 && iov_count < MAL_HTTP_WRITE_IOV;
                 part++) {
                usize length = lengths[part] > available ? available : lengths[part];
                if (length == 0) continue;
                iov[iov_count++] = (struct iovec) {
                    .iov_base = parts[part],
                    .iov_len = length,
                };
                available -= length;
            }
        }
        ssize_t n = conn_writev(c, iov, iov_count);
        if (n > 0) {
            usize count = (usize) n;
            turn += count;
            for (MalHttpWireWrite *cursor = write;
                 cursor != nullptr && count > 0; cursor = cursor->next) {
                usize prefix = cursor->prefix_length - cursor->prefix_offset;
                usize consumed = prefix > count ? count : prefix;
                cursor->prefix_offset += consumed;
                count -= consumed;

                usize body = cursor->length - cursor->offset;
                consumed = body > count ? count : body;
                cursor->offset += consumed;
                if (cursor->plain_length > 0) c->queued_plain_bytes -= consumed;
                count -= consumed;

                usize suffix = cursor->suffix_length - cursor->suffix_offset;
                consumed = suffix > count ? count : suffix;
                cursor->suffix_offset += consumed;
                count -= consumed;
            }
            continue;
        }
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            if (!conn_arm_write(c)) { // socket buffer full: finish later
                conn_close(c);
            }
            return;
        }
        conn_close(c);
        return;
    }
    if (c->write_head != nullptr && !conn_defer_write(c)) conn_close(c);
}

static void server_accept_cb(void *data) {
    MalHttpServer *server = data;

    if (server->closing) {
        return;
    }

    // Drain the backlog (one-shot: accept until EAGAIN), then re-arm.
    for (;;) {
        int fd = mal_net_accept(server->listen_fd);
        if (fd < 0) {
            break;
        }
        if (server->connection_count >= server->max_connections) {
            mal_net_close(fd);
            continue;
        }
        MalHttpConn *c = calloc(1, sizeof(MalHttpConn));
        if (c == nullptr) {
            mal_net_close(fd);
            continue;
        }
        c->vm = server->vm;
        c->fd = fd;
        c->rbuf = malloc(MAL_HTTP_RBUF_INIT);
        if (c->rbuf == nullptr) {
            mal_net_close(fd);
            free(c);
            continue;
        }
        c->rcap = MAL_HTTP_RBUF_INIT;
        c->rlen = 0;
        c->server = server;
        c->timeout.heap_index = -1;
        if (!mal_http_codec_init(&c->codec, HTTP_REQUEST)) {
            mal_net_close(fd);
            free(c->rbuf);
            free(c);
            continue;
        }
        c->codec_initialized = true;
#if MAL_NODE
        if (server->tls_config != nullptr
            && (server->tls_hello != nullptr
                ? mal_tls_acceptor_create(&c->tls_acceptor)
                : mal_tls_server_create(server->tls_config, &c->tls)) != MAL_TLS_STATUS_OK) {
            mal_http_codec_free(&c->codec);
            mal_net_close(fd);
            free(c->rbuf);
            free(c);
            continue;
        }
#endif
        c->next = server->connections;
        server->connections = c;
        server->connection_count++;
        conn_arm_headers_timeout(c);
        if (!conn_arm_read(c)) {
            conn_close(c);
        }
    }

    // Re-arm the accept op (one-shot).
    server->accept_op.fd = server->listen_fd;
    server->accept_op.interest = MAL_IO_READ;
    server->accept_op.waker = (MalWaker) {.fn = server_accept_cb, .data = server};
    if (!mal_reactor_add_op(&mal_host(server->vm)->reactor, &server->accept_op)) {
        mal_net_close(server->listen_fd);
        server->listen_fd = -1;
    }
}

static MalHttpServer *server_start(
    MalVm *vm, const char *host, u16 port,
    MalHttpServerStreamHandler stream_handler,
    void *handler_data) {
    int fd = mal_net_listen(host, port, 128);
    if (fd < 0) {
        return nullptr;
    }
    MalHttpServer *server = calloc(1, sizeof(MalHttpServer));
    if (server == nullptr) {
        mal_net_close(fd);
        return nullptr;
    }
    server->vm = vm;
    server->listen_fd = fd;
    server->stream_handler = stream_handler;
    server->handler_data = handler_data;
    server->headers_timeout_ns = server_timeout_ns(0, MAL_HTTP_DEFAULT_HEADERS_TIMEOUT_MS);
    server->request_timeout_ns = server_timeout_ns(0, MAL_HTTP_DEFAULT_REQUEST_TIMEOUT_MS);
    server->keep_alive_timeout_ns = server_timeout_ns(
        0, MAL_HTTP_DEFAULT_KEEP_ALIVE_TIMEOUT_MS);
    server->max_connections = MAL_HTTP_DEFAULT_MAX_CONNECTIONS;
    server->accept_op.fd = fd;
    server->accept_op.interest = MAL_IO_READ;
    server->accept_op.waker = (MalWaker) {.fn = server_accept_cb, .data = server};
    if (!mal_reactor_add_op(&mal_host(vm)->reactor, &server->accept_op)) {
        mal_net_close(fd);
        free(server);
        return nullptr;
    }
    return server;
}

/* Transport smoke-test handler: echoes the request line so the accept → parse →
 * respond → keep-alive loop can be driven by a real HTTP client without a VM. */
static void server_fixed_handler(
    void *data, MalVm *vm, MalHttpConn *conn, const MalHttpCodecHead *head) {
    (void) data;
    (void) vm;
    char msg[512];
    int n = snprintf(
        msg, sizeof(msg), "Maligator: %.*s %.*s\n",
        (int) head->method_length, (const char *) mal_http_codec_head_method(head),
        (int) head->target_length, (const char *) mal_http_codec_head_target(head));
    mal_http_conn_respond(conn, 200, "OK", nullptr, 0, msg, n > 0 ? (usize) n : 0);
}

MalHttpServer *mal_http_server_start(MalVm *vm, const char *host, u16 port) {
    return server_start(vm, host, port, server_fixed_handler, nullptr);
}

MalHttpServer *mal_http_server_start_stream_handler(
    MalVm *vm,
    const char *host,
    u16 port,
    MalHttpServerStreamHandler handler,
    void *data) {
    if (handler == nullptr) return nullptr;
    return server_start(vm, host, port, handler, data);
}

bool mal_http_server_configure_limits(
    MalHttpServer *server, const MalHttpServerLimits *limits) {
    if (server == nullptr || limits == nullptr || server->closing) {
        return false;
    }
    server->headers_timeout_ns = server_timeout_ns(
        limits->headers_timeout_ms, MAL_HTTP_DEFAULT_HEADERS_TIMEOUT_MS);
    server->request_timeout_ns = server_timeout_ns(
        limits->request_timeout_ms, MAL_HTTP_DEFAULT_REQUEST_TIMEOUT_MS);
    server->keep_alive_timeout_ns = server_timeout_ns(
        limits->keep_alive_timeout_ms, MAL_HTTP_DEFAULT_KEEP_ALIVE_TIMEOUT_MS);
    server->max_connections = limits->max_connections == 0
        ? MAL_HTTP_DEFAULT_MAX_CONNECTIONS : limits->max_connections;
    return true;
}

bool mal_http_server_set_tls(
    MalHttpServer *server, MalTlsServerConfig *config,
    MalHttpServerTlsCallback callback, void *data) {
#if MAL_NODE
    if (server == nullptr || server->tls_config != nullptr) return false;
    server->tls_config = config;
    server->tls_callback = callback;
    server->tls_data = data;
    return true;
#else
    (void) server; (void) config; (void) callback; (void) data;
    return false;
#endif
}

bool mal_http_server_replace_tls(MalHttpServer *server, MalTlsServerConfig *config) {
#if MAL_NODE
    if (server == nullptr || server->tls_config == nullptr || config == nullptr) return false;
    mal_tls_server_config_free(&server->tls_config);
    server->tls_config = config;
    return true;
#else
    (void) server; (void) config;
    return false;
#endif
}

void mal_http_conn_tls_failure(const MalHttpConn *conn, char *out, usize capacity) {
    if (capacity == 0) return;
    out[0] = '\0';
#if MAL_NODE
    if (conn == nullptr || conn->tls == nullptr) return;
    intptr_t length = mal_tls_session_info(conn->tls, MAL_TLS_INFO_FAILURE, (uint8_t *) out, capacity - 1);
    out[length > 0 && (usize) length < capacity ? (usize) length : 0] = '\0';
#else
    (void) conn;
#endif
}

void mal_http_server_set_tls_hello(MalHttpServer *server, MalHttpServerTlsHelloCallback callback) {
    if (server != nullptr) server->tls_hello = callback;
}

bool mal_http_conn_tls_select(MalHttpConn *c, const MalTlsServerConfig *config) {
#if MAL_NODE
    if (c == nullptr || c->tls_acceptor == nullptr || !c->tls_selecting) return false;
    if (config == nullptr) config = c->server->tls_config;
    int status = config == nullptr ? MAL_TLS_STATUS_INVALID_ARGUMENT
        : mal_tls_acceptor_accept(c->tls_acceptor, config, &c->tls);
    mal_tls_acceptor_free(&c->tls_acceptor);
    c->tls_selecting = false;
    if (status != MAL_TLS_STATUS_OK) {
        c->tls_error = EPROTO;
        conn_close(c);
        return false;
    }
    bool flushed = conn_tls_flush(c);
    if (!flushed && ((errno != EAGAIN && errno != EWOULDBLOCK) || (!c->write_op.active && !conn_arm_write(c)))) {
        conn_close(c);
        return false;
    }
    if (!c->read_op.active && !conn_arm_read(c)) {
        conn_close(c);
        return false;
    }
    return true;
#else
    (void) c; (void) config;
    return false;
#endif
}

void mal_http_conn_tls_mark_reported(MalHttpConn *conn) {
    if (conn != nullptr) conn->tls_secure = true;
}

bool mal_http_conn_is_tls(const MalHttpConn *conn) {
    return conn != nullptr && conn->tls != nullptr;
}

u16 mal_http_server_port(const MalHttpServer *server) {
    return server == nullptr || server->listen_fd < 0
        ? 0 : mal_net_local_port(server->listen_fd);
}

void mal_http_server_close(
    MalHttpServer *server, MalHttpServerCloseCallback callback, void *data) {
    if (server == nullptr || server->closing) {
        return;
    }
    server->closing = true;
    server->close_callback = callback;
    server->close_data = data;
    (void) mal_reactor_cancel_op(&mal_host(server->vm)->reactor, &server->accept_op);
    mal_net_close(server->listen_fd);
    server->listen_fd = -1;
    MalHttpConn *conn = server->connections;
    while (conn != nullptr) {
        MalHttpConn *next = conn->next;
        if (!conn->awaiting_response && conn->write_head == nullptr
            && !conn->response_started && !conn->request_stream_open
            && !(conn->request_message_complete && !conn->request_released)) {
            if (server->connection_count == 1) {
                conn_close(conn);
                return;
            }
            conn_close(conn);
        }
        conn = next;
    }
    if (server->connection_count == 0) {
        server_finish_close(server);
    }
}

void mal_http_server_close_connections(MalHttpServer *server, bool idle_only) {
    if (server == nullptr) return;
    MalHttpConn *conn = server->connections;
    while (conn != nullptr) {
        MalHttpConn *next = conn->next;
        bool idle = !conn->awaiting_response && conn->write_head == nullptr
            && !conn->response_started && !conn->request_stream_open
            && !(conn->request_message_complete && !conn->request_released);
        if (!idle_only || idle) {
            bool finishes_server = server->closing && server->connection_count == 1;
            conn_close(conn);
            if (finishes_server) return;
        }
        conn = next;
    }
}

void mal_http_server_stop(MalHttpServer *server) {
    mal_http_server_close(server, nullptr, nullptr);
}
