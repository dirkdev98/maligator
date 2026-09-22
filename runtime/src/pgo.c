#include "pgo.h"

#if MAL_PGO

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "vm.h"

#define MAL_PGO_MAX_COUNTERS 1048576u
#define MAL_PGO_OVERFLOW 1u
#define MAL_PGO_INVALID 2u

typedef struct MalPgoState {
    char *path;
    u64 *counts;
    u32 functions;
    u32 calls;
    u32 flags;
    u8 identity[32];
} MalPgoState;

static MalPgoState *active_pgo;

static bool mal_pgo_number(const char *text, u32 *result) {
    if (text == nullptr || *text == '\0') return false;
    u64 value = 0;
    for (const char *cursor = text; *cursor != '\0'; cursor++) {
        if (*cursor < '0' || *cursor > '9') return false;
        value = value * 10 + (u32) (*cursor - '0');
        if (value > MAL_PGO_MAX_COUNTERS) return false;
    }
    *result = (u32) value;
    return true;
}

static bool mal_pgo_identity(const char *text, u8 *bytes) {
    if (text == nullptr || strlen(text) != 64) return false;
    for (u32 index = 0; index < 64; index++) {
        char character = text[index];
        u8 digit;
        if (character >= '0' && character <= '9') digit = (u8) (character - '0');
        else if (character >= 'a' && character <= 'f') digit = (u8) (character - 'a' + 10);
        else return false;
        if (index % 2 == 0) bytes[index / 2] = (u8) (digit << 4);
        else bytes[index / 2] |= digit;
    }
    return true;
}

void mal_pgo_init(MalVm *vm) {
    const char *path = getenv("MAL_PGO_CAPTURE");
    if (path == nullptr || *path == '\0') return;
    if (active_pgo != nullptr) {
        active_pgo->flags |= MAL_PGO_INVALID;
        return;
    }
    u32 functions, calls;
    u8 identity[32];
    if (!mal_pgo_number(getenv("MAL_PGO_FUNCTIONS"), &functions) ||
        !mal_pgo_number(getenv("MAL_PGO_CALL_SITES"), &calls) ||
        functions != (u32) vm->runtime_image->function_count ||
        functions + calls > MAL_PGO_MAX_COUNTERS ||
        !mal_pgo_identity(getenv("MAL_PGO_IDENTITY"), identity)) {
        fprintf(stderr, "PGO capture rejected incompatible metadata\n");
        return;
    }
    MalPgoState *state = calloc(1, sizeof(*state));
    if (state == nullptr) return;
    state->path = strdup(path);
    state->counts = calloc((usize) functions + calls, sizeof(u64));
    if (state->path == nullptr || state->counts == nullptr) {
        free(state->counts);
        free(state->path);
        free(state);
        return;
    }
    state->functions = functions;
    state->calls = calls;
    memcpy(state->identity, identity, sizeof(identity));
    for (u32 index = 0; index < functions; index++) {
        if (vm->runtime_image->functions[index].compiled != nullptr)
            state->flags |= MAL_PGO_INVALID;
    }
    vm->pgo_state = state;
    active_pgo = state;
}

static void mal_pgo_increment(MalPgoState *state, u32 slot) {
    if (state->counts[slot] == UINT64_MAX) state->flags |= MAL_PGO_OVERFLOW;
    else state->counts[slot]++;
}

void mal_pgo_entry(MalVm *vm, i32 function_index) {
    MalPgoState *state = vm->pgo_state;
    if (state == nullptr) return;
    if (function_index < 0 || (u32) function_index >= state->functions) {
        state->flags |= MAL_PGO_INVALID;
        return;
    }
    mal_pgo_increment(state, (u32) function_index);
}

void mal_pgo_call(MalVm *vm, i32 site) {
    MalPgoState *state = vm->pgo_state;
    if (state == nullptr) return;
    if (site < 0 || (u32) site >= state->calls) {
        state->flags |= MAL_PGO_INVALID;
        return;
    }
    mal_pgo_increment(state, state->functions + (u32) site);
}

static bool mal_pgo_write_integer(FILE *file, u64 value, usize width) {
    u8 bytes[8];
    for (usize index = 0; index < width; index++) bytes[index] = (u8) (value >> (index * 8));
    return fwrite(bytes, 1, width, file) == width;
}

void mal_pgo_finish(MalVm *vm) {
    MalPgoState *state = vm->pgo_state;
    if (state == nullptr) return;
    usize size = strlen(state->path) + 40;
    char *temporary = malloc(size);
    bool published = false;
    if (temporary != nullptr) {
        snprintf(temporary, size, "%s.tmp-%ld", state->path, (long) getpid());
        int descriptor = open(temporary, O_WRONLY | O_CREAT | O_EXCL, 0600);
        FILE *file = descriptor < 0 ? nullptr : fdopen(descriptor, "wb");
        if (file == nullptr && descriptor >= 0) close(descriptor);
        if (file != nullptr) {
            bool ok = fwrite("MALPGO1\0", 1, 8, file) == 8 &&
                mal_pgo_write_integer(file, 1, 4) && mal_pgo_write_integer(file, 1, 4) &&
                mal_pgo_write_integer(file, state->functions, 4) &&
                mal_pgo_write_integer(file, state->calls, 4) &&
                mal_pgo_write_integer(file, state->flags, 4) && mal_pgo_write_integer(file, 0, 4) &&
                fwrite(state->identity, 1, 32, file) == 32;
            for (u32 index = 0; ok && index < state->functions + state->calls; index++)
                ok = mal_pgo_write_integer(file, state->counts[index], 8);
            if (fclose(file) != 0) ok = false;
            if (ok) published = rename(temporary, state->path) == 0;
        }
        if (!published && descriptor >= 0) unlink(temporary);
        free(temporary);
    }
    if (!published) fprintf(stderr, "PGO capture could not be published\n");
    vm->pgo_state = nullptr;
    active_pgo = nullptr;
    free(state->counts);
    free(state->path);
    free(state);
}

#endif
