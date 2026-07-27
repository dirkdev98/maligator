#pragma once

#include "./defaults.h"
#include "host_task.h"

typedef struct MalHost MalHost;

typedef enum MalTcpProgressKind {
    MAL_TCP_CONNECTED = 1,
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
bool mal_tcp_write_owned(
    MalHost *host, MalHostHandle operation, byte *bytes, usize length,
    u64 write_token);
bool mal_tcp_shutdown_write(MalHost *host, MalHostHandle operation);
bool mal_tcp_cancel(MalHost *host, MalHostHandle operation);
void mal_tcp_shutdown(MalHost *host);
