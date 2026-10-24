#pragma once

#include "vm.h"

void mal_host_install_node_dns(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);

void mal_host_install_node_dns_promises(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);

/* Callback-style dns.lookup(hostname, options, callback), for modules that resolve names as Node's call it. */
MalValue mal_node_dns_lookup(MalVm *vm, const MalValue *args, i32 argc);

/* Throws Node's ERR_INVALID_ARG_VALUE for a host name holding U+0000; `subject` is "The argument
 * 'hostname'" or "The property 'options.host'". */
void mal_node_dns_throw_null_bytes(MalVm *vm, const char *subject, MalValue value);

/** Node's code and libuv's UV_EAI_* errno for a getaddrinfo `status`; EAI_SYSTEM reports
 * `system_errno`'s code instead. */
void mal_node_dns_error_code(int status, int system_errno, const char **code, int *errno_out);
