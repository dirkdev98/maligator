#pragma once

#include "./defaults.h"
#include "host_task.h"
#include "net.h"

#include <sys/socket.h>

typedef struct MalHost MalHost;
typedef struct MalTlsClient MalTlsClient;

typedef enum MalTcpProgressKind {
    MAL_TCP_CONNECTED = 1,
    MAL_TCP_SECURE_CONNECTED,
    MAL_TCP_DATA,
    MAL_TCP_WRITE_COMPLETE,
    /* A listener accepted a connection, now live on `accepted` with reads paused. */
    MAL_TCP_ACCEPTED,
} MalTcpProgressKind;

typedef struct MalTcpProgress {
    MalTcpProgressKind kind;
    byte *bytes;
    usize length;
    u64 write_token;
    MalHostHandle accepted;
} MalTcpProgress;

typedef struct MalTcpTerminal {
    int error;
} MalTcpTerminal;

void mal_tcp_progress_free(void *data);
void mal_tcp_terminal_free(void *data);

bool mal_tcp_connect_start(
    MalHost *host, const char *numeric_host, u16 port,
    MalHostHandle *operation);
bool mal_tcp_connect_address_start(
    MalHost *host, const struct sockaddr *address, socklen_t length,
    MalHostHandle *operation);
bool mal_tcp_write_owned(
    MalHost *host, MalHostHandle operation, byte *bytes, usize length,
    u64 write_token);
bool mal_tcp_shutdown_write(MalHost *host, MalHostHandle operation);
bool mal_tcp_read_pause(MalHost *host, MalHostHandle operation);
bool mal_tcp_read_resume(MalHost *host, MalHostHandle operation);
bool mal_tcp_set_keep_alive(
    MalHost *host, MalHostHandle operation, bool enabled, u32 initial_delay_ms);
bool mal_tcp_set_no_delay(MalHost *host, MalHostHandle operation, bool enabled);
bool mal_tcp_start_tls(
    MalHost *host, MalHostHandle operation,
    const byte *server_name, usize server_name_length,
    const byte *ca_pem, usize ca_pem_length,
    const byte *alpn, usize alpn_length, bool insecure);
bool mal_tcp_cancel(MalHost *host, MalHostHandle operation);

/* Listening sockets: 0 or the bind/listen errno. Accepts arrive as MAL_TCP_ACCEPTED
 * progress on `operation`; close completes it with an OK terminal. */
int mal_tcp_listen_start(
    MalHost *host, const struct sockaddr *address, socklen_t length, int backlog, bool ipv6_only,
    MalHostHandle *operation);
bool mal_tcp_listen_endpoint(MalHost *host, MalHostHandle operation, MalNetEndpoint *out);
bool mal_tcp_listen_pause(MalHost *host, MalHostHandle operation, bool paused);
/* An unreferenced listener accepts connections but does not keep the event loop alive. */
bool mal_tcp_listen_set_referenced(MalHost *host, MalHostHandle operation, bool referenced);
bool mal_tcp_listen_close(MalHost *host, MalHostHandle operation);
bool mal_tcp_connection_endpoints(
    MalHost *host, MalHostHandle operation, MalNetEndpoint *local, MalNetEndpoint *remote);
void mal_tcp_shutdown(MalHost *host);

/* An explicit CA replaces defaults; otherwise use host roots plus NODE_EXTRA_CA_CERTS. */
int mal_tcp_tls_create_client(
    const byte *server_name, usize server_name_length,
    const byte *ca_pem, usize ca_pem_length,
    const byte *alpn, usize alpn_length, bool insecure, MalTlsClient **out);
