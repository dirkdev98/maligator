#pragma once

#include "vm.h"

/** The Node.js release whose API surface the runtime reports, without the leading "v". */
#define MAL_NODE_COMPAT_VERSION "26.12.0"

/** Publish a Node module's default object and requested named exports. */
void mal_node_module_publish(
    MalVm *vm, const char *id, const MalHostInstallSlot *slots, i32 count, MalValue module);

bool mal_node_module_install_cached(
    MalVm *vm, const char *id, const MalHostInstallSlot *slots, i32 count);

MalValue mal_node_module_get_cached(MalVm *vm, const char *id);

/* Brand checks node:crypto registers when installed, so util.types can recognize its
 * objects without linking it; before that no KeyObject or CryptoKey can exist. */
typedef bool (*MalNodeBrandCheck)(MalValue value);
extern MalNodeBrandCheck mal_node_key_object_brand;
extern MalNodeBrandCheck mal_node_crypto_key_brand;

/** Throw `prototype` with `message` and a Node `code` property such as ERR_INVALID_ARG_TYPE. */
void mal_node_throw_code(MalVm *vm, MalIntrinsic prototype, const char *message, const char *code);

/** mal_node_throw_code with a message the engine already holds as a string. */
void mal_node_throw_code_string(
    MalVm *vm, MalIntrinsic prototype, MalString *message, const char *code);

/** Node's "Received ..." clause for `value`, as ERR_INVALID_ARG_TYPE renders it. */
void mal_node_describe_received(MalVm *vm, MalValue value, char *out, usize capacity);

/** util.inspect() of a string as ERR_INVALID_ARG_VALUE's "Received ..." clause renders it,
 * escaping control characters and cut to 128 characters. */
void mal_node_inspect_string(MalString *string, char *out, usize capacity);

/** ERR_INVALID_ARG_TYPE; `expected` is the phrase after "must be", such as "of type number". */
void mal_node_throw_invalid_arg_type(
    MalVm *vm, const char *name, const char *expected, MalValue actual);

/** ERR_OUT_OF_RANGE; `range` is the phrase after "It must be", such as ">= 0 and <= 3". */
void mal_node_throw_out_of_range(MalVm *vm, const char *name, const char *range, MalValue actual);

/** Symbol.for(key), registering it on first use. */
MalValue mal_node_registered_symbol(MalVm *vm, const char *key);

/** Symbol.for("nodejs.util.inspect.custom"), the key of custom util.inspect hooks. */
MalValue mal_node_inspect_custom_symbol(MalVm *vm);

/** Node's AbortError ("The operation was aborted", code ABORT_ERR) with `cause`, returned unthrown. */
MalValue mal_node_abort_error(MalVm *vm, MalValue cause);

/** Node's validateNumber: a number primitive, without coercion. */
bool mal_node_validate_number(MalVm *vm, MalValue value, const char *name);

/** Node's validateInteger: an integral number within [min, max]. */
bool mal_node_validate_integer(
    MalVm *vm, MalValue value, const char *name, f64 min, f64 max, f64 *out);

/**
 * Throw Node's system error for `err`: "CODE: description, syscall 'path' -> 'dest'"
 * with errno, code, syscall and the optional path and dest properties.
 */
void mal_node_throw_errno(
    MalVm *vm, int err, const char *syscall, const char *path, const char *dest);
MalValue mal_node_module_get_builtin(MalVm *vm, MalString *name);
