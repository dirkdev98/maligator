#pragma once

#include "./defaults.h"

#include <sys/socket.h>
#include <sys/uio.h>

#define MAL_NET_ADDRESS_MAX 46

typedef enum MalNetAddressFamily {
    MAL_NET_ADDRESS_UNKNOWN = 0,
    MAL_NET_ADDRESS_IPV4 = 1,
    MAL_NET_ADDRESS_IPV6 = 2,
} MalNetAddressFamily;

typedef struct MalNetEndpoint {
    char address[MAL_NET_ADDRESS_MAX];
    u16 port;
    MalNetAddressFamily family;
} MalNetEndpoint;

/*
 * Non-blocking TCP socket helpers (host layer). Thin wrappers over POSIX sockets
 * that the reactor drives: create sockets in non-blocking mode, and expose the
 * pieces the reactor's readiness model needs (accept-when-readable, complete a
 * connect-when-writable). Numeric IPv4 and IPv6 are supported; DNS stays in the
 * asynchronous host resolver. The WinterTC fetch server sits on these.
 */

/*
 * Create a non-blocking IPv4 listening socket bound to host:port. `host` is a
 * numeric dotted-quad ("127.0.0.1", "0.0.0.0"); null/empty => 0.0.0.0. `port` 0 =>
 * an ephemeral port (read it back with mal_net_local_port). SO_REUSEADDR is set.
 * Returns the fd, or -1 on error (errno set).
 */
int mal_net_listen(const char *host, u16 port, int backlog);

/*
 * Accept one pending connection on a listening fd, returning a non-blocking client
 * fd (TCP_NODELAY set), or -1 when none are pending (errno EAGAIN/EWOULDBLOCK) or
 * on error.
 */
int mal_net_accept(int listen_fd);

/*
 * Create a non-blocking IPv4/IPv6 socket and begin connecting to host:port. Returns the
 * fd immediately; the connection may still be in progress (wait for the fd to
 * become writable, then check mal_net_socket_error). Returns -1 on immediate error.
 */
int mal_net_connect(const char *host, u16 port);

/* Parse a numeric IP literal and connect an already-resolved address. */
bool mal_net_parse_ip(
    const char *host, u16 port, struct sockaddr_storage *address, socklen_t *length);
int mal_net_connect_address(const struct sockaddr *address, socklen_t length);

/* The local port a socket is bound to (host byte order), or 0 on error. */
u16 mal_net_local_port(int fd);

/* Numeric local/peer endpoint metadata for an established socket. */
bool mal_net_local_endpoint(int fd, MalNetEndpoint *out);
bool mal_net_remote_endpoint(int fd, MalNetEndpoint *out);

/* SO_ERROR of a socket (0 = ok), for completing a non-blocking connect. */
int mal_net_socket_error(int fd);

/* Close a socket fd (no-op for fd < 0). */
void mal_net_close(int fd);

/* Socket write that suppresses SIGPIPE when the peer has already closed. */
ssize_t mal_net_write(int fd, const void *bytes, usize length);
ssize_t mal_net_writev(int fd, const struct iovec *iov, int iov_count);
