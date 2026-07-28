#include "http_client.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "host.h"
#include "net.h"
#include "reactor.h"

#define MAL_HTTP_CLIENT_IO_TURN (64 * 1024)
#define MAL_HTTP_CLIENT_READ_INIT 4096
#define MAL_HTTP_CLIENT_READ_MAX (256 * 1024)
#define MAL_HTTP_CLIENT_WRITE_MAX (256 * 1024)

typedef struct MalHttpClientWireWrite {
    byte prefix[32];
    usize prefix_length;
    usize prefix_offset;
    byte *bytes;
    usize length;
    usize offset;
    byte suffix[8];
    usize suffix_length;
    usize suffix_offset;
    usize plain_length;
    u64 token;
    bool notify;
    bool end_stream;
    struct MalHttpClientWireWrite *next;
} MalHttpClientWireWrite;

typedef struct MalHttpClient {
    MalHost *host;
    MalHostHandle operation;
    int fd;
    MalOp read_op;
    MalOp write_op;

    MalHttpCodec codec;
    byte *read_buffer;
    usize read_length;
    usize read_capacity;
    usize read_credit;

    MalHttpClientWireWrite *write_head;
    MalHttpClientWireWrite *write_tail;
    usize queued_plain_bytes;
    i64 request_remaining;

    bool connecting;
    bool read_ended;
    bool request_chunked;
    bool request_final_queued;
    bool request_complete;
    bool response_head_seen;
    bool response_has_body;
    bool response_complete;
    bool head_request;
    bool retained_work;
    struct MalHttpClient *next;
} MalHttpClient;

static void client_read_ready(void *data);
static void client_write_ready(void *data);
static void client_process_response(MalHttpClient *client);

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
    free(result->error);
    free(result);
}

void mal_http_client_progress_free(void *data) {
    MalHttpClientProgress *progress = data;
    if (progress == nullptr) return;
    mal_http_codec_head_free(progress->head);
    free(progress->bytes);
    free(progress);
}

static MalHttpClient *client_find(MalHost *host, MalHostHandle operation) {
    if (host == nullptr || operation == 0) return nullptr;
    for (MalHttpClient *client = host->http_clients;
         client != nullptr; client = client->next) {
        if (client->operation == operation) return client;
    }
    return nullptr;
}

static void client_destroy(MalHttpClient *client) {
    if (client == nullptr) return;
    MalHttpClient **link = &client->host->http_clients;
    while (*link != nullptr && *link != client) link = &(*link)->next;
    if (*link == client) *link = client->next;
    (void) mal_reactor_cancel_op(&client->host->reactor, &client->read_op);
    (void) mal_reactor_cancel_op(&client->host->reactor, &client->write_op);
    if (client->fd >= 0) mal_net_close(client->fd);
    mal_http_codec_free(&client->codec);
    free(client->read_buffer);
    MalHttpClientWireWrite *write = client->write_head;
    while (write != nullptr) {
        MalHttpClientWireWrite *next = write->next;
        free(write->bytes);
        free(write);
        write = next;
    }
    if (client->retained_work) {
        (void) mal_reactor_release_work(&client->host->reactor);
    }
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
    MalHttpClientResult *result = calloc(1, sizeof(*result));
    if (result != nullptr) result->error = client_copy(message, strlen(message));
    client_complete(client, MAL_HOST_TERMINAL_ERROR, result);
}

static bool client_progress(
    MalHttpClient *client, MalHttpClientProgress *progress) {
    if (mal_host_operation_progress(
            &client->host->tasks, client->operation, progress,
            mal_http_client_progress_free)) {
        return true;
    }
    mal_http_client_progress_free(progress);
    return false;
}

static void client_maybe_complete(MalHttpClient *client) {
    if (client->request_complete && client->response_complete) {
        client_complete(client, MAL_HOST_TERMINAL_OK, nullptr);
    }
}

static bool client_arm_read(MalHttpClient *client) {
    if (client->read_op.active || client->read_ended
        || (client->response_complete && client->request_complete)) {
        return true;
    }
    client->read_op = (MalOp) {
        .fd = client->fd,
        .interest = MAL_IO_READ,
        .waker = {.fn = client_read_ready, .data = client},
    };
    return mal_reactor_add_op(&client->host->reactor, &client->read_op);
}

static bool client_arm_write(MalHttpClient *client) {
    if (client->write_op.active) return true;
    client->write_op = (MalOp) {
        .fd = client->fd,
        .interest = MAL_IO_WRITE,
        .waker = {.fn = client_write_ready, .data = client},
    };
    return mal_reactor_add_op(&client->host->reactor, &client->write_op);
}

static void client_queue_write(
    MalHttpClient *client, MalHttpClientWireWrite *write) {
    if (client->write_tail == nullptr) client->write_head = write;
    else client->write_tail->next = write;
    client->write_tail = write;
}

static void client_consume_read(MalHttpClient *client, usize consumed) {
    if (consumed == 0) return;
    usize remaining = client->read_length - consumed;
    memmove(client->read_buffer, client->read_buffer + consumed, remaining);
    client->read_length = remaining;
}

static bool client_publish_head(
    MalHttpClient *client, MalHttpCodecHead *head) {
    MalHttpClientProgress *progress = calloc(1, sizeof(*progress));
    if (progress == nullptr) return false;
    progress->kind = MAL_HTTP_CLIENT_PROGRESS_RESPONSE_HEAD;
    progress->head = head;
    if (!client_progress(client, progress)) return false;
    client->response_head_seen = true;
    client->response_has_body = !client->head_request
        && !((head->status_code >= 100 && head->status_code < 200)
             || head->status_code == 204 || head->status_code == 304);
    return true;
}

static bool client_handle_response_event(MalHttpClient *client) {
    MalHttpCodecEventKind event = mal_http_codec_event(&client->codec);
    if (event == MAL_HTTP_CODEC_EVENT_HEAD) {
        MalHttpCodecHead *head = mal_http_codec_take_head(&client->codec);
        if (head == nullptr || head->upgrade || head->status_code == 101) {
            mal_http_codec_head_free(head);
            return false;
        }
        if (head->status_code >= 100 && head->status_code < 200) {
            mal_http_codec_head_free(head);
            return true;
        }
        return client_publish_head(client, head);
    }
    if (event == MAL_HTTP_CODEC_EVENT_BODY) {
        usize length = 0;
        byte *bytes = mal_http_codec_take_body(&client->codec, &length);
        if (bytes == nullptr || !client->response_head_seen
            || length > client->read_credit) {
            free(bytes);
            return false;
        }
        client->read_credit -= length;
        MalHttpClientProgress *progress = calloc(1, sizeof(*progress));
        if (progress == nullptr) {
            free(bytes);
            return false;
        }
        progress->kind = MAL_HTTP_CLIENT_PROGRESS_RESPONSE_BODY;
        progress->bytes = bytes;
        progress->length = length;
        return client_progress(client, progress);
    }
    if (event == MAL_HTTP_CODEC_EVENT_COMPLETE) {
        mal_http_codec_clear_event(&client->codec);
        if (!client->response_head_seen) return true;
        MalHttpClientProgress *progress = calloc(1, sizeof(*progress));
        if (progress == nullptr) return false;
        progress->kind = MAL_HTTP_CLIENT_PROGRESS_RESPONSE_COMPLETE;
        if (!client_progress(client, progress)) return false;
        client->response_complete = true;
        return true;
    }
    return true;
}

static void client_process_response(MalHttpClient *client) {
    usize turn = 0;
    while (turn < MAL_HTTP_CLIENT_IO_TURN && !client->response_complete) {
        if (mal_http_codec_event(&client->codec) != MAL_HTTP_CODEC_EVENT_NONE) {
            if (!client_handle_response_event(client)) {
                client_fail(client, "Malformed HTTP response");
                return;
            }
            if (client->response_complete) {
                if (client->request_complete) {
                    client_maybe_complete(client);
                }
                return;
            }
            continue;
        }
        bool body_blocked = client->response_head_seen
            && client->response_has_body && client->read_credit == 0;
        if (body_blocked) return;
        usize supplied = client->read_length;
        if (supplied > MAL_HTTP_CODEC_BODY_MAX) supplied = MAL_HTTP_CODEC_BODY_MAX;
        if (supplied > MAL_HTTP_CLIENT_IO_TURN - turn) {
            supplied = MAL_HTTP_CLIENT_IO_TURN - turn;
        }
        if (client->response_head_seen && client->response_has_body
            && supplied > client->read_credit) {
            supplied = client->read_credit;
        }
        usize consumed = 0;
        MalHttpCodecResult result = mal_http_codec_execute(
            &client->codec, client->read_buffer, supplied, &consumed);
        if (consumed > supplied) {
            client_fail(client, "Malformed HTTP response");
            return;
        }
        client_consume_read(client, consumed);
        turn += consumed;
        if (result == MAL_HTTP_CODEC_ERROR) {
            client_fail(client, "Malformed HTTP response");
            return;
        }
        if (result == MAL_HTTP_CODEC_EVENT || consumed > 0) continue;
        if (client->read_ended) {
            result = mal_http_codec_finish(&client->codec);
            if (result == MAL_HTTP_CODEC_ERROR) {
                client_fail(client, "Truncated HTTP response");
                return;
            }
            if (result == MAL_HTTP_CODEC_EVENT) continue;
            client_fail(client, "Truncated HTTP response");
            return;
        }
        if (!client_arm_read(client)) {
            client_fail(client, "Failed to wait for HTTP response");
        }
        return;
    }
    if (!client->response_complete && !client_arm_read(client)) {
        client_fail(client, "Failed to continue HTTP response");
    }
}

static void client_read_ready(void *data) {
    MalHttpClient *client = data;
    if (client->response_complete) {
        byte discard[4096];
        usize turn = 0;
        while (turn < MAL_HTTP_CLIENT_IO_TURN) {
            ssize_t count = read(client->fd, discard, sizeof(discard));
            if (count > 0) {
                turn += (usize) count;
                continue;
            }
            if (count == 0) {
                client_fail(
                    client, "HTTP peer closed before request upload completed");
                return;
            }
            if (errno == EINTR) continue;
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                if (!client_arm_read(client)) {
                    client_fail(client, "Failed to monitor HTTP peer");
                }
                return;
            }
            client_fail(client, "HTTP response read failed");
            return;
        }
        if (!client_arm_read(client)) {
            client_fail(client, "Failed to monitor HTTP peer");
        }
        return;
    }
    usize turn = 0;
    while (turn < MAL_HTTP_CLIENT_IO_TURN) {
        if (client->read_length == client->read_capacity) {
            usize capacity = client->read_capacity == 0
                ? MAL_HTTP_CLIENT_READ_INIT : client->read_capacity * 2;
            if (capacity > MAL_HTTP_CLIENT_IO_TURN) capacity = MAL_HTTP_CLIENT_IO_TURN;
            if (capacity <= client->read_capacity) {
                client_fail(client, "HTTP response staging limit exceeded");
                return;
            }
            byte *grown = realloc(client->read_buffer, capacity);
            if (grown == nullptr) {
                client_fail(client, "HTTP response allocation failed");
                return;
            }
            client->read_buffer = grown;
            client->read_capacity = capacity;
        }
        usize available = client->read_capacity - client->read_length;
        if (available > MAL_HTTP_CLIENT_IO_TURN - turn) {
            available = MAL_HTTP_CLIENT_IO_TURN - turn;
        }
        ssize_t count = read(
            client->fd, client->read_buffer + client->read_length, available);
        if (count > 0) {
            usize length = (usize) count;
            client->read_length += length;
            turn += length;
            continue;
        }
        if (count == 0) {
            client->read_ended = true;
            break;
        }
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) break;
        client_fail(client, "HTTP response read failed");
        return;
    }
    client_process_response(client);
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
        if (!client_arm_read(client)) {
            client_fail(client, "Failed to wait for HTTP response");
            return;
        }
    }
    usize turn = 0;
    while (client->write_head != nullptr && turn < MAL_HTTP_CLIENT_IO_TURN) {
        MalHttpClientWireWrite *write = client->write_head;
        byte *bytes;
        usize available;
        bool body = false;
        if (write->prefix_offset < write->prefix_length) {
            bytes = write->prefix + write->prefix_offset;
            available = write->prefix_length - write->prefix_offset;
        } else if (write->offset < write->length) {
            bytes = write->bytes + write->offset;
            available = write->length - write->offset;
            body = write->plain_length > 0;
        } else if (write->suffix_offset < write->suffix_length) {
            bytes = write->suffix + write->suffix_offset;
            available = write->suffix_length - write->suffix_offset;
        } else {
            client->write_head = write->next;
            if (client->write_head == nullptr) client->write_tail = nullptr;
            bool notify = write->notify;
            bool end_stream = write->end_stream;
            u64 token = write->token;
            usize plain_length = write->plain_length;
            free(write->bytes);
            free(write);
            if (notify) {
                MalHttpClientProgress *progress = calloc(1, sizeof(*progress));
                if (progress == nullptr) {
                    client_fail(client, "HTTP write completion allocation failed");
                    return;
                }
                progress->kind = MAL_HTTP_CLIENT_PROGRESS_WRITE_COMPLETE;
                progress->token = token;
                progress->length = plain_length;
                progress->end_stream = end_stream;
                if (!client_progress(client, progress)) {
                    client_fail(client, "HTTP write completion queue failed");
                    return;
                }
            }
            if (end_stream) {
                client->request_complete = true;
                client_maybe_complete(client);
                return;
            }
            continue;
        }
        if (available > MAL_HTTP_CLIENT_IO_TURN - turn) {
            available = MAL_HTTP_CLIENT_IO_TURN - turn;
        }
        ssize_t count = mal_net_write(client->fd, bytes, available);
        if (count > 0) {
            usize length = (usize) count;
            turn += length;
            if (write->prefix_offset < write->prefix_length) {
                write->prefix_offset += length;
            } else if (body) {
                write->offset += length;
                client->queued_plain_bytes -= length;
            } else if (write->offset < write->length) {
                write->offset += length;
            } else {
                write->suffix_offset += length;
            }
            continue;
        }
        if (count < 0 && errno == EINTR) continue;
        if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            if (!client_arm_write(client)) {
                client_fail(client, "Failed to continue HTTP request");
            }
            return;
        }
        client_fail(client, "HTTP request write failed");
        return;
    }
    if (client->write_head != nullptr && !client_arm_write(client)) {
        client_fail(client, "Failed to continue HTTP request");
    }
}

bool mal_http_client_start(
    MalHost *host, const char *host_name, u16 port, byte *request_head,
    usize request_head_len, i64 content_length, bool head_request,
    MalHostHandle *operation) {
    if (host == nullptr || host_name == nullptr || request_head == nullptr
        || request_head_len == 0 || content_length < -1 || operation == nullptr
        || !mal_host_operation_start(&host->tasks, operation)) {
        return false;
    }
    MalHttpClient *client = calloc(1, sizeof(*client));
    if (client == nullptr) goto fail;
    client->host = host;
    client->operation = *operation;
    client->fd = -1;
    client->head_request = head_request;
    client->request_chunked = content_length < 0;
    client->request_remaining = content_length;
    if (!mal_reactor_retain_work(&host->reactor)) goto fail_client;
    client->retained_work = true;
    if (!mal_http_codec_init(&client->codec, HTTP_RESPONSE)) goto fail_client;
    mal_http_codec_set_skip_body(&client->codec, head_request);

    const char *framing = client->request_chunked
        ? "Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
        : nullptr;
    char fixed_framing[128];
    int framing_length = client->request_chunked
        ? (int) strlen(framing)
        : snprintf(
            fixed_framing, sizeof(fixed_framing),
            "Content-Length: %lld\r\nConnection: close\r\n\r\n",
            (long long) content_length);
    if (framing_length < 0
        || request_head_len > SIZE_MAX - (usize) framing_length) {
        goto fail_client;
    }
    usize head_length = request_head_len + (usize) framing_length;
    byte *head_bytes = malloc(head_length);
    MalHttpClientWireWrite *head = calloc(1, sizeof(*head));
    if (head_bytes == nullptr || head == nullptr) {
        free(head_bytes);
        free(head);
        goto fail_client;
    }
    memcpy(head_bytes, request_head, request_head_len);
    memcpy(
        head_bytes + request_head_len,
        client->request_chunked ? framing : fixed_framing,
        (usize) framing_length);
    head->bytes = head_bytes;
    head->length = head_length;
    client_queue_write(client, head);

    client->fd = mal_net_connect(host_name, port);
    if (client->fd < 0) goto fail_client;
    client->connecting = true;
    client->next = host->http_clients;
    host->http_clients = client;
    if (!client_arm_write(client)
        || !mal_host_operation_activate(&host->tasks, *operation)) {
        goto fail_linked;
    }
    free(request_head);
    return true;

fail_linked:
    client_destroy(client);
    (void) mal_host_operation_abort_start(&host->tasks, *operation);
    return false;
fail_client:
    client_destroy(client);
fail:
    (void) mal_host_operation_abort_start(&host->tasks, *operation);
    return false;
}

MalHttpClientWriteResult mal_http_client_write_owned(
    MalHost *host, MalHostHandle operation, byte *bytes, usize length,
    u64 token, bool end_stream) {
    MalHttpClient *client = client_find(host, operation);
    if (client == nullptr || bytes == nullptr || client->request_final_queued) {
        return MAL_HTTP_CLIENT_WRITE_CLOSED;
    }
    if (length > MAL_HTTP_CLIENT_WRITE_MAX - client->queued_plain_bytes) {
        return MAL_HTTP_CLIENT_WRITE_WOULD_BLOCK;
    }
    if (client->request_remaining >= 0
        && ((u64) length > (u64) client->request_remaining
            || (end_stream && (u64) length != (u64) client->request_remaining))) {
        return MAL_HTTP_CLIENT_WRITE_CLOSED;
    }
    MalHttpClientWireWrite *write = calloc(1, sizeof(*write));
    if (write == nullptr) return MAL_HTTP_CLIENT_WRITE_WOULD_BLOCK;
    write->bytes = bytes;
    write->length = length;
    write->plain_length = length;
    write->token = token;
    write->notify = true;
    write->end_stream = end_stream;
    if (client->request_chunked) {
        if (length > 0) {
            int prefix_length = snprintf(
                (char *) write->prefix, sizeof(write->prefix), "%zx\r\n", length);
            if (prefix_length < 0 || (usize) prefix_length >= sizeof(write->prefix)) {
                write->bytes = nullptr;
                free(write);
                return MAL_HTTP_CLIENT_WRITE_CLOSED;
            }
            write->prefix_length = (usize) prefix_length;
            const char *suffix = end_stream ? "\r\n0\r\n\r\n" : "\r\n";
            write->suffix_length = end_stream ? 7 : 2;
            memcpy(write->suffix, suffix, write->suffix_length);
        } else if (end_stream) {
            memcpy(write->suffix, "0\r\n\r\n", 5);
            write->suffix_length = 5;
        }
    }
    client->queued_plain_bytes += length;
    if (client->request_remaining >= 0) client->request_remaining -= (i64) length;
    if (end_stream) client->request_final_queued = true;
    bool was_empty = client->write_tail == nullptr;
    client_queue_write(client, write);
    if (was_empty && !client->connecting) client_write_ready(client);
    return MAL_HTTP_CLIENT_WRITE_ACCEPTED;
}

bool mal_http_client_read_credit(
    MalHost *host, MalHostHandle operation, usize bytes) {
    MalHttpClient *client = client_find(host, operation);
    if (client == nullptr || bytes == 0 || client->response_complete
        || bytes > MAL_HTTP_CLIENT_READ_MAX - client->read_credit) {
        return false;
    }
    client->read_credit += bytes;
    client_process_response(client);
    return true;
}

bool mal_http_client_response_complete_ack(
    MalHost *host, MalHostHandle operation) {
    MalHttpClient *client = client_find(host, operation);
    if (client == nullptr) return true;
    if (!client->response_complete || client->request_complete) return false;
    if (client->read_ended) {
        client_fail(client, "HTTP peer closed before request upload completed");
        return true;
    }
    if (!client_arm_read(client)) {
        client_fail(client, "Failed to monitor HTTP peer");
    }
    return true;
}

bool mal_http_client_cancel(MalHost *host, MalHostHandle operation) {
    if (host == nullptr || operation == 0) return false;
    MalHttpClient *client = client_find(host, operation);
    if (client != nullptr) {
        if (!mal_host_operation_cancel(&host->tasks, operation)) return false;
        client_destroy(client);
        return true;
    }
    return mal_host_operation_cancel(&host->tasks, operation);
}

void mal_http_client_shutdown(MalHost *host) {
    if (host == nullptr) return;
    while (host->http_clients != nullptr) {
        MalHttpClient *client = host->http_clients;
        (void) mal_host_operation_cancel(&host->tasks, client->operation);
        client_destroy(client);
    }
}
