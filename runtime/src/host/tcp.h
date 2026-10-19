#pragma once

#include "./defaults.h"
#include "host_task.h"
#include "net.h"

#include <sys/socket.h>

typedef struct MalHost MalHost;
typedef struct MalTlsClient MalTlsClient;
typedef struct MalTlsServerConfig MalTlsServerConfig;

typedef enum MalTcpProgressKind {
    MAL_TCP_CONNECTED = 1,
    MAL_TCP_SECURE_CONNECTED,
    MAL_TCP_DATA,
    MAL_TCP_WRITE_COMPLETE,
    /* A listener accepted a connection, now live on `accepted` with reads paused. */
    MAL_TCP_ACCEPTED,
    /* A ClientHello awaits mal_tcp_tls_select; `bytes` holds its server name, null when absent. */
    MAL_TCP_TLS_CLIENT_HELLO,
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
    /* OpenSSL's reason text for an EPROTO TLS failure with a known cause, else empty. */
    char tls_failure[48];
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
/* A client certificate chain and its private key; empty halves present no certificate. */
typedef struct MalTlsClientIdentity {
    const byte *cert_pem;
    usize cert_pem_length;
    const byte *key_pem;
    usize key_pem_length;
} MalTlsClientIdentity;

/* The leaf peer certificate's DER length (copying at most `capacity`), or -1 without one. */
i64 mal_tcp_tls_peer_certificate(MalHost *host, MalHostHandle operation, byte *output, usize capacity);
/* Reads the ClientHello first and reports it, so the caller picks the config by server name. */
bool mal_tcp_start_tls_server_sni(MalHost *host, MalHostHandle operation);
/* Continues a reported ClientHello under `config`; false ends the connection with EPROTO. */
bool mal_tcp_tls_select(MalHost *host, MalHostHandle operation, const MalTlsServerConfig *config);
bool mal_tcp_start_tls(
    MalHost *host, MalHostHandle operation,
    const byte *server_name, usize server_name_length,
    const byte *ca_pem, usize ca_pem_length,
    const byte *alpn, usize alpn_length, const MalTlsClientIdentity *identity, bool insecure);
/* Starts the server role on an accepted connection; the session borrows `config`. */
bool mal_tcp_start_tls_server(
    MalHost *host, MalHostHandle operation, const MalTlsServerConfig *config);
/* mal_tls_session_info for the connection's session, or -1 without one. */
i64 mal_tcp_tls_info(
    MalHost *host, MalHostHandle operation, int kind, byte *output, usize output_length);
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
    const byte *alpn, usize alpn_length, const MalTlsClientIdentity *identity, bool insecure,
    MalTlsClient **out);
