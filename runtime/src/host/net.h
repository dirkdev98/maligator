#pragma once

#include "./defaults.h"

/*
 * Non-blocking TCP socket helpers (host layer). Thin wrappers over POSIX sockets
 * that the reactor drives: create sockets in non-blocking mode, and expose the
 * pieces the reactor's readiness model needs (accept-when-readable, complete a
 * connect-when-writable). IPv4 only for now (numeric hosts; DNS + IPv6 arrive with
 * client fetch). The WinterTC fetch server sits on these.
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
 * Create a non-blocking IPv4 socket and begin connecting to host:port. Returns the
 * fd immediately; the connection may still be in progress (wait for the fd to
 * become writable, then check mal_net_socket_error). Returns -1 on immediate error.
 */
int mal_net_connect(const char *host, u16 port);

/* The local port a socket is bound to (host byte order), or 0 on error. */
u16 mal_net_local_port(int fd);

/* SO_ERROR of a socket (0 = ok), for completing a non-blocking connect. */
int mal_net_socket_error(int fd);

/* Close a socket fd (no-op for fd < 0). */
void mal_net_close(int fd);
