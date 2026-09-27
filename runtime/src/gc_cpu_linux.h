#pragma once

#include "./defaults.h"

typedef enum MalGcQuotaStatus {
    MAL_GC_QUOTA_UNKNOWN,
    MAL_GC_QUOTA_UNLIMITED,
    MAL_GC_QUOTA_LIMITED,
} MalGcQuotaStatus;

typedef struct MalGcCpuQuota {
    usize cpus;
    MalGcQuotaStatus status;
    /* Completeness covers only visible ancestry; cgroup namespaces can hide parents. */
    bool complete;
} MalGcCpuQuota;

typedef enum MalGcQuotaReadStatus {
    MAL_GC_QUOTA_READ_OK,
    MAL_GC_QUOTA_READ_MISSING,
    MAL_GC_QUOTA_READ_ERROR,
} MalGcQuotaReadStatus;

typedef MalGcQuotaReadStatus (*MalGcQuotaReadFile)(
    const char *path, char *output, usize capacity, void *context);

MalGcCpuQuota mal_gc_cpu_quota_from_cgroups(
    usize available_cpus, const char *membership, const char *mountinfo,
    MalGcQuotaReadFile read_file, void *context);

#if defined(__linux__) && !defined(__wasi__)
MalGcCpuQuota mal_gc_linux_cpu_quota(usize available_cpus);
#endif
