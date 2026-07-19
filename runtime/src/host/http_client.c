#include "http_client.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "host.h"
#include "http.h"
#include "net.h"
#include "reactor.h"

#define MAL_HTTP_CLIENT_READ_INIT 4096
#define MAL_HTTP_CLIENT_HEADERS_MAX (64 * 1024)

typedef struct MalHttpClient {
    MalHost *host;
    MalHostHandle operation;
    int fd;
    MalOp read_op;
    MalOp write_op;
    byte *request;
    usize request_len;
    usize request_sent;
    byte *response;
    usize response_len;
    usize response_capacity;
    bool connecting;
    bool head_request;
} MalHttpClient;

static char *client_copy(const char *bytes, usize length) {
    char *copy = malloc(length + 1);
    if (copy == nullptr) return nullptr;
    memcpy(copy, bytes, length);
    copy[length] = '\0';
    return copy;
}

void mal_http_client_result_free(void *data) {
    MalHttpClientResult *result = data;
    if (result == nullptr) return;
    for (usize i = 0; i < result->header_count; i++) {
        free(result->headers[i].name);
        free(result->headers[i].value);
    }
    free(result->body);
    free(result->error);
    free(result);
}

static void client_destroy(MalHttpClient *client) {
    if (client == nullptr) return;
    (void) mal_reactor_cancel_op(&client->host->reactor, &client->read_op);
    (void) mal_reactor_cancel_op(&client->host->reactor, &client->write_op);
    mal_net_close(client->fd);
    free(client->request);
    free(client->response);
    free(client);
}

static void client_complete(
    MalHttpClient *client, MalHostTerminalResult terminal,
    MalHttpClientResult *result) {
    if (!mal_host_operation_complete(
            &client->host->tasks, client->operation, terminal, result,
            mal_http_client_result_free)) {
        mal_http_client_result_free(result);
    }
    client_destroy(client);
}

static void client_fail(MalHttpClient *client, const char *message) {
    MalHttpClientResult *result = calloc(1, sizeof(MalHttpClientResult));
    if (result != nullptr) result->error = client_copy(message, strlen(message));
    client_complete(client, MAL_HOST_TERMINAL_ERROR, result);
}

static bool client_ci_equal(
    const char *left, usize left_len, const char *right) {
    usize right_len = strlen(right);
    if (left_len != right_len) return false;
    for (usize i = 0; i < left_len; i++) {
        char a = left[i];
        char b = right[i];
        if (a >= 'A' && a <= 'Z') a = (char) (a + 0x20);
        if (b >= 'A' && b <= 'Z') b = (char) (b + 0x20);
        if (a != b) return false;
    }
    return true;
}

static const byte *client_header_end(const byte *bytes, usize length) {
    for (usize i = 0; i + 3 < length; i++) {
        if (bytes[i] == '\r' && bytes[i + 1] == '\n'
            && bytes[i + 2] == '\r' && bytes[i + 3] == '\n') {
            return bytes + i + 4;
        }
    }
    return nullptr;
}

static const char *client_crlf(const char *bytes, usize length) {
    for (usize i = 0; i + 1 < length; i++) {
        if (bytes[i] == '\r' && bytes[i + 1] == '\n') return bytes + i;
    }
    return nullptr;
}

static bool client_parse_decimal(const char *bytes, usize length, usize *value) {
    if (length == 0) return false;
    usize parsed = 0;
    for (usize i = 0; i < length; i++) {
        if (bytes[i] < '0' || bytes[i] > '9') return false;
        usize digit = (usize) (bytes[i] - '0');
        if (parsed > (SIZE_MAX - digit) / 10) return false;
        parsed = parsed * 10 + digit;
    }
    *value = parsed;
    return true;
}

static bool client_parse_head(
    MalHttpClient *client, MalHttpClientResult *result, usize header_length,
    usize *content_length, bool *has_content_length, bool *chunked) {
    const char *bytes = (const char *) client->response;
    const char *line_end = client_crlf(bytes, header_length);
    if (line_end == nullptr || line_end >= bytes + header_length
        || line_end - bytes < 12 || memcmp(bytes, "HTTP/1.", 7) != 0
        || bytes[7] < '0' || bytes[7] > '9' || bytes[8] != ' ') {
        return false;
    }
    result->minor_version = bytes[7] - '0';
    if (bytes[9] < '0' || bytes[9] > '9' || bytes[10] < '0' || bytes[10] > '9'
        || bytes[11] < '0' || bytes[11] > '9') {
        return false;
    }
    result->status = (bytes[9] - '0') * 100 + (bytes[10] - '0') * 10
        + (bytes[11] - '0');

    const char *cursor = line_end + 2;
    const char *head_end = bytes + header_length - 2;
    while (cursor < head_end) {
        const char *end = client_crlf(cursor, (usize) (head_end - cursor));
        if (end == nullptr || end > head_end) return false;
        const char *colon = memchr(cursor, ':', (usize) (end - cursor));
        if (colon == nullptr || colon == cursor
            || result->header_count == countof(result->headers)) {
            return false;
        }
        const char *value = colon + 1;
        while (value < end && (*value == ' ' || *value == '\t')) value++;
        const char *value_end = end;
        while (value_end > value
               && (value_end[-1] == ' ' || value_end[-1] == '\t')) value_end--;
        MalHttpClientHeader *header = &result->headers[result->header_count++];
        header->name_len = (usize) (colon - cursor);
        header->value_len = (usize) (value_end - value);
        header->name = client_copy(cursor, header->name_len);
        header->value = client_copy(value, header->value_len);
        if (header->name == nullptr || header->value == nullptr) return false;
        if (client_ci_equal(header->name, header->name_len, "content-length")) {
            if (*has_content_length
                || !client_parse_decimal(header->value, header->value_len,
                                         content_length)) {
                return false;
            }
            *has_content_length = true;
        }
        if (client_ci_equal(header->name, header->name_len, "transfer-encoding")
            ) {
            if (*chunked
                || !client_ci_equal(header->value, header->value_len, "chunked")) {
                return false;
            }
            *chunked = true;
        }
        cursor = end + 2;
    }
    if (*chunked && *has_content_length) return false;
    return true;
}

/* 0 = incomplete, 1 = complete, -1 = malformed/allocation failure. */
static int client_try_response(MalHttpClient *client, bool eof) {
    const byte *body_start = client_header_end(client->response, client->response_len);
    if (body_start == nullptr) {
        return eof || client->response_len > MAL_HTTP_CLIENT_HEADERS_MAX ? -1 : 0;
    }
    usize header_length = (usize) (body_start - client->response);
    MalHttpClientResult *result = calloc(1, sizeof(MalHttpClientResult));
    if (result == nullptr) return -1;
    usize content_length = 0;
    bool has_content_length = false;
    bool chunked = false;
    if (!client_parse_head(client, result, header_length, &content_length,
                           &has_content_length, &chunked)) {
        mal_http_client_result_free(result);
        return -1;
    }
    usize available = client->response_len - header_length;
    usize body_length = available;
    usize raw_consumed = available;
    byte *decoded = nullptr;
    const byte *body_bytes = body_start;
    bool no_body = client->head_request || (result->status >= 100 && result->status < 200)
        || result->status == 204 || result->status == 304;
    if (result->status >= 100 && result->status < 200) {
        mal_http_client_result_free(result);
        return -1;
    }
    if (no_body) {
        body_length = 0;
    } else if (chunked) {
        decoded = malloc(available == 0 ? 1 : available);
        if (decoded == nullptr) {
            mal_http_client_result_free(result);
            return -1;
        }
        if (available > 0) memcpy(decoded, body_start, available);
        MalHttpParse parsed = mal_http_dechunk(
            (char *) decoded, available, &body_length, &raw_consumed);
        if (parsed == MAL_HTTP_INCOMPLETE && !eof) {
            free(decoded);
            mal_http_client_result_free(result);
            return 0;
        }
        if (parsed != MAL_HTTP_OK) {
            free(decoded);
            mal_http_client_result_free(result);
            return -1;
        }
        body_bytes = decoded;
    } else if (has_content_length) {
        if (available < content_length && !eof) {
            mal_http_client_result_free(result);
            return 0;
        }
        if (available < content_length) {
            mal_http_client_result_free(result);
            return -1;
        }
        body_length = content_length;
    } else if (!eof) {
        mal_http_client_result_free(result);
        return 0;
    }
    (void) raw_consumed;
    if (body_length > 0) {
        result->body = malloc(body_length);
        if (result->body == nullptr) {
            free(decoded);
            mal_http_client_result_free(result);
            return -1;
        }
        memcpy(result->body, body_bytes, body_length);
    }
    free(decoded);
    result->body_len = body_length;
    client_complete(client, MAL_HOST_TERMINAL_OK, result);
    return 1;
}

static void client_read_ready(void *data) {
    MalHttpClient *client = data;
    bool eof = false;
    for (;;) {
        if (client->response_len == client->response_capacity) {
            usize capacity = client->response_capacity == 0
                ? MAL_HTTP_CLIENT_READ_INIT : client->response_capacity * 2;
            if (capacity < client->response_capacity) {
                client_fail(client, "HTTP response is too large");
                return;
            }
            byte *grown = realloc(client->response, capacity);
            if (grown == nullptr) {
                client_fail(client, "HTTP response allocation failed");
                return;
            }
            client->response = grown;
            client->response_capacity = capacity;
        }
        ssize_t count = read(
            client->fd, client->response + client->response_len,
            client->response_capacity - client->response_len);
        if (count > 0) {
            client->response_len += (usize) count;
            continue;
        }
        if (count == 0) {
            eof = true;
            break;
        }
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) break;
        client_fail(client, "HTTP response read failed");
        return;
    }
    int parsed = client_try_response(client, eof);
    if (parsed != 0) {
        if (parsed < 0) client_fail(client, "Malformed HTTP response");
        return;
    }
    client->read_op = (MalOp) {
        .fd = client->fd,
        .interest = MAL_IO_READ,
        .waker = {.fn = client_read_ready, .data = client},
    };
    if (!mal_reactor_add_op(&client->host->reactor, &client->read_op)) {
        client_fail(client, "Failed to wait for HTTP response");
    }
}

static void client_write_ready(void *data) {
    MalHttpClient *client = data;
    if (client->connecting) {
        int error = mal_net_socket_error(client->fd);
        if (error != 0) {
            client_fail(client, "HTTP connection failed");
            return;
        }
        client->connecting = false;
    }
    while (client->request_sent < client->request_len) {
        ssize_t count = mal_net_write(
            client->fd, client->request + client->request_sent,
            client->request_len - client->request_sent);
        if (count > 0) {
            client->request_sent += (usize) count;
            continue;
        }
        if (count < 0 && errno == EINTR) continue;
        if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            client->write_op = (MalOp) {
                .fd = client->fd,
                .interest = MAL_IO_WRITE,
                .waker = {.fn = client_write_ready, .data = client},
            };
            if (!mal_reactor_add_op(&client->host->reactor, &client->write_op)) {
                client_fail(client, "Failed to continue HTTP request");
            }
            return;
        }
        client_fail(client, "HTTP request write failed");
        return;
    }
    free(client->request);
    client->request = nullptr;
    client->request_len = 0;
    client_read_ready(client);
}

bool mal_http_client_start(
    MalHost *host, const char *host_name, u16 port, byte *request_bytes,
    usize request_len, bool head_request, MalHostHandle *operation) {
    if (host == nullptr || host_name == nullptr || request_bytes == nullptr
        || request_len == 0 || operation == nullptr
        || !mal_host_operation_start(&host->tasks, operation)) {
        return false;
    }
    MalHttpClient *client = calloc(1, sizeof(MalHttpClient));
    if (client == nullptr) goto fail;
    client->fd = -1;
    client->host = host;
    client->operation = *operation;
    client->request = request_bytes;
    client->request_len = request_len;
    client->head_request = head_request;
    client->fd = mal_net_connect(host_name, port);
    if (client->fd < 0) goto fail_client;
    client->connecting = true;
    client->write_op = (MalOp) {
        .fd = client->fd,
        .interest = MAL_IO_WRITE,
        .waker = {.fn = client_write_ready, .data = client},
    };
    if (!mal_reactor_add_op(&host->reactor, &client->write_op)
        || !mal_host_operation_activate(&host->tasks, *operation)) {
        goto fail_client;
    }
    return true;

fail_client:
    client->request = nullptr;
    client_destroy(client);
fail:
    (void) mal_host_operation_abort_start(&host->tasks, *operation);
    return false;
}
