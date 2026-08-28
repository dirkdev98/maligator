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
    u8 *buffer = malloc((size_t) length + 1);
    if (buffer == nullptr || fread(buffer, 1, (size_t) length, file) != (size_t) length) {
        fclose(file);
        free(buffer);
        return nullptr;
    }
    fclose(file);
    buffer[length] = 0;
    *length_out = (usize) length;
    return buffer;
}

static MalLoadedRuntimeImage *mal_test262_load_wire(const char *path) {
    usize length = 0;
    u8 *buffer = mal_test262_read_file(path, &length);
    if (buffer == nullptr) {
        perror(path);
        return nullptr;
    }
    const char *error = "ok";
    MalLoadedRuntimeImage *loaded = mal_runtime_image_load(buffer, length, &error);
    free(buffer);
    if (loaded == nullptr) {
        fprintf(stderr, "mal_runtime_image_load(%s): %s\n", path, error);
        return nullptr;
    }
    return loaded;
}

static int mal_test262_run_wire_plan(const char *plan_path) {
    usize plan_length = 0;
    u8 *plan_buffer = mal_test262_read_file(plan_path, &plan_length);
    if (plan_buffer == nullptr) {
        perror(plan_path);
        return 2;
    }
    int wire_count = 0;
    for (usize i = 0; i < plan_length; i++) {
        if (plan_buffer[i] == '\n') wire_count++;
    }
    if (plan_length > 0 && plan_buffer[plan_length - 1] != '\n') wire_count++;
    if (wire_count < 1) {
        free(plan_buffer);
        return 2;
    }
    char **wire_paths = calloc((usize) wire_count, sizeof(char *));
    if (wire_paths == nullptr) {
        free(plan_buffer);
        return 2;
    }
    int path_index = 0;
    wire_paths[path_index++] = (char *) plan_buffer;
    for (usize i = 0; i < plan_length; i++) {
        if (plan_buffer[i] != '\n') continue;
        plan_buffer[i] = 0;
        if (i > 0 && plan_buffer[i - 1] == '\r') plan_buffer[i - 1] = 0;
        if (i + 1 < plan_length && path_index < wire_count) {
            wire_paths[path_index++] = (char *) &plan_buffer[i + 1];
        }
    }

    MalLoadedRuntimeImage *loaded = mal_test262_load_wire(wire_paths[0]);
    if (loaded == nullptr) {
        free(wire_paths);
        free(plan_buffer);
        return 2;
    }

    MalVm vm;
    mal_vm_init(&vm, mal_loaded_runtime_image_get(loaded));
    mal_test262_install(&vm);
    MalCallable **callables = calloc((usize) wire_count, sizeof(MalCallable *));
    if (callables == nullptr) {
        free(wire_paths);
        free(plan_buffer);
        mal_loaded_runtime_image_free(loaded);
        return 2;
    }
    for (int index = 0; index < wire_count; index++) {
        i32 entry = 0;
        if (index > 0) {
            MalLoadedRuntimeImage *fragment = mal_test262_load_wire(wire_paths[index]);
            if (fragment == nullptr) {
                vm.completion.kind = MAL_COMPLETION_THROW;
                break;
            }
            entry = mal_vm_splice_runtime_image(&vm, mal_loaded_runtime_image_get(fragment));
            if (entry < 0) {
                mal_loaded_runtime_image_free(fragment);
                vm.completion.kind = MAL_COMPLETION_THROW;
                break;
            }
            mal_vm_retain_loaded_runtime_image(&vm, fragment);
        }
        callables[index] = mal_vm_create_callable(&vm, entry);
        mal_vm_run(&vm, callables[index]);
        if (vm.completion.kind == MAL_COMPLETION_THROW) break;
    }
    int code = vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0;

    if (getenv("MAL_GC_AT_EXIT") != nullptr) {
        mal_gc_collect(&vm);
        for (int index = 0; index < wire_count; index++) {
            if (callables[index] != nullptr) mal_vm_free_callable(callables[index]);
        }
        mal_vm_free(&vm);
        mal_loaded_runtime_image_free(loaded);
    }
    free(callables);
    free(wire_paths);
    free(plan_buffer);
    return code;
}

static long mal_test262_now_ms(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return now.tv_sec * 1000L + now.tv_nsec / 1000000L;
}

int main(int argc, char **argv) {
    if (argc < 4 || strcmp(argv[1], "--all") != 0) {
        fprintf(stderr, "usage: %s --all <timeout-ms> <test-plan>...\n", argv[0]);
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
        if (pid == 0) exit(mal_test262_run_wire_plan(argv[argument]));
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
