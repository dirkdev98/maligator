#pragma once

#include "./defaults.h"

/*
 * Synchronous child-process spawning (host layer, behind surface.node / MAL_NODE).
 *
 * A thin, engine-neutral POSIX wrapper the `node:child_process` runtime layer
 * sits on: it knows only C strings, fds, and byte buffers — no MalValue, no GC,
 * no JS. It launches an executable with fork/exec (never a shell), wires up its
 * three standard streams per the requested modes, drains stdout/stderr and feeds
 * stdin concurrently (so a child that fills one pipe while the parent blocks on
 * another never deadlocks), and reports how the child terminated. PATH lookup
 * and the final exec happen in the forked child using async-signal-safe calls
 * only; launch failures (ENOENT, EACCES, a bad cwd) travel back to the parent
 * over a close-on-exec error pipe. Pipe endpoints are kept above fd 2 so this
 * remains safe when the parent entered with one or more standard fds closed.
 */

/* How one of the child's standard streams is connected. */
typedef enum MalProcStdio {
    MAL_PROC_STDIO_PIPE = 0, /* parent captures (out/err) or feeds (in) via a pipe */
    MAL_PROC_STDIO_INHERIT,  /* share the parent's own fd (0/1/2) */
    MAL_PROC_STDIO_IGNORE,   /* redirect to /dev/null */
} MalProcStdio;

/* A fully-resolved spawn request. All strings are NUL-terminated C strings. */
typedef struct MalProcRequest {
    const char *file;    /* executable; PATH-searched when it contains no '/' */
    char *const *argv;   /* NULL-terminated; argv[0] is conventionally `file` */
    char *const *envp;   /* NULL-terminated environment, or NULL to inherit the parent's */
    const char *cwd;     /* working directory to chdir into, or NULL to keep the parent's */
    MalProcStdio stdin_mode;
    MalProcStdio stdout_mode;
    MalProcStdio stderr_mode;
    const byte *input;   /* bytes fed to stdin when stdin_mode is PIPE (may be NULL) */
    usize input_len;
} MalProcRequest;

/* How the child terminated plus any captured output. */
typedef struct MalProcResult {
    bool launched;    /* true once the child image was successfully exec'd */
    int launch_errno; /* errno of the launch failure when !launched */

    bool exited;      /* child terminated by returning / exit() */
    int exit_status;  /* exit code (valid when `exited`) */
    bool signaled;    /* child terminated by an uncaught signal */
    int term_signal;  /* signal number (valid when `signaled`) */

    byte *stdout_data; /* heap-owned captured stdout, NUL-terminated; NULL unless PIPE */
    usize stdout_len;
    byte *stderr_data; /* heap-owned captured stderr, NUL-terminated; NULL unless PIPE */
    usize stderr_len;

    int io_errno; /* errno of a parent-side I/O / wait failure (0 when none) */
} MalProcResult;

/*
 * Launch `req` and wait for it to finish, wiring stdio per the request. Zeroes
 * `*out` first. Returns 0 when the child was launched and reaped — inspect
 * `out->exited` / `out->signaled` / `out->exit_status` / `out->term_signal` for
 * how it ended — and -1 when the child could not be launched or the parent-side
 * machinery failed (then `out->launched` is false and `out->launch_errno` or
 * `out->io_errno` explains why). Captured buffers are heap-owned; release them
 * (and reset the result) with mal_proc_result_dispose.
 */
int mal_proc_run(const MalProcRequest *req, MalProcResult *out);

/* Free any captured buffers held by `out` and clear their pointers. Idempotent. */
void mal_proc_result_dispose(MalProcResult *out);

/* Short name of a signal ("SIGSEGV"), or NULL when the number is unknown. */
const char *mal_proc_signal_name(int sig);
