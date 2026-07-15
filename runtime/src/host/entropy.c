#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif

#include "entropy.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <unistd.h>

int mal_host_entropy(void *buffer, usize length) {
    if (length == 0) {
        return 0;
    }

    int fd;
    do {
        fd = open("/dev/urandom", O_RDONLY);
    } while (fd < 0 && errno == EINTR);
    if (fd < 0) {
        return errno;
    }

    byte *cursor = buffer;
    usize remaining = length;
    int status = 0;
    while (remaining > 0) {
        usize chunk = remaining > (usize) SSIZE_MAX ? (usize) SSIZE_MAX : remaining;
        ssize_t count = read(fd, cursor, chunk);
        if (count > 0) {
            cursor += (usize) count;
            remaining -= (usize) count;
        } else if (count == 0) {
            status = EIO;
            break;
        } else if (errno != EINTR) {
            status = errno;
            break;
        }
    }

    (void) close(fd);
    return status;
}
