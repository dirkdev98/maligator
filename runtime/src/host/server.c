#include "server.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/uio.h>
#include <unistd.h>

#include "host.h"
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
    struct MalHttpConn *next;
} MalHttpConn;

bool mal_http_conn_local_endpoint(const MalHttpConn *conn, MalNetEndpoint *out) {
    return conn != nullptr && mal_net_local_endpoint(conn->fd, out);
}

bool mal_http_conn_remote_endpoint(const MalHttpConn *conn, MalNetEndpoint *out) {
    return conn != nullptr && mal_net_remote_endpoint(conn->fd, out);
}

static MalReactor *conn_reactor(MalHttpConn *c) {
    return &mal_host(c->vm)->reactor;
}

static bool conn_arm_read(MalHttpConn *c);
static bool conn_arm_write(MalHttpConn *c);
static void conn_process_stream(MalHttpConn *c);
static void conn_stream_reset_request(MalHttpConn *c);
static void conn_close(MalHttpConn *c);

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
    mal_reactor_cancel_timer(conn_reactor(c), &c->timeout);
    i64 now = mal_reactor_now_ns();
    c->timeout.deadline_ns = duration_ns > INT64_MAX - now
        ? INT64_MAX : now + duration_ns;
    c->timeout.waker = (MalWaker) {.fn = conn_timeout_cb, .data = c};
    c->timeout_phase = phase;
    mal_reactor_add_timer(conn_reactor(c), &c->timeout);
}

static void conn_arm_headers_timeout(MalHttpConn *c) {
    conn_arm_timeout(c, MAL_HTTP_TIMEOUT_HEADERS, c->server->headers_timeout_ns);
}

static void conn_arm_request_timeout(MalHttpConn *c) {
    conn_arm_timeout(c, MAL_HTTP_TIMEOUT_REQUEST, c->server->request_timeout_ns);
}

static void conn_arm_keep_alive_timeout(MalHttpConn *c) {
    conn_arm_timeout(c, MAL_HTTP_TIMEOUT_KEEP_ALIVE, c->server->keep_alive_timeout_ns);
}

static void server_finish_close(MalHttpServer *server) {
    MalHttpServerCloseCallback callback = server->close_callback;
    void *data = server->close_data;
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
    if (c->codec_initialized) mal_http_codec_free(&c->codec);
    MalHttpWireWrite *write = c->write_head;
    while (write != nullptr) {
        MalHttpWireWrite *next = write->next;
        free(write->bytes);
        free(write);
        write = next;
    }
    MalHttpResponseCompleteCallback response_callback = c->response_callback;
    void *response_data = c->response_data;
    MalHttpRequestEndCallback request_end_callback = c->request_end_callback;
    void *request_data = c->request_data;
    bool request_stream_open = c->request_stream_open;
    bool finish_server = server->closing && server->connection_count == 0;
    free(c);
    if (request_stream_open && request_end_callback != nullptr) {
        request_end_callback(request_data, false);
    }
    if (response_callback != nullptr) response_callback(response_data, false);
    if (finish_server) server_finish_close(server);
}

static void conn_read_cb(void *data);
static void conn_write_cb(void *data);

static bool conn_arm_read(MalHttpConn *c) {
    c->read_op.fd = c->fd;
    c->read_op.interest = MAL_IO_READ;
    c->read_op.waker = (MalWaker) {.fn = conn_read_cb, .data = c};
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

bool mal_http_conn_response_start(
    MalHttpConn *c,
    int status,
    const char *reason,
    const char *headers,
    usize headers_len,
    i64 declared_content_length,
    i64 expected_body_length,
    bool chunked) {
    static const char default_ct[] = "Content-Type: text/plain; charset=utf-8\r\n";
    if (c == nullptr || reason == nullptr || c->response_started || c->response_ended
        || (chunked && (declared_content_length >= 0 || expected_body_length >= 0))) {
        return false;
    }
    bool keep_alive = c->keep_alive && !c->server->closing;
    int status_length = snprintf(nullptr, 0, "HTTP/1.1 %d %s\r\n", status, reason);
    int framing_length;
    if (chunked) {
        framing_length = snprintf(nullptr, 0,
            "Transfer-Encoding: chunked\r\nConnection: %s\r\n\r\n",
            keep_alive ? "keep-alive" : "close");
    } else if (declared_content_length >= 0) {
        framing_length = snprintf(nullptr, 0,
            "Content-Length: %lld\r\nConnection: %s\r\n\r\n",
            (long long) declared_content_length,
            keep_alive ? "keep-alive" : "close");
    } else {
        framing_length = snprintf(nullptr, 0, "Connection: %s\r\n\r\n",
            keep_alive ? "keep-alive" : "close");
    }
    const char *header_bytes = headers == nullptr ? default_ct : headers;
    usize header_length = headers == nullptr ? sizeof(default_ct) - 1 : headers_len;
    usize total = 0;
    if (status_length < 0 || framing_length < 0
        || !conn_size_add(&total, (usize) status_length)
        || !conn_size_add(&total, header_length)
        || !conn_size_add(&total, (usize) framing_length)) {
        return false;
    }
    if (total == SIZE_MAX) return false;
    MalHttpWireWrite *write = calloc(1, sizeof(*write));
    if (write == nullptr) return false;
    write->bytes = malloc(total + 1);
    if (write->bytes == nullptr) {
        free(write);
        return false;
    }
    usize offset = 0;
    int written = snprintf(
        (char *) write->bytes + offset, total - offset + 1,
        "HTTP/1.1 %d %s\r\n", status, reason);
    if (written != status_length) goto fail;
    offset += (usize) written;
    if (header_length > 0) {
        memcpy(write->bytes + offset, header_bytes, header_length);
        offset += header_length;
    }
    if (chunked) {
        written = snprintf((char *) write->bytes + offset, total - offset + 1,
            "Transfer-Encoding: chunked\r\nConnection: %s\r\n\r\n",
            keep_alive ? "keep-alive" : "close");
    } else if (declared_content_length >= 0) {
        written = snprintf((char *) write->bytes + offset, total - offset + 1,
            "Content-Length: %lld\r\nConnection: %s\r\n\r\n",
            (long long) declared_content_length,
            keep_alive ? "keep-alive" : "close");
    } else {
        written = snprintf((char *) write->bytes + offset, total - offset + 1,
            "Connection: %s\r\n\r\n", keep_alive ? "keep-alive" : "close");
    }
    if (written != framing_length) goto fail;
    write->length = total;
    c->response_started = true;
    c->response_chunked = chunked;
    c->response_remaining = expected_body_length;
    c->awaiting_response = false;
    if (!conn_queue_write(c, write)) {
        c->response_started = false;
        c->response_chunked = false;
        c->response_remaining = 0;
        c->awaiting_response = true;
        free(write->bytes);
        free(write);
        return false;
    }
    return true;

fail:
    free(write->bytes);
    free(write);
    return false;
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
    if (!mal_http_conn_response_start(
            c, status, reason, headers, headers_len,
            declared_content_length, (i64) body_len, false)) {
        conn_close(c);
        return;
    }
    byte *owned = malloc(body_len == 0 ? 1 : body_len);
    if (owned == nullptr) {
        conn_close(c);
        return;
    }
    if (body_len > 0) memcpy(owned, body, body_len);
    if (!conn_response_write_owned(c, owned, body_len, 0, true, false)) {
        free(owned);
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
        MalHttpResponseCompleteCallback response_callback = c->response_callback;
        void *response_data = c->response_data;
        c->response_callback = nullptr;
        c->response_data = nullptr;
        if (response_callback != nullptr) response_callback(response_data, false);
        conn_send_error(c, 400, "Bad Request");
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
        mal_http_codec_head_free(head);
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

static void conn_read_cb(void *data) {
    MalHttpConn *c = data;
    usize turn = 0;

    // Drain the socket (one-shot op fired: read until EAGAIN or the turn budget).
    // rbuf is staging, never a message accumulator: the codec consumes and
    // conn_consume_read compacts every turn, so a full buffer means the codec is
    // credit-blocked and we simply stop reading until credit is granted. The
    // reactor op is level-triggered one-shot, so unread bytes re-fire on re-arm.
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
        ssize_t n = read(c->fd, c->rbuf + c->rlen, available);
        if (n > 0) {
            usize count = (usize) n;
            if (c->timeout_phase == MAL_HTTP_TIMEOUT_KEEP_ALIVE) {
                conn_arm_headers_timeout(c);
            }
            c->rlen += count;
            turn += count;
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
    while (c->write_head != nullptr && turn < MAL_HTTP_WRITE_TURN) {
        MalHttpWireWrite *write = c->write_head;
        if (write->prefix_offset == write->prefix_length
            && write->offset == write->length
            && write->suffix_offset == write->suffix_length) {
            c->write_head = write->next;
            if (c->write_head == nullptr) c->write_tail = nullptr;
            bool final = write->final;
            bool notify = write->notify;
            u64 token = write->token;
            free(write->bytes);
            free(write);
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
        ssize_t n = mal_net_writev(c->fd, iov, iov_count);
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
