#pragma once

#include <stdio.h>

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the console namespace object with log / info / warn / error.
 */
void mal_builtin_console_install(MalVm *vm);

typedef struct MalTextBuffer MalTextBuffer;
typedef struct MalNodeInspectOptions MalNodeInspectOptions;

/* Node's console, registered by the Node personality. Node formatting lives in the
 * runtime layer, which links before this engine file, so the console reaches it only
 * through these hooks. The console's own Node paths sit behind the same table, so a
 * program without the Node personality links none of them. */
typedef struct MalConsoleNodeHooks {
    bool (*format_into)(
        MalVm *vm, MalTextBuffer *out, MalValue options, bool colors, const MalValue *args, i32 argc);
    bool (*inspect_into)(
        MalVm *vm, MalTextBuffer *out, MalValue value, const MalNodeInspectOptions *options);
    void (*throw_code)(MalVm *vm, MalIntrinsic prototype, const char *message, const char *code);
    bool (*format)(MalVm *vm, FILE *stream, MalTextBuffer *out, const MalValue *args, i32 argc);
    void (*dir)(MalVm *vm, MalValue value, MalValue options);
    MalValue (*table)(MalVm *vm, MalValue data, MalValue properties);
} MalConsoleNodeHooks;

/* Node's console.log/console.dir/console.table, for the Node personality's hooks. */
bool mal_console_node_format(MalVm *vm, FILE *stream, MalTextBuffer *out, const MalValue *args, i32 argc);
void mal_console_node_dir(MalVm *vm, MalValue value, MalValue options);
MalValue mal_console_node_table(MalVm *vm, MalValue data, MalValue properties);

/** Define console.Console, whose instances write through their stream's write(string). */
void mal_builtin_console_install_class(MalVm *vm);
