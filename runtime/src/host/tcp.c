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
#include "posix_fs.h"
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
    MalTlsAcceptor *tls_acceptor;
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
    if (host == nullptr || operation == 0) return nullptr;
    return mal_host_operation_owner(&host->tasks, operation);
}

static void tcp_destroy(MalTcpConnection *connection) {
    mal_host_operation_unbind(
        &connection->host->tasks, connection->operation, connection);
    MalTcpConnection **link = &connection->host->tcp_connections;
    while (*link != nullptr && *link != connection) link = &(*link)->next;
    if (*link == connection) *link = connection->next;
    (void) mal_reactor_cancel_op(&connection->host->reactor, &connection->read_op);
    (void) mal_reactor_cancel_op(&connection->host->reactor, &connection->write_op);
    mal_net_close(connection->fd);
#if MAL_NODE
    mal_tls_client_free(&connection->tls);
    mal_tls_acceptor_free(&connection->tls_acceptor);
#endif
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
    if (terminal != nullptr) {
        terminal->error = error;
        terminal->tls_failure[0] = '\0';
#if MAL_NODE
        if (error == EPROTO && connection->tls != nullptr) {
            intptr_t length = mal_tls_session_info(connection->tls, MAL_TLS_INFO_FAILURE,
                (uint8_t *) terminal->tls_failure, sizeof(terminal->tls_failure) - 1);
            terminal->tls_failure[length > 0 && (usize) length < sizeof(terminal->tls_failure) ? length : 0] = '\0';
        }
#endif
    }
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

#if MAL_NODE
/* Best effort: the peer learns why the handshake failed instead of seeing a bare close. */
static void tcp_tls_send_alert(MalTcpConnection *connection) {
    byte alert[512];
    usize produced = 0;
    if (connection->tls_ciphertext != nullptr
        || mal_tls_client_write_ciphertext(connection->tls, alert, sizeof(alert), &produced)
            != MAL_TLS_STATUS_OK) {
        return;
    }
    if (produced > 0) (void) mal_net_write(connection->fd, alert, produced);
}
#endif

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
#if MAL_NODE
        if (connection->tls_acceptor != nullptr) {
            int status = mal_tls_acceptor_read(connection->tls_acceptor, bytes, (usize) count);
            free(bytes);
            if (status != MAL_TLS_STATUS_OK) {
                tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, EPROTO);
                return;
            }
            byte name[256];
            intptr_t length = mal_tls_acceptor_server_name(connection->tls_acceptor, name, sizeof(name));
            if (length == -2) {
                if (!connection->read_paused && !tcp_arm_read(connection)) {
                    tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, errno);
                }
                return;
            }
            MalTcpProgress *hello = calloc(1, sizeof(MalTcpProgress));
            if (hello != nullptr && length >= 0) {
                usize copied = (usize) length < sizeof(name) ? (usize) length : sizeof(name);
                hello->bytes = malloc(copied + 1);
                if (hello->bytes != nullptr) {
                    memcpy(hello->bytes, name, copied);
                    hello->length = copied;
                }
            }
            if (hello == nullptr || (length >= 0 && hello->bytes == nullptr)) {
                mal_tcp_progress_free(hello);
                tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, ENOMEM);
                return;
            }
            hello->kind = MAL_TCP_TLS_CLIENT_HELLO;
            // Reads stay off until mal_tcp_tls_select installs the session.
            if (!tcp_progress(connection, hello)) {
                tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, ENOMEM);
            }
            return;
        }
        if (connection->tls != nullptr) {
            usize consumed = 0;
            int status = mal_tls_client_read_ciphertext(
                connection->tls, bytes, (usize) count, &consumed);
            free(bytes);
            if (status != MAL_TLS_STATUS_OK || consumed != (usize) count) {
                tcp_tls_send_alert(connection);
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
#endif
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
#if MAL_NODE
        if ((connection->tls != nullptr || connection->tls_acceptor != nullptr)
            && !connection->tls_connected_reported) {
            tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, ECONNRESET);
            return;
        }
#endif
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

#if MAL_NODE
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
#endif

static bool tcp_flush(MalTcpConnection *connection) {
#if MAL_NODE
    // Writes queued while a ClientHello awaits its config must wait for the session.
    if (connection->tls_acceptor != nullptr) return true;
    return connection->tls == nullptr
        ? tcp_flush_raw(connection) : tcp_flush_tls(connection);
#else
    return tcp_flush_raw(connection);
#endif
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
    int connect_error = connection->fd < 0 ? errno : 0;
    connection->connecting = true;
    if (!mal_host_operation_bind(
            &host->tasks, *operation, connection)) {
        goto fail_connection;
    }
    if (connect_error != 0) {
        // A refused Unix path or unreachable route fails inside connect(); report it like a late failure.
        if (!mal_host_operation_activate(&host->tasks, *operation)) goto fail_connection;
        tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, connect_error);
        return true;
    }
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

int mal_tcp_tls_create_client(
    const byte *server_name, usize server_name_length,
    const byte *ca_pem, usize ca_pem_length,
    const byte *alpn, usize alpn_length, const MalTlsClientIdentity *identity, bool insecure,
    MalTlsClient **out) {
#if MAL_NODE
    static const MalTlsClientIdentity anonymous = {0};
    if (identity == nullptr) identity = &anonymous;
    if (insecure || ca_pem != nullptr) {
        return mal_tls_client_create((const uint8_t *)server_name, server_name_length,
            (const uint8_t *)ca_pem, ca_pem_length, (const uint8_t *)alpn, alpn_length,
            identity->cert_pem, identity->cert_pem_length,
            identity->key_pem, identity->key_pem_length, insecure ? 1 : 0, out);
    }
    static const char *bundles[] = {
        "/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt",
        "/etc/pki/tls/certs/ca-bundle.crt", "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
    };
    byte *roots = nullptr;
    usize roots_length = 0;
    for (usize i = 0; i < countof(bundles); i++) {
        if (mal_posix_fs_read_file(bundles[i], &roots, &roots_length) == 0) break;
    }
    const char *extra_path = getenv("NODE_EXTRA_CA_CERTS");
    if (extra_path != nullptr && extra_path[0] != '\0') {
        byte *extra = nullptr;
        usize extra_length = 0;
        if (mal_posix_fs_read_file(extra_path, &extra, &extra_length) != 0) {
            free(roots); return MAL_TLS_STATUS_ERROR;
        }
        MalTlsClient *validation = nullptr;
        int status = mal_tls_client_create((const uint8_t *)server_name, server_name_length,
            (const uint8_t *)extra, extra_length, nullptr, 0, nullptr, 0, nullptr, 0, 0, &validation);
        mal_tls_client_free(&validation);
        if (status != MAL_TLS_STATUS_OK || roots_length == SIZE_MAX || extra_length > SIZE_MAX - roots_length - 1) {
            free(extra); free(roots); return MAL_TLS_STATUS_ERROR;
        }
        byte *combined = realloc(roots, roots_length + extra_length + 1);
        if (combined == nullptr) { free(extra); free(roots); return MAL_TLS_STATUS_ERROR; }
        roots = combined;
        roots[roots_length++] = '\n';
        memcpy(roots + roots_length, extra, extra_length);
        roots_length += extra_length;
        free(extra);
    }
    int status = mal_tls_client_create((const uint8_t *)server_name, server_name_length,
        (const uint8_t *)roots, roots_length, (const uint8_t *)alpn, alpn_length,
        identity->cert_pem, identity->cert_pem_length,
        identity->key_pem, identity->key_pem_length, 0, out);
    free(roots);
    return status;
#else
    (void) server_name; (void) server_name_length; (void) ca_pem; (void) ca_pem_length;
    (void) alpn; (void) alpn_length; (void) identity; (void) insecure;
    if (out != nullptr) *out = nullptr;
    return -1;
#endif
}

#if MAL_NODE
static bool tcp_start_tls_session(
    MalHost *host, MalHostHandle operation, bool client,
    const byte *server_name, usize server_name_length,
    const byte *ca_pem, usize ca_pem_length,
    const byte *alpn, usize alpn_length, const MalTlsClientIdentity *identity, bool insecure,
    const MalTlsServerConfig *server_config) {
    MalTcpConnection *connection = host == nullptr ? nullptr : tcp_find(host, operation);
    if (connection == nullptr || connection->connecting || connection->tls != nullptr) {
        return false;
    }
    int status = client
        ? mal_tcp_tls_create_client(server_name, server_name_length,
            ca_pem, ca_pem_length, alpn, alpn_length, identity, insecure, &connection->tls)
        : mal_tls_server_create(server_config, &connection->tls);
    if (status != MAL_TLS_STATUS_OK) return false;
    if (!tcp_flush(connection)) {
        tcp_complete(connection, MAL_HOST_TERMINAL_ERROR,
            errno == 0 ? EPROTO : errno);
        return false;
    }
    return true;
}
#endif

bool mal_tcp_start_tls(
    MalHost *host, MalHostHandle operation,
    const byte *server_name, usize server_name_length,
    const byte *ca_pem, usize ca_pem_length,
    const byte *alpn, usize alpn_length, const MalTlsClientIdentity *identity, bool insecure) {
#if MAL_NODE
    if (server_name == nullptr || server_name_length == 0) return false;
    return tcp_start_tls_session(host, operation, true, server_name, server_name_length,
        ca_pem, ca_pem_length, alpn, alpn_length, identity, insecure, nullptr);
#else
    (void) host;
    (void) operation;
    (void) server_name;
    (void) server_name_length;
    (void) ca_pem;
    (void) ca_pem_length;
    (void) alpn;
    (void) alpn_length;
    (void) identity;
    (void) insecure;
    return false;
#endif
}

bool mal_tcp_start_tls_server(
    MalHost *host, MalHostHandle operation, const MalTlsServerConfig *config) {
#if MAL_NODE
    return config != nullptr && tcp_start_tls_session(host, operation, false,
        nullptr, 0, nullptr, 0, nullptr, 0, nullptr, false, config);
#else
    (void) host; (void) operation; (void) config;
    return false;
#endif
}

i64 mal_tcp_tls_peer_certificate(MalHost *host, MalHostHandle operation, byte *output, usize capacity) {
#if MAL_NODE
    MalTcpConnection *connection = host == nullptr ? nullptr : tcp_find(host, operation);
    if (connection == nullptr || connection->tls == nullptr) return -1;
    return mal_tls_session_peer_certificate(connection->tls, output, capacity);
#else
    (void) host; (void) operation; (void) output; (void) capacity;
    return -1;
#endif
}

bool mal_tcp_start_tls_server_sni(MalHost *host, MalHostHandle operation) {
#if MAL_NODE
    MalTcpConnection *connection = host == nullptr ? nullptr : tcp_find(host, operation);
    if (connection == nullptr || connection->connecting || connection->tls != nullptr
        || connection->tls_acceptor != nullptr) {
        return false;
    }
    return mal_tls_acceptor_create(&connection->tls_acceptor) == MAL_TLS_STATUS_OK;
#else
    (void) host; (void) operation;
    return false;
#endif
}

bool mal_tcp_tls_select(MalHost *host, MalHostHandle operation, const MalTlsServerConfig *config) {
#if MAL_NODE
    MalTcpConnection *connection = host == nullptr ? nullptr : tcp_find(host, operation);
    if (connection == nullptr || connection->tls_acceptor == nullptr) return false;
    int status = config == nullptr ? MAL_TLS_STATUS_INVALID_ARGUMENT
        : mal_tls_acceptor_accept(connection->tls_acceptor, config, &connection->tls);
    mal_tls_acceptor_free(&connection->tls_acceptor);
    if (status != MAL_TLS_STATUS_OK) {
        tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, EPROTO);
        return false;
    }
    if (!tcp_flush(connection)
        || (!connection->read_paused && !tcp_arm_read(connection))) {
        tcp_complete(connection, MAL_HOST_TERMINAL_ERROR, errno == 0 ? EPROTO : errno);
        return false;
    }
    return true;
#else
    (void) host; (void) operation; (void) config;
    return false;
#endif
}

i64 mal_tcp_tls_info(
    MalHost *host, MalHostHandle operation, int kind, byte *output, usize output_length) {
#if MAL_NODE
    MalTcpConnection *connection = host == nullptr ? nullptr : tcp_find(host, operation);
    if (connection == nullptr || connection->tls == nullptr) return -1;
    return mal_tls_session_info(connection->tls, kind, output, output_length);
#else
    (void) host; (void) operation; (void) kind; (void) output; (void) output_length;
    return -1;
#endif
}

typedef struct MalTcpListener {
    MalHost *host;
    MalHostHandle operation;
    int fd;
    MalOp accept_op;
    bool unreferenced;
    struct MalTcpListener *next;
} MalTcpListener;

// Listeners belong to the reactor thread of the isolate that opened them.
static MAL_ISOLATE_LOCAL MalTcpListener *tcp_listeners;

static bool tcp_listener_disarm(MalTcpListener *listener) {
    MalReactor *reactor = &listener->host->reactor;
    if (listener->accept_op.active && listener->unreferenced) reactor->unreferenced_ops--;
    return mal_reactor_cancel_op(reactor, &listener->accept_op);
}

static void tcp_listener_destroy(MalTcpListener *listener) {
    MalTcpListener **link = &tcp_listeners;
    while (*link != nullptr && *link != listener) link = &(*link)->next;
    if (*link == listener) *link = listener->next;
    (void) tcp_listener_disarm(listener);
    mal_host_operation_unbind(&listener->host->tasks, listener->operation, listener);
    mal_net_close(listener->fd);
    free(listener);
}

static MalTcpListener *tcp_listener_find(MalHost *host, MalHostHandle operation) {
    for (MalTcpListener *listener = tcp_listeners; listener != nullptr; listener = listener->next) {
        if (listener->host == host && listener->operation == operation) return listener;
    }
    return nullptr;
}

static bool tcp_listener_arm(MalTcpListener *listener);

static bool tcp_adopt(MalTcpListener *listener, int fd) {
    MalHost *host = listener->host;
    MalTcpConnection *connection = calloc(1, sizeof(MalTcpConnection));
    MalTcpProgress *progress = calloc(1, sizeof(MalTcpProgress));
    MalHostHandle operation = 0;
    if (connection == nullptr || progress == nullptr || !mal_host_operation_start(&host->tasks, &operation)) {
        free(connection);
        free(progress);
        mal_net_close(fd);
        return false;
    }
    connection->host = host;
    connection->operation = operation;
    connection->fd = fd;
    // Paused until adopted, so no data task can precede the adopter's socket state.
    connection->read_paused = true;
    if (!mal_host_operation_bind(&host->tasks, operation, connection)
        || !mal_host_operation_activate(&host->tasks, operation)) {
        free(progress);
        tcp_destroy(connection);
        (void) mal_host_operation_abort_start(&host->tasks, operation);
        return false;
    }
    connection->next = host->tcp_connections;
    host->tcp_connections = connection;
    progress->kind = MAL_TCP_ACCEPTED;
    progress->accepted = operation;
    if (!mal_host_operation_progress(&host->tasks, listener->operation, progress, mal_tcp_progress_free)) {
        mal_tcp_progress_free(progress);
        (void) mal_tcp_cancel(host, operation);
        return false;
    }
    return true;
}

static void tcp_accept_ready(void *data) {
    MalTcpListener *listener = data;
    if (listener->unreferenced) listener->host->reactor.unreferenced_ops--;
    for (usize turn = 0; turn < 64; turn++) {
        int fd = mal_net_accept_connection(listener->fd);
        if (fd >= 0) {
            (void) tcp_adopt(listener, fd);
            continue;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK || errno == ECONNABORTED || errno == EMFILE
            || errno == ENFILE) {
            break;
        }
        MalTcpTerminal *terminal = malloc(sizeof(MalTcpTerminal));
        if (terminal != nullptr) terminal->error = errno;
        if (!mal_host_operation_complete(&listener->host->tasks, listener->operation,
                MAL_HOST_TERMINAL_ERROR, terminal, mal_tcp_terminal_free)) {
            free(terminal);
        }
        tcp_listener_destroy(listener);
        return;
    }
    (void) tcp_listener_arm(listener);
}

static bool tcp_listener_arm(MalTcpListener *listener) {
    listener->accept_op = (MalOp) {
        .fd = listener->fd,
        .interest = MAL_IO_READ,
        .waker = {.fn = tcp_accept_ready, .data = listener},
    };
    if (!mal_reactor_add_op(&listener->host->reactor, &listener->accept_op)) return false;
    if (listener->unreferenced) listener->host->reactor.unreferenced_ops++;
    return true;
}

int mal_tcp_listen_start(
    MalHost *host, const struct sockaddr *address, socklen_t length, int backlog, bool ipv6_only,
    MalHostHandle *operation) {
    if (host == nullptr || address == nullptr || operation == nullptr) return EINVAL;
    int fd = mal_net_listen_address(address, length, backlog, ipv6_only);
    if (fd < 0) return errno != 0 ? errno : EIO;
    MalTcpListener *listener = calloc(1, sizeof(MalTcpListener));
    if (listener == nullptr || !mal_host_operation_start(&host->tasks, operation)) {
        free(listener);
        mal_net_close(fd);
        return ENOMEM;
    }
    listener->host = host;
    listener->operation = *operation;
    listener->fd = fd;
    if (!mal_host_operation_bind(&host->tasks, *operation, listener) || !tcp_listener_arm(listener)
        || !mal_host_operation_activate(&host->tasks, *operation)) {
        (void) mal_reactor_cancel_op(&host->reactor, &listener->accept_op);
        mal_host_operation_unbind(&host->tasks, *operation, listener);
        (void) mal_host_operation_abort_start(&host->tasks, *operation);
        mal_net_close(fd);
        free(listener);
        return EIO;
    }
    listener->next = tcp_listeners;
    tcp_listeners = listener;
    return 0;
}

bool mal_tcp_listen_endpoint(MalHost *host, MalHostHandle operation, MalNetEndpoint *out) {
    MalTcpListener *listener = tcp_listener_find(host, operation);
    return listener != nullptr && mal_net_local_endpoint(listener->fd, out);
}

bool mal_tcp_connection_endpoints(
    MalHost *host, MalHostHandle operation, MalNetEndpoint *local, MalNetEndpoint *remote) {
    MalTcpConnection *connection = host == nullptr ? nullptr : tcp_find(host, operation);
    return connection != nullptr && mal_net_local_endpoint(connection->fd, local)
        && mal_net_remote_endpoint(connection->fd, remote);
}

bool mal_tcp_listen_pause(MalHost *host, MalHostHandle operation, bool paused) {
    MalTcpListener *listener = tcp_listener_find(host, operation);
    if (listener == nullptr) return false;
    if (paused) return tcp_listener_disarm(listener);
    return listener->accept_op.active || tcp_listener_arm(listener);
}

bool mal_tcp_listen_set_referenced(MalHost *host, MalHostHandle operation, bool referenced) {
    MalTcpListener *listener = tcp_listener_find(host, operation);
    if (listener == nullptr) return false;
    if (listener->unreferenced != referenced) return true;
    if (listener->accept_op.active) host->reactor.unreferenced_ops += referenced ? -1 : 1;
    listener->unreferenced = !referenced;
    return true;
}

bool mal_tcp_listen_close(MalHost *host, MalHostHandle operation) {
    MalTcpListener *listener = tcp_listener_find(host, operation);
    if (listener == nullptr) return false;
    MalTcpTerminal *terminal = calloc(1, sizeof(MalTcpTerminal));
    if (!mal_host_operation_complete(&host->tasks, operation, MAL_HOST_TERMINAL_OK, terminal,
            mal_tcp_terminal_free)) {
        free(terminal);
    }
    tcp_listener_destroy(listener);
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
    for (MalTcpListener *listener = tcp_listeners, *next; listener != nullptr; listener = next) {
        next = listener->next;
        if (listener->host != host) continue;
        (void) mal_host_operation_cancel(&host->tasks, listener->operation);
        tcp_listener_destroy(listener);
    }
    while (host->tcp_connections != nullptr) {
        MalTcpConnection *connection = host->tcp_connections;
        (void) mal_host_operation_cancel(&host->tasks, connection->operation);
        tcp_destroy(connection);
    }
}
