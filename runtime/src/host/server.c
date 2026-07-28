#include "server.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "host.h"
#include "http.h"
#include "net.h"
#include "reactor.h"
#include "vm.h"

#define MAL_HTTP_RBUF_INIT 4096
#define MAL_HTTP_HEADERS_MAX (64 * 1024) // reject header blocks larger than this
#define MAL_HTTP_WRITE_TURN (64 * 1024)
#define MAL_HTTP_WRITE_MAX (256 * 1024)

MalHttpHandler mal_http_handler = nullptr;

typedef enum MalHttpRequestBehavior {
    MAL_HTTP_REQUEST_FIXED,
    MAL_HTTP_REQUEST_HANDLER,
    MAL_HTTP_REQUEST_SERVER_HANDLER,
    MAL_HTTP_REQUEST_CLOSE,
} MalHttpRequestBehavior;

struct MalHttpServer {
    MalVm *vm;
    int listen_fd;
    MalOp accept_op;
    MalHttpRequestBehavior request_behavior;
    MalHttpHandler handler;
    MalHttpServerHandler server_handler;
    void *handler_data;
    struct MalHttpConn *connections;
    usize connection_count;
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

    char *rbuf; // inbound bytes (request line + headers + body), growable
    usize rcap;
    usize rlen;

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

static MalReactor *conn_reactor(MalHttpConn *c) {
    return &mal_host(c->vm)->reactor;
}

static bool conn_arm_read(MalHttpConn *c);
static bool conn_arm_write(MalHttpConn *c);
static void conn_process(MalHttpConn *c);

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
    MalHttpWireWrite *write = c->write_head;
    while (write != nullptr) {
        MalHttpWireWrite *next = write->next;
        free(write->bytes);
        free(write);
        write = next;
    }
    MalHttpResponseCompleteCallback response_callback = c->response_callback;
    void *response_data = c->response_data;
    free(c);
    if (response_callback != nullptr) response_callback(response_data, false);
    if (server->closing && server->connection_count == 0) {
        server_finish_close(server);
    }
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
    if (was_empty && !c->write_op.active && !conn_arm_write(c)) {
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

static void conn_send_error(MalHttpConn *c, int status, const char *reason) {
    c->keep_alive = false;
    mal_http_conn_respond(c, status, reason, nullptr, 0, reason, strlen(reason));
}

/* Try to handle one complete request currently buffered in rbuf. */
static void conn_process(MalHttpConn *c) {
    MalHttpRequest req;
    usize consumed;
    MalHttpParse p = mal_http_parse_request(c->rbuf, c->rlen, &req, &consumed);

    if (p == MAL_HTTP_INCOMPLETE) {
        if (c->read_ended) {
            conn_close(c);
            return;
        }
        if (c->rlen > MAL_HTTP_HEADERS_MAX) {
            conn_send_error(c, 431, "Request Header Fields Too Large");
            return;
        }
        if (!conn_arm_read(c)) {
            conn_close(c);
        }
        return;
    }
    if (p == MAL_HTTP_ERROR) {
        conn_send_error(c, 400, "Bad Request");
        return;
    }

    // Determine the body extent: Content-Length, or decode a chunked body in place.
    // body_len = decoded body length at rbuf+consumed; need = raw bytes this request
    // occupies (headers + framed body).
    usize body_len;
    usize need;
    if (req.chunked) {
        usize decoded;
        usize raw;
        MalHttpParse dp =
            mal_http_dechunk(c->rbuf + consumed, c->rlen - consumed, &decoded, &raw);
        if (dp == MAL_HTTP_INCOMPLETE) {
            if (c->read_ended) {
                conn_close(c);
                return;
            }
            if (!conn_arm_read(c)) {
                conn_close(c);
            }
            return;
        }
        if (dp == MAL_HTTP_ERROR) {
            conn_send_error(c, 400, "Bad Request");
            return;
        }
        body_len = decoded;
        need = consumed + raw;
    } else {
        usize content_length = req.content_length > 0 ? (usize) req.content_length : 0;
        if (c->rlen < consumed + content_length) {
            if (c->read_ended) {
                conn_close(c);
                return;
            }
            if (!conn_arm_read(c)) { // wait for the rest of the body
                conn_close(c);
            }
            return;
        }
        body_len = content_length;
        need = consumed + content_length;
    }

    c->keep_alive = req.keep_alive && !c->read_ended;

    // Dispatch using behavior captured by this server when it started.
    c->awaiting_response = true;
    c->in_handler = true;
    if (c->server->request_behavior == MAL_HTTP_REQUEST_HANDLER) {
        c->server->handler(c->vm, c, &req, c->rbuf + consumed, body_len);
    } else if (c->server->request_behavior == MAL_HTTP_REQUEST_SERVER_HANDLER) {
        c->server->server_handler(
            c->server->handler_data, c->vm, c, &req,
            c->rbuf + consumed, body_len);
    } else if (c->server->request_behavior == MAL_HTTP_REQUEST_FIXED) {
        char msg[512];
        int n = snprintf(
            msg,
            sizeof(msg),
            "Maligator: %.*s %.*s\n",
            (int) req.method_len,
            req.method,
            (int) req.target_len,
            req.target);
        mal_http_conn_respond(c, 200, "OK", nullptr, 0, msg, n > 0 ? (usize) n : 0);
    } else {
        c->in_handler = false;
        conn_close(c);
        return;
    }
    c->in_handler = false;
    if (c->close_pending) {
        conn_close(c);
        return;
    }

    // Consume this request; leftover is a pipelined follow-up handled after the
    // write completes.
    usize leftover = c->rlen - need;
    memmove(c->rbuf, c->rbuf + need, leftover);
    c->rlen = leftover;
    if (!c->read_ended && !c->read_op.active && !conn_arm_read(c)) conn_close(c);
}

static void conn_read_cb(void *data) {
    MalHttpConn *c = data;

    // Drain the socket (one-shot op fired: read until EAGAIN).
    for (;;) {
        if (c->rlen == c->rcap) {
            if ((c->awaiting_response || c->response_started)
                && c->rcap >= MAL_HTTP_HEADERS_MAX) {
                conn_close(c);
                return;
            }
            usize ncap = c->rcap * 2;
            if ((c->awaiting_response || c->response_started)
                && ncap > MAL_HTTP_HEADERS_MAX) {
                ncap = MAL_HTTP_HEADERS_MAX;
            }
            char *nbuf = realloc(c->rbuf, ncap);
            if (nbuf == nullptr) {
                conn_close(c);
                return;
            }
            c->rbuf = nbuf;
            c->rcap = ncap;
        }
        ssize_t n = read(c->fd, c->rbuf + c->rlen, c->rcap - c->rlen);
        if (n > 0) {
            c->rlen += (usize) n;
            continue;
        }
        if (n == 0) { // peer finished its request side
            c->read_ended = true;
            c->keep_alive = false;
            break;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            break;
        }
        conn_close(c);
        return;
    }

    if (c->awaiting_response || c->response_started) {
        if (!c->read_ended && !conn_arm_read(c)) conn_close(c);
        return;
    }
    conn_process(c);
}

static void conn_write_cb(void *data) {
    MalHttpConn *c = data;
    usize turn = 0;
    while (c->write_head != nullptr && turn < MAL_HTTP_WRITE_TURN) {
        MalHttpWireWrite *write = c->write_head;
        byte *bytes;
        usize available;
        bool data = false;
        bool plain = false;
        if (write->prefix_offset < write->prefix_length) {
            bytes = write->prefix + write->prefix_offset;
            available = write->prefix_length - write->prefix_offset;
        } else if (write->offset < write->length) {
            bytes = write->bytes + write->offset;
            available = write->length - write->offset;
            data = true;
            plain = write->plain_length > 0;
        } else if (write->suffix_offset < write->suffix_length) {
            bytes = write->suffix + write->suffix_offset;
            available = write->suffix_length - write->suffix_offset;
        } else {
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
            MalHttpResponseCompleteCallback response_callback = c->response_callback;
            void *response_data = c->response_data;
            c->response_callback = nullptr;
            c->response_data = nullptr;
            c->write_callback = nullptr;
            c->write_data = nullptr;
            if (response_callback != nullptr) response_callback(response_data, true);
            if (!c->keep_alive || c->server->closing) {
                conn_close(c);
                return;
            }
            if (c->rlen > 0) {
                (void) mal_reactor_cancel_op(conn_reactor(c), &c->read_op);
                conn_process(c);
            } else if (!c->read_op.active && !conn_arm_read(c)) {
                conn_close(c);
            }
            return;
        }
        usize allowed = MAL_HTTP_WRITE_TURN - turn;
        if (available > allowed) available = allowed;
        ssize_t n = mal_net_write(c->fd, bytes, available);
        if (n > 0) {
            usize count = (usize) n;
            turn += count;
            if (write->prefix_offset < write->prefix_length) {
                write->prefix_offset += count;
            } else if (data) {
                write->offset += count;
                if (plain) c->queued_plain_bytes -= count;
            } else {
                write->suffix_offset += count;
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
    if (c->write_head != nullptr && !conn_arm_write(c)) conn_close(c);
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
        c->next = server->connections;
        server->connections = c;
        server->connection_count++;
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
    MalHttpRequestBehavior request_behavior, MalHttpHandler handler,
    MalHttpServerHandler server_handler, void *handler_data) {
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
    server->request_behavior = request_behavior;
    server->handler = handler;
    server->server_handler = server_handler;
    server->handler_data = handler_data;
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

MalHttpServer *mal_http_server_start(MalVm *vm, const char *host, u16 port) {
    MalHttpHandler handler = mal_http_handler;
    return server_start(
        vm, host, port,
        handler == nullptr ? MAL_HTTP_REQUEST_FIXED : MAL_HTTP_REQUEST_HANDLER,
        handler, nullptr, nullptr);
}

MalHttpServer *mal_http_server_start_unhandled(
    MalVm *vm, const char *host, u16 port) {
    return server_start(
        vm, host, port, MAL_HTTP_REQUEST_CLOSE, nullptr, nullptr, nullptr);
}

MalHttpServer *mal_http_server_start_handler(
    MalVm *vm,
    const char *host,
    u16 port,
    MalHttpServerHandler handler,
    void *data) {
    if (handler == nullptr) return nullptr;
    return server_start(
        vm, host, port, MAL_HTTP_REQUEST_SERVER_HANDLER, nullptr, handler, data);
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
            && !conn->response_started) {
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

void mal_http_server_stop(MalHttpServer *server) {
    mal_http_server_close(server, nullptr, nullptr);
}
