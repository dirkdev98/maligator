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

typedef struct MalHttpConn {
    MalVm *vm;
    int fd;
    MalOp read_op;
    MalOp write_op;

    char *rbuf; // inbound bytes (request line + headers + body), growable
    usize rcap;
    usize rlen;

    char *wbuf; // the response currently being written
    usize wlen;
    usize wsent;

    bool keep_alive;
    bool awaiting_response;
    bool in_handler;
    bool close_pending;
    MalHttpResponseCompleteCallback response_callback;
    void *response_data;
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
    free(c->wbuf);
    MalHttpResponseCompleteCallback response_callback = c->response_callback;
    void *response_data = c->response_data;
    free(c);
    if (response_callback != nullptr) response_callback(response_data);
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

/* Queue a response with the given status + body bytes; caller sets c->keep_alive
 * first. Public: the runtime's fetch hook calls this with the Response bytes. */
void mal_http_conn_respond_framed(
    MalHttpConn *c,
    int status,
    const char *reason,
    const char *headers,
    usize headers_len,
    const char *body,
    usize body_len,
    i64 declared_content_length) {
    static const char default_ct[] = "Content-Type: text/plain; charset=utf-8\r\n";

    char status_line[128];
    int status_len = snprintf(status_line, sizeof(status_line), "HTTP/1.1 %d %s\r\n", status, reason);
    char framing[128];
    bool keep_alive = c->keep_alive && !c->server->closing;
    int framing_len = declared_content_length < 0
        ? snprintf(framing, sizeof(framing), "Connection: %s\r\n\r\n",
                   keep_alive ? "keep-alive" : "close")
        : snprintf(
            framing, sizeof(framing),
            "Content-Length: %lld\r\nConnection: %s\r\n\r\n",
            (long long) declared_content_length,
            keep_alive ? "keep-alive" : "close");
    if (status_len < 0 || framing_len < 0) {
        conn_close(c);
        return;
    }

    // Header block: the runtime's serialized Headers, or a default Content-Type.
    const char *hdr = headers != nullptr ? headers : default_ct;
    usize hdr_len = headers != nullptr ? headers_len : (sizeof(default_ct) - 1);

    free(c->wbuf);
    c->wlen = (usize) status_len + hdr_len + (usize) framing_len + body_len;
    c->wbuf = malloc(c->wlen);
    if (c->wbuf == nullptr) {
        conn_close(c);
        return;
    }
    usize o = 0;
    memcpy(c->wbuf + o, status_line, (usize) status_len);
    o += (usize) status_len;
    memcpy(c->wbuf + o, hdr, hdr_len);
    o += hdr_len;
    memcpy(c->wbuf + o, framing, (usize) framing_len);
    o += (usize) framing_len;
    if (body_len > 0) {
        memcpy(c->wbuf + o, body, body_len);
    }
    c->wsent = 0;
    c->awaiting_response = false;
    if (!conn_arm_write(c)) {
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
            if (!conn_arm_read(c)) { // wait for the rest of the body
                conn_close(c);
            }
            return;
        }
        body_len = content_length;
        need = consumed + content_length;
    }

    c->keep_alive = req.keep_alive;

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
}

static void conn_read_cb(void *data) {
    MalHttpConn *c = data;

    // Drain the socket (one-shot op fired: read until EAGAIN).
    for (;;) {
        if (c->rlen == c->rcap) {
            usize ncap = c->rcap * 2;
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
        if (n == 0) { // peer closed
            conn_close(c);
            return;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            break;
        }
        conn_close(c);
        return;
    }

    conn_process(c);
}

static void conn_write_cb(void *data) {
    MalHttpConn *c = data;

    while (c->wsent < c->wlen) {
        ssize_t n = write(c->fd, c->wbuf + c->wsent, c->wlen - c->wsent);
        if (n > 0) {
            c->wsent += (usize) n;
            continue;
        }
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            if (!conn_arm_write(c)) { // socket buffer full: finish later
                conn_close(c);
            }
            return;
        }
        conn_close(c);
        return;
    }

    // Response fully written.
    free(c->wbuf);
    c->wbuf = nullptr;
    c->wlen = 0;
    c->wsent = 0;
    MalHttpResponseCompleteCallback response_callback = c->response_callback;
    void *response_data = c->response_data;
    c->response_callback = nullptr;
    c->response_data = nullptr;
    if (response_callback != nullptr) response_callback(response_data);
    if (!c->keep_alive || c->server->closing) {
        conn_close(c);
        return;
    }
    // Keep-alive: handle a pipelined request if already buffered, else read more.
    if (c->rlen > 0) {
        conn_process(c);
    } else {
        if (!conn_arm_read(c)) {
            conn_close(c);
        }
    }
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
        if (!conn->awaiting_response && conn->wbuf == nullptr) {
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
