#include "net.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int mal_net_set_nonblock(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0) {
        return -1;
    }
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static int mal_net_set_cloexec(int fd) {
    int flags = fcntl(fd, F_GETFD, 0);
    if (flags < 0) {
        return -1;
    }
    return fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
}

static int mal_net_prepare_fd(int fd) {
    return mal_net_set_nonblock(fd) < 0 || mal_net_set_cloexec(fd) < 0 ? -1 : 0;
}

bool mal_net_parse_ip(
    const char *host, u16 port, struct sockaddr_storage *address, socklen_t *length) {
    if (host == nullptr || address == nullptr || length == nullptr) {
        return false;
    }
    memset(address, 0, sizeof(*address));
    struct sockaddr_in *ipv4 = (struct sockaddr_in *) address;
    ipv4->sin_family = AF_INET;
    ipv4->sin_port = htons(port);
    if (inet_pton(AF_INET, host, &ipv4->sin_addr) == 1) {
        *length = sizeof(*ipv4);
        return true;
    }
    memset(address, 0, sizeof(*address));
    struct sockaddr_in6 *ipv6 = (struct sockaddr_in6 *) address;
    ipv6->sin6_family = AF_INET6;
    ipv6->sin6_port = htons(port);
    if (inet_pton(AF_INET6, host, &ipv6->sin6_addr) == 1) {
        *length = sizeof(*ipv6);
        return true;
    }
    return false;
}

int mal_net_listen(const char *host, u16 port, int backlog) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        return -1;
    }
    if (mal_net_set_cloexec(fd) < 0) {
        int error = errno;
        close(fd);
        errno = error;
        return -1;
    }
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));

    struct sockaddr_storage address;
    socklen_t length;
    const char *numeric_host = (host == nullptr || host[0] == '\0') ? "0.0.0.0" : host;
    if (!mal_net_parse_ip(numeric_host, port, &address, &length) ||
        address.ss_family != AF_INET) {
        close(fd);
        errno = EINVAL;
        return -1;
    }
    if (bind(fd, (struct sockaddr *) &address, length) < 0) {
        close(fd);
        return -1;
    }
    if (listen(fd, backlog > 0 ? backlog : 128) < 0) {
        close(fd);
        return -1;
    }
    if (mal_net_set_nonblock(fd) < 0) {
        close(fd);
        return -1;
    }
    return fd;
}

int mal_net_accept(int listen_fd) {
    int client = accept(listen_fd, nullptr, nullptr);
    if (client < 0) {
        return -1;
    }
    if (mal_net_prepare_fd(client) < 0) {
        int error = errno;
        close(client);
        errno = error;
        return -1;
    }
    int one = 1;
    setsockopt(client, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    return client;
}

int mal_net_connect(const char *host, u16 port) {
    struct sockaddr_storage address;
    socklen_t length;
    if (!mal_net_parse_ip(host, port, &address, &length)) {
        errno = EINVAL;
        return -1;
    }
    return mal_net_connect_address((const struct sockaddr *) &address, length);
}

int mal_net_connect_address(const struct sockaddr *address, socklen_t length) {
    if (address == nullptr ||
        (address->sa_family != AF_INET && address->sa_family != AF_INET6)) {
        errno = EINVAL;
        return -1;
    }
    int fd = socket(address->sa_family, SOCK_STREAM, 0);
    if (fd < 0) {
        return -1;
    }
    if (mal_net_prepare_fd(fd) < 0) {
        int error = errno;
        close(fd);
        errno = error;
        return -1;
    }
#if defined(SO_NOSIGPIPE)
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
    int no_delay = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &no_delay, sizeof(no_delay));
    int r = connect(fd, address, length);
    if (r < 0 && errno != EINPROGRESS) {
        close(fd);
        return -1;
    }
    return fd;
}

u16 mal_net_local_port(int fd) {
    struct sockaddr_storage address;
    socklen_t length = sizeof(address);
    if (getsockname(fd, (struct sockaddr *) &address, &length) < 0) {
        return 0;
    }
    if (address.ss_family == AF_INET) {
        return ntohs(((struct sockaddr_in *) &address)->sin_port);
    }
    if (address.ss_family == AF_INET6) {
        return ntohs(((struct sockaddr_in6 *) &address)->sin6_port);
    }
    return 0;
}

int mal_net_socket_error(int fd) {
    int err = 0;
    socklen_t len = sizeof(err);
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) < 0) {
        return errno;
    }
    return err;
}

void mal_net_close(int fd) {
    if (fd >= 0) {
        close(fd);
    }
}

ssize_t mal_net_write(int fd, const void *bytes, usize length) {
#if defined(MSG_NOSIGNAL)
    return send(fd, bytes, length, MSG_NOSIGNAL);
#else
    return send(fd, bytes, length, 0);
#endif
}
