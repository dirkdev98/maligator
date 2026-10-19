#pragma once

#include "text_buffer.h"
#include "vm.h"

/* Node's util.inspect / util.format engine. It holds no host installer, so console can use it
 * without linking node:util. */

typedef struct MalNodeInspectOptions {
    /** User inspect options object, or undefined. */
    MalValue options;
    bool colors;
    /** console.dir: customInspect defaults to false. */
    bool dir;
    /** console.table cell: depth 0 (-1 for objects with more than two keys), maxArrayLength 3, unbounded breakLength. */
    bool table_cell;
} MalNodeInspectOptions;

/** Append util.inspect(value, options); false leaves the thrown completion on the VM. */
bool mal_node_util_inspect_into(
    MalVm *vm, MalTextBuffer *out, MalValue value, const MalNodeInspectOptions *options);

/** Append util.formatWithOptions(options, ...args); `colors` forces colored inspection. */
bool mal_node_util_format_into(
    MalVm *vm, MalTextBuffer *out, MalValue options, bool colors, const MalValue *args, i32 argc);

MalValue mal_node_util_inspect(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee);
MalValue mal_node_util_format(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee);
MalValue mal_node_util_format_with_options(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee);

/** Define inspect.custom, inspect.defaultOptions, inspect.styles and inspect.colors on `inspect`. */
void mal_node_inspect_install_tables(MalVm *vm, MalObject *inspect);
