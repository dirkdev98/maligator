#pragma once

#include "vm.h"

/** Install `maligator:internal/fs`, the native layer under `maligator:fs`. */
void mal_host_install_maligator_internal_fs(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);

void mal_host_install_maligator_internal_fs_descriptor(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);
void mal_host_install_maligator_internal_fs_stream(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);
void mal_host_install_maligator_internal_fs_watch(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);

/* Convert a validated source-module path and copy a write's buffer source for the worker. */
char *mal_fs_path(MalVm *vm, MalValue value);
bool mal_fs_copy_data(MalVm *vm, MalValue data, byte **bytes, usize *length);
int mal_fs_create_parents(const char *path, char **directory);

/* Adopt the worker's bytes and give JavaScript a view over them. */
MalValue mal_fs_take_bytes(MalVm *vm, byte *bytes, usize length);

/* The source layer converts this description to a FileSystemError. */
MalValue mal_fs_failure(
    MalVm *vm, int error, const char *syscall, const char *path, const char *destination);
