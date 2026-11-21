#pragma once

#include "./defaults.h"

#include <sys/socket.h>

/*
 * Listening sockets that outlive the isolate that opened them. A development
 * supervisor restarts an application by terminating its isolate and launching the
 * next generation. Pooled, the socket the old generation listened on stays open in
 * between, so clients wait in its backlog instead of being refused, and the next
 * generation's bind of the same address adopts the socket and its queue.
 *
 * Each bind by a pooling isolate takes a claim on the socket and gets a descriptor
 * of its own. Closing that descriptor through mal_listener_pool_close drops the
 * claim, and the last such close shuts the socket as an unpooled close would, so an
 * application that closes its server frees the port. Retiring an isolate drops its
 * claims without closing anything: the sockets stay open, unclaimed, until a bind
 * adopts them or the supervisor releases them.
 *
 * TCP addresses with a fixed port pool; an ephemeral port has nothing to preserve and
 * a Unix socket path is left to its owner. The pool is process-wide and thread-safe.
 */

/* Listen on `address` as mal_net_listen_address does. A non-null `owner` (the
 * isolate's host) pools the socket: an unclaimed pooled socket for the same address
 * is adopted, and one another bind still claims fails with EADDRINUSE. */
int mal_listener_pool_listen(
    const void *owner, const struct sockaddr *address, socklen_t length, int backlog,
    bool ipv6_only);

/* Close a listening descriptor, pooled or not. */
void mal_listener_pool_close(int fd);

/* Keep `owner`'s pooled sockets open past the close of its descriptors. Called when
 * a pooling isolate is torn down, before its listeners close. */
void mal_listener_pool_retire(const void *owner);

/* Close every pooled socket no bind claims; returns how many closed. */
usize mal_listener_pool_release_unclaimed(void);

/* Sockets the pool holds open, claimed or not. */
usize mal_listener_pool_size(void);
