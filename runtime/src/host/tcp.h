#pragma once

#include "./defaults.h"
#include "host_task.h"

#include <sys/socket.h>

typedef struct MalHost MalHost;

typedef enum MalTcpProgressKind {
    MAL_TCP_CONNECTED = 1,
    MAL_TCP_SECURE_CONNECTED,
    MAL_TCP_DATA,
    MAL_TCP_WRITE_COMPLETE,
} MalTcpProgressKind;

typedef struct MalTcpProgress {
    MalTcpProgressKind kind;
    byte *bytes;
    usize length;
    u64 write_token;
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
void mal_tcp_shutdown(MalHost *host);
