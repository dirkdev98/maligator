#include "tcp.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include "host.h"
#include "net.h"
#include "reactor.h"

#define MAL_TCP_IO_TURN (64 * 1024)
#define MAL_TCP_WRITE_MAX (256 * 1024)

typedef struct MalTcpWrite {
    byte *bytes;
    usize length;
    usize offset;
    u64 token;
    struct MalTcpWrite *next;
} MalTcpWrite;

typedef struct MalTcpConnection {
    MalHost *host;
    MalHostHandle operation;
    int fd;
    MalOp read_op;
    MalOp write_op;
    MalTcpWrite *write_head;
    MalTcpWrite *write_tail;
    usize queued_write_bytes;
    bool connecting;
    bool shutdown_requested;
    struct MalTcpConnection *next;
} MalTcpConnection;

void mal_tcp_progress_free(void *data) {
    MalTcpProgress *progress = data;
    if (progress == nullptr) return;
    free(progress->bytes);
    free(progress);
}

void mal_tcp_terminal_free(void *data) {
    free(data);
}

static MalTcpConnection *tcp_find(MalHost *host, MalHostHandle operation) {
    for (MalTcpConnection *connection = host->tcp_connections;
         connection != nullptr; connection = connection->next) {
        if (connection->operation == operation) return connection;
    }
    return nullptr;
}

static void tcp_destroy(MalTcpConnection *connection) {
    MalTcpConnection **link = &connection->host->tcp_connections;
    while (*link != nullptr && *link != connection) link = &(*link)->next;
    if (*link == connection) *link = connection->next;
    (void) mal_reactor_cancel_op(&connection->host->reactor, &connection->read_op);
    (void) mal_reactor_cancel_op(&connection->host->reactor, &connection->write_op);
    mal_net_close(connection->fd);
    MalTcpWrite *write = connection->write_head;
    while (write != nullptr) {
        MalTcpWrite *next = write->next;
        free(write->bytes);
        free(write);
        write = next;
    }
    free(connection);
}

static void tcp_complete(
    MalTcpConnection *connection, MalHostTerminalResult result, int error) {
    MalTcpTerminal *terminal = malloc(sizeof(MalTcpTerminal));
    if (terminal != nullptr) terminal->error = error;
    if (!mal_host_operation_complete(
            &connection->host->tasks, connection->operation, result,
            terminal, mal_tcp_terminal_free)) {
        free(terminal);
    }
    tcp_destroy(connection);
}

static bool tcp_progress(MalTcpConnection *connection, MalTcpProgress *progress) {
    if (mal_host_operation_progress(
            &connection->host->tasks, connection->operation, progress,
            mal_tcp_progress_free)) {
        return true;
    }
    mal_tcp_progress_free(progress);
    return false;
}

static bool tcp_arm_read(MalTcpConnection *connection);
static bool tcp_flush(MalTcpConnection *connection);

static void tcp_read_ready(void *data) {
    MalTcpConnection *connection = data;
    byte *bytes = malloc(MAL_TCP_IO_TURN);
    if (bytes == nullptr) {
        tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, ENOMEM);
        return;
    }
    ssize_t count;
    do {
        count = read(connection->fd, bytes, MAL_TCP_IO_TURN);
    } while (count < 0 && errno == EINTR);
    if (count > 0) {
        MalTcpProgress *progress = calloc(1, sizeof(MalTcpProgress));
        if (progress == nullptr) {
            free(bytes);
            tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, ENOMEM);
            return;
        }
        progress->kind = MAL_TCP_DATA;
        progress->bytes = bytes;
        progress->length = (usize) count;
        if (!tcp_progress(connection, progress) || !tcp_arm_read(connection)) {
            tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, ENOMEM);
        }
        return;
    }
    free(bytes);
    if (count == 0) {
        tcp_complete(connection, MAL_HOST_TERMINAL_OK, 0);
        return;
    }
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
        if (!tcp_arm_read(connection)) {
            tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, errno);
        }
        return;
    }
    tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, errno);
}

static bool tcp_arm_read(MalTcpConnection *connection) {
    connection->read_op = (MalOp) {
        .fd = connection->fd,
        .interest = MAL_IO_READ,
        .waker = {.fn = tcp_read_ready, .data = connection},
    };
    return mal_reactor_add_op(&connection->host->reactor, &connection->read_op);
}

static void tcp_write_ready(void *data) {
    MalTcpConnection *connection = data;
    if (connection->connecting) {
        int error = mal_net_socket_error(connection->fd);
        if (error != 0) {
            tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, error);
            return;
        }
        connection->connecting = false;
        MalTcpProgress *progress = calloc(1, sizeof(MalTcpProgress));
        if (progress == nullptr) {
            tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, ENOMEM);
            return;
        }
        progress->kind = MAL_TCP_CONNECTED;
        if (!tcp_progress(connection, progress) || !tcp_arm_read(connection)) {
            tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, ENOMEM);
            return;
        }
    }
    if (!tcp_flush(connection)) {
        tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, errno == 0 ? EIO : errno);
    }
}

static bool tcp_arm_write(MalTcpConnection *connection) {
    connection->write_op = (MalOp) {
        .fd = connection->fd,
        .interest = MAL_IO_WRITE,
        .waker = {.fn = tcp_write_ready, .data = connection},
    };
    return mal_reactor_add_op(&connection->host->reactor, &connection->write_op);
}

static bool tcp_flush(MalTcpConnection *connection) {
    usize turn = 0;
    while (connection->write_head != nullptr && turn < MAL_TCP_IO_TURN) {
        MalTcpWrite *write = connection->write_head;
        usize available = write->length - write->offset;
        usize allowed = MAL_TCP_IO_TURN - turn;
        if (available > allowed) available = allowed;
        ssize_t count = mal_net_write(
            connection->fd, write->bytes + write->offset, available);
        if (count > 0) {
            write->offset += (usize) count;
            turn += (usize) count;
            connection->queued_write_bytes -= (usize) count;
            if (write->offset != write->length) continue;
            connection->write_head = write->next;
            if (connection->write_head == nullptr) connection->write_tail = nullptr;
            MalTcpProgress *progress = calloc(1, sizeof(MalTcpProgress));
            if (progress == nullptr) {
                free(write->bytes);
                free(write);
                errno = ENOMEM;
                return false;
            }
            progress->kind = MAL_TCP_WRITE_COMPLETE;
            progress->write_token = write->token;
            free(write->bytes);
            free(write);
            if (!tcp_progress(connection, progress)) {
                errno = ENOMEM;
                return false;
            }
            continue;
        }
        if (count < 0 && errno == EINTR) continue;
        if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            return tcp_arm_write(connection);
        }
        return false;
    }
    if (connection->write_head != nullptr) return tcp_arm_write(connection);
    if (connection->shutdown_requested && shutdown(connection->fd, SHUT_WR) != 0
        && errno != ENOTCONN) {
        return false;
    }
    return true;
}

bool mal_tcp_connect_start(
    MalHost *host, const char *numeric_host, u16 port,
    MalHostHandle *operation) {
    if (host == nullptr || numeric_host == nullptr || operation == nullptr
        || !mal_host_operation_start(&host->tasks, operation)) {
        return false;
    }
    MalTcpConnection *connection = calloc(1, sizeof(MalTcpConnection));
    if (connection == nullptr) goto fail;
    connection->host = host;
    connection->operation = *operation;
    connection->fd = mal_net_connect(numeric_host, port);
    if (connection->fd < 0) goto fail_connection;
    connection->connecting = true;
    if (!tcp_arm_write(connection)
        || !mal_host_operation_activate(&host->tasks, *operation)) {
        goto fail_connection;
    }
    connection->next = host->tcp_connections;
    host->tcp_connections = connection;
    return true;

fail_connection:
    tcp_destroy(connection);
fail:
    (void) mal_host_operation_abort_start(&host->tasks, *operation);
    return false;
}

bool mal_tcp_write_owned(
    MalHost *host, MalHostHandle operation, byte *bytes, usize length,
    u64 write_token) {
    MalTcpConnection *connection = host == nullptr ? nullptr : tcp_find(host, operation);
    if (connection == nullptr || bytes == nullptr || length == 0
        || length > MAL_TCP_WRITE_MAX - connection->queued_write_bytes) {
        return false;
    }
    MalTcpWrite *write = calloc(1, sizeof(MalTcpWrite));
    if (write == nullptr) return false;
    write->bytes = bytes;
    write->length = length;
    write->token = write_token;
    if (connection->write_tail == nullptr) connection->write_head = write;
    else connection->write_tail->next = write;
    connection->write_tail = write;
    connection->queued_write_bytes += length;
    if (!connection->connecting && !connection->write_op.active
        && !tcp_flush(connection)) {
        tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, errno == 0 ? EIO : errno);
    }
    return true;
}

bool mal_tcp_shutdown_write(MalHost *host, MalHostHandle operation) {
    MalTcpConnection *connection = host == nullptr ? nullptr : tcp_find(host, operation);
    if (connection == nullptr) return false;
    connection->shutdown_requested = true;
    return connection->connecting || connection->write_head != nullptr
        || shutdown(connection->fd, SHUT_WR) == 0 || errno == ENOTCONN;
}

bool mal_tcp_cancel(MalHost *host, MalHostHandle operation) {
    if (host == nullptr) return false;
    MalTcpConnection *connection = tcp_find(host, operation);
    if (connection != nullptr) {
        if (!mal_host_operation_cancel(&host->tasks, operation)) return false;
        tcp_destroy(connection);
        return true;
    }
    return mal_host_operation_cancel(&host->tasks, operation);
}

void mal_tcp_shutdown(MalHost *host) {
    if (host == nullptr) return;
    while (host->tcp_connections != nullptr) {
        MalTcpConnection *connection = host->tcp_connections;
        (void) mal_host_operation_cancel(&host->tasks, connection->operation);
        tcp_destroy(connection);
    }
}
