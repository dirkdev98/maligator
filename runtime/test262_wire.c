#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include "test262_host.h"
#include "vm.h"
#include "vm_load.h"

static u8 *mal_test262_read_file(const char *path, usize *length_out) {
    FILE *file = fopen(path, "rb");
    if (file == nullptr || fseek(file, 0, SEEK_END) != 0) return nullptr;
    long length = ftell(file);
    if (length < 0 || fseek(file, 0, SEEK_SET) != 0) {
        fclose(file);
        return nullptr;
    }
    u8 *buffer = malloc((size_t) length);
    if (buffer == nullptr || fread(buffer, 1, (size_t) length, file) != (size_t) length) {
        fclose(file);
        free(buffer);
        return nullptr;
    }
    fclose(file);
    *length_out = (usize) length;
    return buffer;
}

static int mal_test262_run_wire(const char *path) {
    usize length = 0;
    u8 *buffer = mal_test262_read_file(path, &length);
    if (buffer == nullptr) {
        perror(path);
        return 2;
    }
    const char *error = "ok";
    MalLoadedDefinition *loaded = mal_vm_load_definition(buffer, length, &error);
    free(buffer);
    if (loaded == nullptr) {
        fprintf(stderr, "mal_vm_load_definition(%s): %s\n", path, error);
        return 2;
    }

    MalVm vm;
    mal_vm_init(&vm, mal_loaded_definition_get(loaded));
    mal_test262_install(&vm);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);
    int code = vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0;

    if (getenv("MAL_GC_AT_EXIT") != nullptr) {
        mal_gc_collect(&vm);
        mal_vm_free_callable(callable);
        mal_vm_free(&vm);
        mal_vm_loaded_definition_free(loaded);
    }
    return code;
}

static long mal_test262_now_ms(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return now.tv_sec * 1000L + now.tv_nsec / 1000000L;
}

int main(int argc, char **argv) {
    if (argc < 4 || strcmp(argv[1], "--all") != 0) {
        fprintf(stderr, "usage: %s --all <timeout-ms> <test.malw>...\n", argv[0]);
        return 2;
    }

    long timeout_ms = atol(argv[2]);
    dup2(STDOUT_FILENO, STDERR_FILENO);

    for (int argument = 3; argument < argc; argument++) {
        int index = argument - 3;
        printf("\n##TEST %d\n", index);
        fflush(stdout);

        long started_at = mal_test262_now_ms();
        pid_t pid = fork();
        if (pid == 0) exit(mal_test262_run_wire(argv[argument]));
        if (pid < 0) {
            printf("\n##RESULT %d FORK_FAILED 0\n", index);
            fflush(stdout);
            continue;
        }

        int status = 0;
        int timed_out = 0;
        int wait_failed = 0;
        while (1) {
            pid_t reaped = waitpid(pid, &status, WNOHANG);
            if (reaped == pid) break;
            if (reaped < 0) {
                wait_failed = 1;
                break;
            }
            if (mal_test262_now_ms() - started_at >= timeout_ms) {
                kill(pid, SIGKILL);
                waitpid(pid, &status, 0);
                timed_out = 1;
                break;
            }
            usleep(1000);
        }

        if (wait_failed) {
            printf("\n##RESULT %d FORK_FAILED 0\n", index);
            fflush(stdout);
            continue;
        }

        long elapsed = mal_test262_now_ms() - started_at;
        if (timed_out) {
            printf("\n##RESULT %d TIMEOUT 0 %ldms\n", index, elapsed);
        } else if (WIFSIGNALED(status)) {
            printf("\n##RESULT %d SIGNAL %d %ldms\n", index, WTERMSIG(status), elapsed);
        } else {
            printf("\n##RESULT %d EXIT %d %ldms\n", index, WEXITSTATUS(status), elapsed);
        }
        fflush(stdout);
    }
    return 0;
}
