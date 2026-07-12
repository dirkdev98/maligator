#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif

#include "posix_process.h"

#if MAL_NODE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <crt_externs.h>
#else
extern char **environ;
#endif

/* ---------------------------------------------------------------------------
 * Small async-signal-safe helpers (usable on both sides of the fork).
 * --------------------------------------------------------------------------- */

static usize mal_proc_cstr_len(const char *s) {
    usize n = 0;
    while (s[n] != '\0') {
        n++;
    }
    return n;
}

static bool mal_proc_has_slash(const char *s) {
    for (usize i = 0; s[i] != '\0'; i++) {
        if (s[i] == '/') {
            return true;
        }
    }
    return false;
}

/* Value of NAME in a NULL-terminated envp, or NULL when absent. */
static const char *mal_proc_env_value(char *const *envp, const char *name) {
    usize name_len = mal_proc_cstr_len(name);
    for (usize i = 0; envp[i] != NULL; i++) {
        const char *e = envp[i];
        usize j = 0;
        while (j < name_len && e[j] == name[j]) {
            j++;
        }
        if (j == name_len && e[j] == '=') {
            return e + name_len + 1;
        }
    }
    return NULL;
}

static int mal_proc_set_cloexec(int fd) {
    int flags = fcntl(fd, F_GETFD, 0);
    if (flags < 0) {
        return -1;
    }
    return fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
}

static int mal_proc_set_nonblock(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0) {
        return -1;
    }
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

/* Keep pipe endpoints away from dup2's standard-stream targets. pipe() may
 * return 0/1/2 when the parent closed stdio; retaining those numbers lets an
 * earlier stream dup overwrite a later stream or the launch-error writer. */
static int mal_proc_move_above_stdio(int fd) {
    if (fd > STDERR_FILENO) {
        return fd;
    }
    int moved = fcntl(fd, F_DUPFD_CLOEXEC, STDERR_FILENO + 1);
    if (moved < 0) {
        return -1;
    }
    close(fd);
    return moved;
}

/* A pipe with both ends close-on-exec (darwin lacks pipe2). */
static int mal_proc_make_pipe(int fds[2]) {
    if (pipe(fds) != 0) {
        return -1;
    }
    for (usize i = 0; i < 2; i++) {
        int moved = mal_proc_move_above_stdio(fds[i]);
        if (moved < 0) {
            int e = errno;
            close(fds[0]);
            close(fds[1]);
            fds[0] = fds[1] = -1;
            errno = e;
            return -1;
        }
        fds[i] = moved;
    }
    if (mal_proc_set_cloexec(fds[0]) != 0 || mal_proc_set_cloexec(fds[1]) != 0) {
        int e = errno;
        close(fds[0]);
        close(fds[1]);
        fds[0] = fds[1] = -1;
        errno = e;
        return -1;
    }
    return 0;
}

static void mal_proc_close_pipe(int fds[2]) {
    if (fds[0] >= 0) {
        close(fds[0]);
        fds[0] = -1;
    }
    if (fds[1] >= 0) {
        close(fds[1]);
        fds[1] = -1;
    }
}

/* ---------------------------------------------------------------------------
 * Child side. Everything below runs after fork() in the child and must stay
 * async-signal-safe: no malloc, no stdio, no GC, no JS — only the reentrant
 * syscalls (dup2/open/close/chdir/execve/write/_exit). The request and its
 * strings are read straight from the shared copy-on-write image.
 * --------------------------------------------------------------------------- */

/* Report a launch failure to the parent over the error pipe and give up. */
static void mal_proc_child_fail(int errpipe) {
    int err = errno;
    const byte *data = (const byte *) &err;
    usize off = 0;
    while (off < sizeof(err)) {
        ssize_t n = write(errpipe, data + off, sizeof(err) - off);
        if (n > 0) {
            off += (usize) n;
        } else if (n < 0 && errno != EINTR) {
            break;
        }
    }
    _exit(127);
}

/* dup2(fd, fd) does not clear FD_CLOEXEC, which matters when a parent standard
 * descriptor was closed and pipe/open reused its number. */
static bool mal_proc_child_dup(int fd, int target) {
    if (fd == target) {
        return fcntl(fd, F_SETFD, 0) == 0;
    }
    return dup2(fd, target) >= 0;
}

/* Point fd `target` at /dev/null with the given access mode. */
static bool mal_proc_child_devnull(int target, int oflag) {
    int fd = open("/dev/null", oflag | O_CLOEXEC);
    if (fd < 0) {
        return false;
    }
    bool ok = mal_proc_child_dup(fd, target);
    if (fd != target) {
        close(fd);
    }
    return ok;
}

/* Wire one standard stream. `pipe_fd` is the pipe end for PIPE mode (else -1). */
static bool mal_proc_child_stream(MalProcStdio mode, int target, int pipe_fd, int devnull_oflag) {
    switch (mode) {
        case MAL_PROC_STDIO_PIPE:
            return mal_proc_child_dup(pipe_fd, target);
        case MAL_PROC_STDIO_IGNORE:
            return mal_proc_child_devnull(target, devnull_oflag);
        case MAL_PROC_STDIO_INHERIT:
        default:
            return true;
    }
}

/* Resolve `file` against PATH and execve it. Returns only on failure (errno set). */
static void mal_proc_child_exec(const MalProcRequest *req, char *const *envp) {
    if (mal_proc_has_slash(req->file)) {
        execve(req->file, req->argv, envp);
        return;
    }

    const char *path = mal_proc_env_value(envp, "PATH");
    if (path == NULL) {
        path = "/usr/bin:/bin"; /* confstr(_CS_PATH) is not async-signal-safe */
    }

    char buf[PATH_MAX];
    usize file_len = mal_proc_cstr_len(req->file);
    int found_errno = ENOENT;
    const char *seg = path;
    for (;;) {
        const char *end = seg;
        while (*end != '\0' && *end != ':') {
            end++;
        }
        /* An empty segment (leading/trailing/`::`) means the current directory. */
        const char *dir = seg;
        usize dir_len = (usize) (end - seg);
        if (dir_len == 0) {
            dir = ".";
            dir_len = 1;
        }
        if (dir_len + 1 + file_len + 1 <= (usize) sizeof(buf)) {
            for (usize i = 0; i < dir_len; i++) {
                buf[i] = dir[i];
            }
            buf[dir_len] = '/';
            for (usize i = 0; i < file_len; i++) {
                buf[dir_len + 1 + i] = req->file[i];
            }
            buf[dir_len + 1 + file_len] = '\0';
            execve(buf, req->argv, envp);
            /* Remember a permission failure but keep looking for a runnable match. */
            if (errno == EACCES) {
                found_errno = EACCES;
            } else if (errno != ENOENT && errno != ENOTDIR) {
                return;
            }
        } else if (found_errno == ENOENT) {
            found_errno = ENAMETOOLONG;
        }
        if (*end == '\0') {
            break;
        }
        seg = end + 1;
    }
    errno = found_errno;
}

static void mal_proc_child(
    const MalProcRequest *req, char *const *envp, int in_fd, int out_fd, int err_fd, int errpipe
) {
    /* Undo any inherited SIG_IGN on SIGPIPE (the parent ignores it while pumping
     * stdin) so the spawned program sees the default disposition. */
    struct sigaction dfl;
    memset(&dfl, 0, sizeof(dfl));
    dfl.sa_handler = SIG_DFL;
    sigaction(SIGPIPE, &dfl, NULL);

    if (!mal_proc_child_stream(req->stdin_mode, STDIN_FILENO, in_fd, O_RDONLY)
        || !mal_proc_child_stream(req->stdout_mode, STDOUT_FILENO, out_fd, O_WRONLY)
        || !mal_proc_child_stream(req->stderr_mode, STDERR_FILENO, err_fd, O_WRONLY)) {
        mal_proc_child_fail(errpipe);
    }

    if (req->cwd != NULL && chdir(req->cwd) != 0) {
        mal_proc_child_fail(errpipe);
    }

    mal_proc_child_exec(req, envp);
    /* exec returned => it failed; errno is set. */
    mal_proc_child_fail(errpipe);
}

/* ---------------------------------------------------------------------------
 * Parent side: concurrent stdin feed + stdout/stderr drain, then reap.
 * --------------------------------------------------------------------------- */

static bool mal_proc_buf_append(byte **data, usize *len, usize *cap, const byte *src, usize n) {
    if (n > SIZE_MAX - *len - 1) {
        return false;
    }
    if (*len + n + 1 > *cap) {
        usize ncap = *cap != 0 ? *cap : 256;
        while (*len + n + 1 > ncap) {
            if (ncap > SIZE_MAX / 2) {
                ncap = *len + n + 1;
                break;
            }
            ncap *= 2;
        }
        byte *grown = realloc(*data, ncap);
        if (grown == NULL) {
            return false;
        }
        *data = grown;
        *cap = ncap;
    }
    memcpy(*data + *len, src, n);
    *len += n;
    (*data)[*len] = '\0';
    return true;
}

/* Drain `fd` until EAGAIN or EOF. Returns `fd` while it stays open, -1 once it is
 * closed (EOF or error); a real read error is reported through *io_errno. */
static int mal_proc_read_into(int fd, byte **data, usize *len, usize *cap, int *io_errno) {
    for (;;) {
        byte tmp[4096];
        ssize_t r = read(fd, tmp, sizeof(tmp));
        if (r > 0) {
            if (!mal_proc_buf_append(data, len, cap, tmp, (usize) r)) {
                *io_errno = ENOMEM;
                close(fd);
                return -1;
            }
            continue;
        }
        if (r == 0) {
            close(fd);
            return -1;
        }
        if (errno == EINTR) {
            continue;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            return fd;
        }
        *io_errno = errno;
        close(fd);
        return -1;
    }
}

/* Push the pending stdin bytes. Returns `fd` while more remains, -1 once done or
 * the child closed its read end (EPIPE is benign — the child simply ignored stdin). */
static int mal_proc_write_from(int fd, const byte *buf, usize len, usize *off, int *io_errno) {
    for (;;) {
        usize remain = len - *off;
        if (remain == 0) {
            close(fd);
            return -1;
        }
        ssize_t w = write(fd, buf + *off, remain);
        if (w > 0) {
            *off += (usize) w;
            continue;
        }
        if (errno == EINTR) {
            continue;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            return fd;
        }
        if (errno != EPIPE) {
            *io_errno = errno;
        }
        close(fd);
        return -1;
    }
}

/* Run the parent I/O loop until the child's pipes are drained. `launch_errno`
 * receives the child-reported launch failure (0 when the child exec'd cleanly). */
static void mal_proc_pump(
    const MalProcRequest *req, int in_fd, int out_fd, int err_fd, int errpipe, MalProcResult *out, int *launch_errno
) {
    if (in_fd >= 0 && (req->input == NULL || req->input_len == 0)) {
        close(in_fd); /* nothing to send: hand the child immediate EOF on stdin */
        in_fd = -1;
    }
    int fds[] = {in_fd, out_fd, err_fd, errpipe};
    for (usize i = 0; i < sizeof(fds) / sizeof(fds[0]); i++) {
        if (fds[i] >= 0 && mal_proc_set_nonblock(fds[i]) != 0) {
            out->io_errno = errno;
            goto close_fds;
        }
    }

    usize out_cap = 0;
    usize err_cap = 0;
    usize in_off = 0;
    byte errbuf[sizeof(int)];
    usize errbuf_len = 0;

    while (in_fd >= 0 || out_fd >= 0 || err_fd >= 0 || errpipe >= 0) {
        struct pollfd pfds[4];
        int which[4];
        nfds_t n = 0;
        if (in_fd >= 0) {
            pfds[n] = (struct pollfd) {.fd = in_fd, .events = POLLOUT};
            which[n] = 0;
            n++;
        }
        if (out_fd >= 0) {
            pfds[n] = (struct pollfd) {.fd = out_fd, .events = POLLIN};
            which[n] = 1;
            n++;
        }
        if (err_fd >= 0) {
            pfds[n] = (struct pollfd) {.fd = err_fd, .events = POLLIN};
            which[n] = 2;
            n++;
        }
        if (errpipe >= 0) {
            pfds[n] = (struct pollfd) {.fd = errpipe, .events = POLLIN};
            which[n] = 3;
            n++;
        }

        int r = poll(pfds, n, -1);
        if (r < 0) {
            if (errno == EINTR) {
                continue;
            }
            out->io_errno = errno;
            break;
        }

        for (nfds_t i = 0; i < n; i++) {
            if (pfds[i].revents == 0) {
                continue;
            }
            switch (which[i]) {
                case 0:
                    in_fd = mal_proc_write_from(in_fd, req->input, req->input_len, &in_off, &out->io_errno);
                    break;
                case 1:
                    out_fd = mal_proc_read_into(out_fd, &out->stdout_data, &out->stdout_len, &out_cap, &out->io_errno);
                    break;
                case 2:
                    err_fd = mal_proc_read_into(err_fd, &out->stderr_data, &out->stderr_len, &err_cap, &out->io_errno);
                    break;
                case 3:
                    /* The child writes at most one int (its launch errno) before
                     * _exit; a clean exec just closes the CLOEXEC write end (EOF). */
                    for (;;) {
                        if (errbuf_len >= sizeof(errbuf)) {
                            close(errpipe);
                            errpipe = -1;
                            break;
                        }
                        ssize_t g = read(errpipe, errbuf + errbuf_len, sizeof(errbuf) - errbuf_len);
                        if (g > 0) {
                            errbuf_len += (usize) g;
                            continue;
                        }
                        if (g == 0) {
                            close(errpipe);
                            errpipe = -1;
                            break;
                        }
                        if (errno == EINTR) {
                            continue;
                        }
                        if (errno == EAGAIN || errno == EWOULDBLOCK) {
                            break;
                        }
                        close(errpipe);
                        errpipe = -1;
                        break;
                    }
                    break;
                default:
                    break;
            }
        }
    }

    if (errbuf_len == sizeof(int)) {
        int e;
        memcpy(&e, errbuf, sizeof(int));
        *launch_errno = e;
    }

close_fds:
    if (in_fd >= 0) {
        close(in_fd);
    }
    if (out_fd >= 0) {
        close(out_fd);
    }
    if (err_fd >= 0) {
        close(err_fd);
    }
    if (errpipe >= 0) {
        close(errpipe);
    }
}

int mal_proc_run(const MalProcRequest *req, MalProcResult *out) {
    memset(out, 0, sizeof(*out));

    /* Resolve Darwin's indirect environment pointer before fork; _NSGetEnviron
     * is not part of the child's async-signal-safe region. */
#if defined(__APPLE__)
    char *const *envp = req->envp != NULL ? req->envp : *_NSGetEnviron();
#else
    char *const *envp = req->envp != NULL ? req->envp : environ;
#endif

    bool need_in = req->stdin_mode == MAL_PROC_STDIO_PIPE;
    bool need_out = req->stdout_mode == MAL_PROC_STDIO_PIPE;
    bool need_err = req->stderr_mode == MAL_PROC_STDIO_PIPE;

    int in_pipe[2] = {-1, -1};
    int out_pipe[2] = {-1, -1};
    int err_pipe[2] = {-1, -1};
    int errp[2] = {-1, -1};

    if (mal_proc_make_pipe(errp) != 0) {
        out->io_errno = errno;
        return -1;
    }
    if ((need_in && mal_proc_make_pipe(in_pipe) != 0) || (need_out && mal_proc_make_pipe(out_pipe) != 0)
        || (need_err && mal_proc_make_pipe(err_pipe) != 0)) {
        out->io_errno = errno;
        mal_proc_close_pipe(errp);
        mal_proc_close_pipe(in_pipe);
        mal_proc_close_pipe(out_pipe);
        mal_proc_close_pipe(err_pipe);
        return -1;
    }

    /* Ignore SIGPIPE for the lifetime of the write pump: a child that exits
     * without reading stdin would otherwise kill us. The child restores the
     * default disposition before exec. */
    struct sigaction ign;
    struct sigaction prev;
    bool restore_sigpipe = false;
    memset(&ign, 0, sizeof(ign));
    ign.sa_handler = SIG_IGN;
    if (sigaction(SIGPIPE, &ign, &prev) == 0) {
        restore_sigpipe = true;
    }

    pid_t pid = fork();
    if (pid < 0) {
        out->io_errno = errno;
        if (restore_sigpipe) {
            sigaction(SIGPIPE, &prev, NULL);
        }
        mal_proc_close_pipe(errp);
        mal_proc_close_pipe(in_pipe);
        mal_proc_close_pipe(out_pipe);
        mal_proc_close_pipe(err_pipe);
        return -1;
    }

    if (pid == 0) {
        mal_proc_child(req, envp, in_pipe[0], out_pipe[1], err_pipe[1], errp[1]);
        _exit(127); /* unreachable: mal_proc_child always _exits */
    }

    /* Parent: keep the ends we drive, close the child's ends. */
    close(errp[1]);
    errp[1] = -1;
    if (need_in) {
        close(in_pipe[0]);
        in_pipe[0] = -1;
    }
    if (need_out) {
        close(out_pipe[1]);
        out_pipe[1] = -1;
    }
    if (need_err) {
        close(err_pipe[1]);
        err_pipe[1] = -1;
    }

    int launch_errno = 0;
    mal_proc_pump(req, in_pipe[1], out_pipe[0], err_pipe[0], errp[0], out, &launch_errno);
    /* Every fd handed to the pump is closed there once drained. */
    in_pipe[1] = out_pipe[0] = err_pipe[0] = errp[0] = -1;

    int status = 0;
    pid_t w;
    do {
        w = waitpid(pid, &status, 0);
    } while (w < 0 && errno == EINTR);
    if (w < 0 && out->io_errno == 0) {
        out->io_errno = errno;
    }

    if (restore_sigpipe) {
        sigaction(SIGPIPE, &prev, NULL);
    }

    if (launch_errno != 0) {
        /* The child could not exec; its captured streams (if any) are meaningless. */
        mal_proc_result_dispose(out);
        out->launched = false;
        out->launch_errno = launch_errno;
        return -1;
    }

    out->launched = true;
    if (w >= 0 && WIFEXITED(status)) {
        out->exited = true;
        out->exit_status = WEXITSTATUS(status);
    } else if (w >= 0 && WIFSIGNALED(status)) {
        out->signaled = true;
        out->term_signal = WTERMSIG(status);
    }
    return out->io_errno == 0 ? 0 : -1;
}

void mal_proc_result_dispose(MalProcResult *out) {
    free(out->stdout_data);
    free(out->stderr_data);
    out->stdout_data = NULL;
    out->stderr_data = NULL;
    out->stdout_len = 0;
    out->stderr_len = 0;
}

const char *mal_proc_signal_name(int sig) {
    switch (sig) {
        case SIGHUP:
            return "SIGHUP";
        case SIGINT:
            return "SIGINT";
        case SIGQUIT:
            return "SIGQUIT";
        case SIGILL:
            return "SIGILL";
        case SIGTRAP:
            return "SIGTRAP";
        case SIGABRT:
            return "SIGABRT";
        case SIGFPE:
            return "SIGFPE";
        case SIGKILL:
            return "SIGKILL";
        case SIGBUS:
            return "SIGBUS";
        case SIGSEGV:
            return "SIGSEGV";
        case SIGSYS:
            return "SIGSYS";
        case SIGPIPE:
            return "SIGPIPE";
        case SIGALRM:
            return "SIGALRM";
        case SIGTERM:
            return "SIGTERM";
        case SIGURG:
            return "SIGURG";
        case SIGSTOP:
            return "SIGSTOP";
        case SIGTSTP:
            return "SIGTSTP";
        case SIGCONT:
            return "SIGCONT";
        case SIGCHLD:
            return "SIGCHLD";
        case SIGUSR1:
            return "SIGUSR1";
        case SIGUSR2:
            return "SIGUSR2";
        default:
            return NULL;
    }
}

#endif /* MAL_NODE */
