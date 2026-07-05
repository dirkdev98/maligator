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

static bool mal_net_parse_addr(const char *host, u16 port, struct sockaddr_in *addr) {
    memset(addr, 0, sizeof(*addr));
    addr->sin_family = AF_INET;
    addr->sin_port = htons(port);
    const char *h = (host == nullptr || host[0] == '\0') ? "0.0.0.0" : host;
    return inet_pton(AF_INET, h, &addr->sin_addr) == 1;
}

int mal_net_listen(const char *host, u16 port, int backlog) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        return -1;
    }
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));

    struct sockaddr_in addr;
    if (!mal_net_parse_addr(host, port, &addr)) {
        close(fd);
        return -1;
    }
    if (bind(fd, (struct sockaddr *) &addr, sizeof(addr)) < 0) {
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
    mal_net_set_nonblock(client);
    int one = 1;
    setsockopt(client, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    return client;
}

int mal_net_connect(const char *host, u16 port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        return -1;
    }
    if (mal_net_set_nonblock(fd) < 0) {
        close(fd);
        return -1;
    }
    struct sockaddr_in addr;
    if (!mal_net_parse_addr(host, port, &addr)) {
        close(fd);
        return -1;
    }
    int r = connect(fd, (struct sockaddr *) &addr, sizeof(addr));
    if (r < 0 && errno != EINPROGRESS) {
        close(fd);
        return -1;
    }
    return fd;
}

u16 mal_net_local_port(int fd) {
    struct sockaddr_in addr;
    socklen_t len = sizeof(addr);
    if (getsockname(fd, (struct sockaddr *) &addr, &len) < 0) {
        return 0;
    }
    return ntohs(addr.sin_port);
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
