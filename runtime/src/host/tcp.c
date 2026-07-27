#include "tcp.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>

#include "host.h"
#include "mal_tls.h"
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
    MalTlsClient *tls;
    byte *tls_ciphertext;
    usize tls_ciphertext_length;
    usize tls_ciphertext_offset;
    usize queued_write_bytes;
    bool connecting;
    bool tls_connected_reported;
    bool read_paused;
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
    mal_tls_client_free(&connection->tls);
    free(connection->tls_ciphertext);
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
        if (connection->tls != nullptr) {
            usize consumed = 0;
            int status = mal_tls_client_read_ciphertext(
                connection->tls, bytes, (usize) count, &consumed);
            free(bytes);
            if (status != MAL_TLS_STATUS_OK || consumed != (usize) count) {
                tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, EPROTO);
                return;
            }
            if (!connection->tls_connected_reported
                && mal_tls_client_is_handshaking(connection->tls) == 0) {
                MalTcpProgress *secure = calloc(1, sizeof(MalTcpProgress));
                if (secure == nullptr) {
                    tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, ENOMEM);
                    return;
                }
                secure->kind = MAL_TCP_SECURE_CONNECTED;
                connection->tls_connected_reported = true;
                if (!tcp_progress(connection, secure)) {
                    tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, ENOMEM);
                    return;
                }
            }
            for (;;) {
                byte *plain = malloc(MAL_TCP_IO_TURN);
                if (plain == nullptr) {
                    tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, ENOMEM);
                    return;
                }
                usize produced = 0;
                status = mal_tls_client_read_plaintext(
                    connection->tls, plain, MAL_TCP_IO_TURN, &produced);
                if (status != MAL_TLS_STATUS_OK) {
                    free(plain);
                    tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, EPROTO);
                    return;
                }
                if (produced == 0) {
                    free(plain);
                    break;
                }
                MalTcpProgress *progress = calloc(1, sizeof(MalTcpProgress));
                if (progress == nullptr) {
                    free(plain);
                    tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, ENOMEM);
                    return;
                }
                progress->kind = MAL_TCP_DATA;
                progress->bytes = plain;
                progress->length = produced;
                if (!tcp_progress(connection, progress)) {
                    tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, ENOMEM);
                    return;
                }
            }
            if (!tcp_flush(connection)
                || (!connection->read_paused && !tcp_arm_read(connection))) {
                tcp_complete(connection, MAL_HOST_TERMINAL_ERROR,
                    errno == 0 ? EPROTO : errno);
            }
            return;
        }
        MalTcpProgress *progress = calloc(1, sizeof(MalTcpProgress));
        if (progress == nullptr) {
            free(bytes);
            tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, ENOMEM);
            return;
        }
        progress->kind = MAL_TCP_DATA;
        progress->bytes = bytes;
        progress->length = (usize) count;
        if (!tcp_progress(connection, progress)
            || (!connection->read_paused && !tcp_arm_read(connection))) {
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
    if (connection->read_paused) return true;
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
        if (!tcp_progress(connection, progress)
            || (!connection->read_paused && !tcp_arm_read(connection))) {
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

static bool tcp_finish_write(
    MalTcpConnection *connection, MalTcpWrite *write) {
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
    return true;
}

static bool tcp_flush_raw(MalTcpConnection *connection) {
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
            if (!tcp_finish_write(connection, write)) return false;
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

static bool tcp_tls_fill_ciphertext(MalTcpConnection *connection) {
    if (connection->tls_ciphertext != nullptr
        || mal_tls_client_wants_write(connection->tls) <= 0) {
        return true;
    }
    byte *bytes = malloc(MAL_TCP_IO_TURN);
    if (bytes == nullptr) {
        errno = ENOMEM;
        return false;
    }
    usize produced = 0;
    if (mal_tls_client_write_ciphertext(
            connection->tls, bytes, MAL_TCP_IO_TURN, &produced)
        != MAL_TLS_STATUS_OK) {
        free(bytes);
        errno = EPROTO;
        return false;
    }
    if (produced == 0) {
        free(bytes);
        return true;
    }
    connection->tls_ciphertext = bytes;
    connection->tls_ciphertext_length = produced;
    connection->tls_ciphertext_offset = 0;
    return true;
}

static bool tcp_flush_tls(MalTcpConnection *connection) {
    usize turn = 0;
    while (turn < MAL_TCP_IO_TURN) {
        if (!tcp_tls_fill_ciphertext(connection)) return false;
        if (connection->tls_ciphertext != nullptr) {
            usize available = connection->tls_ciphertext_length
                - connection->tls_ciphertext_offset;
            usize allowed = MAL_TCP_IO_TURN - turn;
            if (available > allowed) available = allowed;
            ssize_t count = mal_net_write(connection->fd,
                connection->tls_ciphertext + connection->tls_ciphertext_offset,
                available);
            if (count > 0) {
                connection->tls_ciphertext_offset += (usize) count;
                turn += (usize) count;
                if (connection->tls_ciphertext_offset
                    == connection->tls_ciphertext_length) {
                    free(connection->tls_ciphertext);
                    connection->tls_ciphertext = nullptr;
                    connection->tls_ciphertext_length = 0;
                    connection->tls_ciphertext_offset = 0;
                }
                continue;
            }
            if (count < 0 && errno == EINTR) continue;
            if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                return connection->write_op.active || tcp_arm_write(connection);
            }
            return false;
        }
        if (mal_tls_client_is_handshaking(connection->tls) != 0) return true;
        MalTcpWrite *write = connection->write_head;
        if (write == nullptr) break;
        if (write->offset == write->length) {
            if (!tcp_finish_write(connection, write)) return false;
            continue;
        }
        usize consumed = 0;
        if (mal_tls_client_write_plaintext(connection->tls,
                write->bytes + write->offset, write->length - write->offset,
                &consumed) != MAL_TLS_STATUS_OK || consumed == 0) {
            errno = EPROTO;
            return false;
        }
        write->offset += consumed;
        connection->queued_write_bytes -= consumed;
    }
    if (connection->tls_ciphertext != nullptr
        || mal_tls_client_wants_write(connection->tls) > 0
        || (connection->write_head != nullptr
            && mal_tls_client_is_handshaking(connection->tls) == 0)) {
        return connection->write_op.active || tcp_arm_write(connection);
    }
    if (connection->shutdown_requested && shutdown(connection->fd, SHUT_WR) != 0
        && errno != ENOTCONN) {
        return false;
    }
    return true;
}

static bool tcp_flush(MalTcpConnection *connection) {
    return connection->tls == nullptr
        ? tcp_flush_raw(connection) : tcp_flush_tls(connection);
}

bool mal_tcp_connect_address_start(
    MalHost *host, const struct sockaddr *address, socklen_t length,
    MalHostHandle *operation) {
    if (host == nullptr || address == nullptr || operation == nullptr
        || !mal_host_operation_start(&host->tasks, operation)) {
        return false;
    }
    MalTcpConnection *connection = calloc(1, sizeof(MalTcpConnection));
    if (connection == nullptr) goto fail;
    connection->host = host;
    connection->operation = *operation;
    connection->fd = mal_net_connect_address(address, length);
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

bool mal_tcp_connect_start(
    MalHost *host, const char *numeric_host, u16 port,
    MalHostHandle *operation) {
    struct sockaddr_storage address;
    socklen_t length;
    return numeric_host != nullptr
        && mal_net_parse_ip(numeric_host, port, &address, &length)
        && mal_tcp_connect_address_start(
            host, (const struct sockaddr *) &address, length, operation);
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

bool mal_tcp_read_pause(MalHost *host, MalHostHandle operation) {
    MalTcpConnection *connection = host == nullptr ? nullptr : tcp_find(host, operation);
    if (connection == nullptr) return false;
    connection->read_paused = true;
    return mal_reactor_cancel_op(&connection->host->reactor, &connection->read_op);
}

bool mal_tcp_read_resume(MalHost *host, MalHostHandle operation) {
    MalTcpConnection *connection = host == nullptr ? nullptr : tcp_find(host, operation);
    if (connection == nullptr) return false;
    connection->read_paused = false;
    return connection->connecting || connection->read_op.active
        || tcp_arm_read(connection);
}

bool mal_tcp_set_keep_alive(
    MalHost *host, MalHostHandle operation, bool enabled, u32 initial_delay_ms) {
    MalTcpConnection *connection = host == nullptr ? nullptr : tcp_find(host, operation);
    if (connection == nullptr) return false;
    int value = enabled ? 1 : 0;
    if (setsockopt(connection->fd, SOL_SOCKET, SO_KEEPALIVE,
            &value, sizeof(value)) != 0) {
        return false;
    }
    if (!enabled || initial_delay_ms == 0) return true;
    int seconds = (int) ((initial_delay_ms + 999) / 1000);
#if defined(TCP_KEEPALIVE)
    return setsockopt(connection->fd, IPPROTO_TCP, TCP_KEEPALIVE,
        &seconds, sizeof(seconds)) == 0;
#elif defined(TCP_KEEPIDLE)
    return setsockopt(connection->fd, IPPROTO_TCP, TCP_KEEPIDLE,
        &seconds, sizeof(seconds)) == 0;
#else
    return true;
#endif
}

bool mal_tcp_set_no_delay(MalHost *host, MalHostHandle operation, bool enabled) {
    MalTcpConnection *connection = host == nullptr ? nullptr : tcp_find(host, operation);
    if (connection == nullptr) return false;
    int value = enabled ? 1 : 0;
    return setsockopt(connection->fd, IPPROTO_TCP, TCP_NODELAY,
        &value, sizeof(value)) == 0;
}

bool mal_tcp_start_tls(
    MalHost *host, MalHostHandle operation,
    const byte *server_name, usize server_name_length,
    const byte *ca_pem, usize ca_pem_length,
    const byte *alpn, usize alpn_length, bool insecure) {
    MalTcpConnection *connection = host == nullptr ? nullptr : tcp_find(host, operation);
    if (connection == nullptr || connection->connecting || connection->tls != nullptr
        || server_name == nullptr || server_name_length == 0) {
        return false;
    }
    if (mal_tls_client_create(server_name, server_name_length,
            ca_pem, ca_pem_length, alpn, alpn_length,
            insecure ? 1 : 0, &connection->tls) != MAL_TLS_STATUS_OK) {
        return false;
    }
    if (!tcp_flush(connection)) {
        tcp_complete(connection, MAL_HOST_TERMINAL_ERROR,
            errno == 0 ? EPROTO : errno);
        return false;
    }
    return true;
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
