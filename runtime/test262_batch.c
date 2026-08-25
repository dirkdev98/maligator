#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include "vm.h"
#include "test262_host.h"

// Batch driver for generated test262 translation units: every test runs in a
// forked child for crash and timeout isolation, while the process image
// (code signature, dyld work) is paid for only once per batch.
extern const MalProgramImage *const mal_test262_artifact_definitions[];
extern const int mal_test262_plan_definition_indices[];
extern const int mal_test262_plan_entry_indices[];
extern const int mal_test262_plan_helper_offsets[];
extern const int mal_test262_plan_helper_indices[];
extern const int mal_test262_plan_count;

static int mal_test262_run_entry(MalVm *vm, int function_index) {
    MalCallable *callable = mal_vm_create_callable(vm, function_index);
    mal_vm_run(vm, callable);
    mal_vm_free_callable(callable);
    return vm->completion.kind == MAL_COMPLETION_THROW ? 1 : 0;
}

static int mal_test262_run_single(int index) {
    MalVm vm;
    mal_vm_init(&vm, mal_test262_artifact_definitions[mal_test262_plan_definition_indices[index]]);
    mal_test262_install(&vm);

    int helper_start = mal_test262_plan_helper_offsets[index];
    int helper_end = mal_test262_plan_helper_offsets[index + 1];
    for (int i = helper_start; i < helper_end; i++) {
        if (mal_test262_run_entry(&vm, mal_test262_plan_helper_indices[i]) != 0) {
            return 1;
        }
    }

    return mal_test262_run_entry(&vm, mal_test262_plan_entry_indices[index]);
}

static long mal_test262_now_ms(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return now.tv_sec * 1000L + now.tv_nsec / 1000000L;
}

int main(int argc, char **argv) {
    // Single-test mode for debugging: test262_batch.bin <index>
    if (argc >= 2 && strcmp(argv[1], "--all") != 0) {
        return mal_test262_run_single(atoi(argv[1]));
    }

    long timeout_ms = argc >= 3 ? atol(argv[2]) : 5000;

    // One ordered stream so per-test output can be attributed by markers.
    dup2(STDOUT_FILENO, STDERR_FILENO);

    for (int i = 0; i < mal_test262_plan_count; i++) {
        printf("\n##TEST %d\n", i);
        fflush(stdout);

        long started_at = mal_test262_now_ms();
        pid_t pid = fork();
        if (pid == 0) {
            // exit (not _exit) flushes the child's buffered output.
            exit(mal_test262_run_single(i));
        }
        if (pid < 0) {
            printf("\n##RESULT %d FORK_FAILED 0\n", i);
            fflush(stdout);
            continue;
        }

        int status = 0;
        int timed_out = 0;
        int wait_failed = 0;
        while (1) {
            pid_t reaped = waitpid(pid, &status, WNOHANG);
            if (reaped == pid) {
                break;
            }
            if (reaped < 0) {
                // Never report an uninitialized status as a pass.
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
            printf("\n##RESULT %d FORK_FAILED 0\n", i);
            fflush(stdout);
            continue;
        }

        long elapsed = mal_test262_now_ms() - started_at;
        if (timed_out) {
            printf("\n##RESULT %d TIMEOUT 0 %ldms\n", i, elapsed);
        } else if (WIFSIGNALED(status)) {
            printf("\n##RESULT %d SIGNAL %d %ldms\n", i, WTERMSIG(status), elapsed);
        } else {
            printf("\n##RESULT %d EXIT %d %ldms\n", i, WEXITSTATUS(status), elapsed);
        }
        fflush(stdout);
    }

    return 0;
}
