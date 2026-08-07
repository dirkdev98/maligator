#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif
#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE 1
#endif
#ifndef _GNU_SOURCE
#define _GNU_SOURCE 1
#endif

#include "entropy.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <string.h>
#include <unistd.h>

/* getrandom (Linux) and getentropy (macOS/BSD) both live here. */
#include <sys/random.h>

/* getentropy(2) refuses requests above 256 bytes on every platform that has it. */
#define MAL_ENTROPY_CHUNK 256

/* Node's kBatchSize: one draw serves 128 UUIDs. */
#define MAL_ENTROPY_UUID_BATCH 128

/*
 * Both pieces of mutable state here are process-global, and both are reachable
 * from any thread an embedder runs (this boundary is engine-neutral; nothing in
 * it may assume reactor-thread affinity). Two separate locks, always taken in
 * the order uuid -> device and never the other way, so serving a UUID batch can
 * fall back to the device without deadlocking against itself.
 */
static pthread_mutex_t mal_entropy_device_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t mal_entropy_uuid_mutex = PTHREAD_MUTEX_INITIALIZER;

/* Lazily opened, O_CLOEXEC, process-lifetime device fd. Only reached when the
 * entropy syscall is missing (an old kernel reporting ENOSYS), so the common
 * path never holds a descriptor and cannot fail under fd exhaustion. */
static int mal_entropy_device_fd = -1;

static int mal_host_entropy_device(void *buffer, usize length) {
    pthread_mutex_lock(&mal_entropy_device_mutex);
    if (mal_entropy_device_fd < 0) {
        int fd;
        do {
            fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
        } while (fd < 0 && errno == EINTR);
        if (fd < 0) {
            int status = errno == 0 ? EIO : errno;
            pthread_mutex_unlock(&mal_entropy_device_mutex);
            return status;
        }
        mal_entropy_device_fd = fd;
    }

    // The read stays under the lock: concurrent reads on one shared descriptor
    // would interleave their file offsets and short reads.
    byte *cursor = buffer;
    usize remaining = length;
    int status = 0;
    while (remaining > 0) {
        usize chunk = remaining > (usize) SSIZE_MAX ? (usize) SSIZE_MAX : remaining;
        ssize_t count = read(mal_entropy_device_fd, cursor, chunk);
        if (count > 0) {
            cursor += (usize) count;
            remaining -= (usize) count;
        } else if (count == 0) {
            status = EIO;
            break;
        } else if (errno != EINTR) {
            status = errno == 0 ? EIO : errno;
            break;
        }
    }
    pthread_mutex_unlock(&mal_entropy_device_mutex);
    return status;
}

int mal_host_entropy(void *buffer, usize length) {
    if (length == 0) {
        return 0;
    }
    if (buffer == nullptr) {
        return EFAULT;
    }

    byte *cursor = buffer;
    usize remaining = length;
    while (remaining > 0) {
#if defined(__linux__)
        // getrandom returns short reads for large requests and is interruptible.
        ssize_t count = getrandom(cursor, remaining, 0);
        if (count > 0) {
            cursor += (usize) count;
            remaining -= (usize) count;
            continue;
        }
        if (count < 0 && errno == EINTR) {
            continue;
        }
        if (count < 0 && errno == ENOSYS) {
            return mal_host_entropy_device(cursor, remaining);
        }
        return count == 0 ? EIO : (errno == 0 ? EIO : errno);
#else
        // getentropy fills the whole request or fails; the 256-byte cap is the
        // documented limit, so a larger request is chunked rather than truncated.
        usize chunk = remaining > MAL_ENTROPY_CHUNK ? MAL_ENTROPY_CHUNK : remaining;
        if (getentropy(cursor, chunk) == 0) {
            cursor += chunk;
            remaining -= chunk;
            continue;
        }
        if (errno == EINTR) {
            continue;
        }
        if (errno == ENOSYS) {
            return mal_host_entropy_device(cursor, remaining);
        }
        return errno == 0 ? EIO : errno;
#endif
    }
    return 0;
}

static byte mal_entropy_uuid_cache[MAL_ENTROPY_UUID_BATCH * 16];
static usize mal_entropy_uuid_available;

void mal_host_entropy_cache_reset(void) {
    pthread_mutex_lock(&mal_entropy_uuid_mutex);
    // Scrubbed rather than merely marked empty: the cache holds unserved
    // randomness that would otherwise linger in the data segment.
    memset(mal_entropy_uuid_cache, 0, sizeof(mal_entropy_uuid_cache));
    mal_entropy_uuid_available = 0;
    pthread_mutex_unlock(&mal_entropy_uuid_mutex);
}

static void mal_host_entropy_uuid_bits(byte *uuid) {
    uuid[6] = (byte) ((uuid[6] & 0x0f) | 0x40);
    uuid[8] = (byte) ((uuid[8] & 0x3f) | 0x80);
}

int mal_host_entropy_uuid(void *out16, bool fresh) {
    if (out16 == nullptr) {
        return EFAULT;
    }
    if (fresh) {
        int status = mal_host_entropy(out16, 16);
        if (status != 0) {
            return status;
        }
        mal_host_entropy_uuid_bits(out16);
        return 0;
    }
    // Held across the refill: mal_host_entropy takes the *device* lock, never
    // this one, so there is no self-deadlock and no window in which two threads
    // could hand out the same slot.
    pthread_mutex_lock(&mal_entropy_uuid_mutex);
    if (mal_entropy_uuid_available == 0) {
        int status = mal_host_entropy(
            mal_entropy_uuid_cache, sizeof(mal_entropy_uuid_cache));
        if (status != 0) {
            pthread_mutex_unlock(&mal_entropy_uuid_mutex);
            return status;
        }
        mal_entropy_uuid_available = sizeof(mal_entropy_uuid_cache);
    }
    // `available` counts the bytes still unserved, which occupy the buffer's
    // prefix; each draw takes the last unserved slot and scrubs it, so what
    // remains behind the cursor is already zeroed.
    mal_entropy_uuid_available -= 16;
    byte *slot = mal_entropy_uuid_cache + mal_entropy_uuid_available;
    memcpy(out16, slot, 16);
    memset(slot, 0, 16);
    pthread_mutex_unlock(&mal_entropy_uuid_mutex);
    mal_host_entropy_uuid_bits(out16);
    return 0;
}
