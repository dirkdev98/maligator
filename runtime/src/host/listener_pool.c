#include "listener_pool.h"

#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "net.h"

typedef struct PoolClaim {
    int fd;
    const void *owner;
    struct PoolClaim *next;
} PoolClaim;

typedef struct PoolEntry {
    struct sockaddr_storage address;
    socklen_t length;
    bool ipv6_only;
    int fd;
    PoolClaim *claims;
    struct PoolEntry *next;
} PoolEntry;

static pthread_mutex_t pool_mutex = PTHREAD_MUTEX_INITIALIZER;
static PoolEntry *pool_entries;
// Read without the lock so closing a listener costs nothing while the pool is empty.
static _Atomic(usize) pool_count;

static u16 address_port(const struct sockaddr *address) {
    return address->sa_family == AF_INET
        ? ntohs(((const struct sockaddr_in *) address)->sin_port)
        : ntohs(((const struct sockaddr_in6 *) address)->sin6_port);
}

static bool pooled_address(const struct sockaddr *address, socklen_t length) {
    if (address == nullptr || length > (socklen_t) sizeof(struct sockaddr_storage)) return false;
    if (address->sa_family == AF_INET && length >= (socklen_t) sizeof(struct sockaddr_in))
        return address_port(address) != 0;
    if (address->sa_family == AF_INET6 && length >= (socklen_t) sizeof(struct sockaddr_in6))
        return address_port(address) != 0;
    return false;
}

static bool entry_matches(
    const PoolEntry *entry, const struct sockaddr *address, bool ipv6_only) {
    const struct sockaddr *pooled = (const struct sockaddr *) &entry->address;
    if (pooled->sa_family != address->sa_family || address_port(pooled) != address_port(address))
        return false;
    if (address->sa_family == AF_INET) {
        return memcmp(&((const struct sockaddr_in *) pooled)->sin_addr,
                   &((const struct sockaddr_in *) address)->sin_addr, sizeof(struct in_addr)) == 0;
    }
    const struct sockaddr_in6 *left = (const struct sockaddr_in6 *) pooled;
    const struct sockaddr_in6 *right = (const struct sockaddr_in6 *) address;
    return entry->ipv6_only == ipv6_only && left->sin6_scope_id == right->sin6_scope_id
        && memcmp(&left->sin6_addr, &right->sin6_addr, sizeof(struct in6_addr)) == 0;
}

static void entry_unlink_close(PoolEntry **link) {
    PoolEntry *entry = *link;
    *link = entry->next;
    close(entry->fd);
    free(entry);
    atomic_fetch_sub_explicit(&pool_count, 1, memory_order_relaxed);
}

// An unclaimed socket on the port may be what keeps a changed address from binding,
// such as 0.0.0.0:3000 after a generation that listened on 127.0.0.1:3000.
static usize release_unclaimed_port(u16 port) {
    usize released = 0;
    PoolEntry **link = &pool_entries;
    while (*link != nullptr) {
        PoolEntry *entry = *link;
        if (entry->claims == nullptr && address_port((const struct sockaddr *) &entry->address) == port) {
            entry_unlink_close(link);
            released++;
        } else {
            link = &entry->next;
        }
    }
    return released;
}

int mal_listener_pool_listen(
    const void *owner, const struct sockaddr *address, socklen_t length, int backlog,
    bool ipv6_only) {
    if (owner == nullptr || !pooled_address(address, length))
        return mal_net_listen_address(address, length, backlog, ipv6_only);
    pthread_mutex_lock(&pool_mutex);
    PoolEntry *entry = pool_entries;
    while (entry != nullptr && !entry_matches(entry, address, ipv6_only)) entry = entry->next;
    bool created = false;
    if (entry == nullptr) {
        int fd = mal_net_listen_address(address, length, backlog, ipv6_only);
        if (fd < 0 && errno == EADDRINUSE && release_unclaimed_port(address_port(address)) > 0)
            fd = mal_net_listen_address(address, length, backlog, ipv6_only);
        if (fd < 0) {
            int error = errno;
            pthread_mutex_unlock(&pool_mutex);
            errno = error;
            return -1;
        }
        entry = calloc(1, sizeof(PoolEntry));
        if (entry == nullptr) {
            close(fd);
            pthread_mutex_unlock(&pool_mutex);
            errno = ENOMEM;
            return -1;
        }
        memcpy(&entry->address, address, (usize) length);
        entry->length = length;
        entry->ipv6_only = ipv6_only;
        entry->fd = fd;
        entry->next = pool_entries;
        pool_entries = entry;
        atomic_fetch_add_explicit(&pool_count, 1, memory_order_relaxed);
        created = true;
    } else if (entry->claims != nullptr) {
        pthread_mutex_unlock(&pool_mutex);
        errno = EADDRINUSE;
        return -1;
    }
    int fd = fcntl(entry->fd, F_DUPFD_CLOEXEC, 0);
    PoolClaim *claim = fd < 0 ? nullptr : calloc(1, sizeof(PoolClaim));
    if (claim == nullptr) {
        int error = fd < 0 ? errno : ENOMEM;
        if (fd >= 0) close(fd);
        if (created) {
            PoolEntry **link = &pool_entries;
            while (*link != entry) link = &(*link)->next;
            entry_unlink_close(link);
        }
        pthread_mutex_unlock(&pool_mutex);
        errno = error;
        return -1;
    }
    claim->fd = fd;
    claim->owner = owner;
    claim->next = entry->claims;
    entry->claims = claim;
    pthread_mutex_unlock(&pool_mutex);
    return fd;
}

void mal_listener_pool_close(int fd) {
    if (fd < 0) return;
    if (atomic_load_explicit(&pool_count, memory_order_relaxed) != 0) {
        pthread_mutex_lock(&pool_mutex);
        for (PoolEntry **link = &pool_entries; *link != nullptr; link = &(*link)->next) {
            PoolClaim **claim = &(*link)->claims;
            while (*claim != nullptr && (*claim)->fd != fd) claim = &(*claim)->next;
            if (*claim == nullptr) continue;
            PoolClaim *closed = *claim;
            *claim = closed->next;
            free(closed);
            if ((*link)->claims == nullptr) entry_unlink_close(link);
            break;
        }
        pthread_mutex_unlock(&pool_mutex);
    }
    mal_net_close(fd);
}

void mal_listener_pool_retire(const void *owner) {
    if (owner == nullptr || atomic_load_explicit(&pool_count, memory_order_relaxed) == 0) return;
    pthread_mutex_lock(&pool_mutex);
    for (PoolEntry *entry = pool_entries; entry != nullptr; entry = entry->next) {
        PoolClaim **claim = &entry->claims;
        while (*claim != nullptr) {
            if ((*claim)->owner != owner) {
                claim = &(*claim)->next;
                continue;
            }
            // The descriptor stays open until its owner closes it, which then finds no
            // claim and closes only that descriptor.
            PoolClaim *retired = *claim;
            *claim = retired->next;
            free(retired);
        }
    }
    pthread_mutex_unlock(&pool_mutex);
}

usize mal_listener_pool_release_unclaimed(void) {
    usize released = 0;
    pthread_mutex_lock(&pool_mutex);
    PoolEntry **link = &pool_entries;
    while (*link != nullptr) {
        if ((*link)->claims == nullptr) {
            entry_unlink_close(link);
            released++;
        } else {
            link = &(*link)->next;
        }
    }
    pthread_mutex_unlock(&pool_mutex);
    return released;
}

usize mal_listener_pool_size(void) {
    return atomic_load_explicit(&pool_count, memory_order_relaxed);
}
