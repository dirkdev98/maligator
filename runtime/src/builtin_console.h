#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the console namespace object with log / info / warn / error.
 */
void mal_builtin_console_install(MalVm *vm);

#if MAL_NODE
typedef struct MalTextBuffer MalTextBuffer;
typedef struct MalNodeInspectOptions MalNodeInspectOptions;

/* Node formatting lives in the runtime layer, which links before this engine file, so the
 * console reaches it only through hooks the Node personality registers. */
typedef struct MalConsoleNodeHooks {
    bool (*format_into)(
        MalVm *vm, MalTextBuffer *out, MalValue options, bool colors, const MalValue *args, i32 argc);
    bool (*inspect_into)(
        MalVm *vm, MalTextBuffer *out, MalValue value, const MalNodeInspectOptions *options);
    void (*throw_code)(MalVm *vm, MalIntrinsic prototype, const char *message, const char *code);
} MalConsoleNodeHooks;
#endif

#if MAL_NODE
/** Define console.Console, whose instances write through their stream's write(string). */
void mal_builtin_console_install_class(MalVm *vm);
#endif
