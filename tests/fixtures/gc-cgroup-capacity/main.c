#include <stdio.h>
#include <string.h>

#include "gc_cpu_linux.h"

typedef struct MockFile {
    const char *path;
    const char *contents;
} MockFile;

typedef struct MockFiles {
    const MockFile *files;
    usize count;
} MockFiles;

static MalGcQuotaReadStatus mock_read(
    const char *path, char *output, usize capacity, void *context) {
    MockFiles *mock = context;
    for (usize i = 0; i < mock->count; ++i) {
        if (strcmp(mock->files[i].path, path) == 0) {
            if (mock->files[i].contents == nullptr) return MAL_GC_QUOTA_READ_ERROR;
            usize length = strlen(mock->files[i].contents);
            if (length >= capacity) return MAL_GC_QUOTA_READ_ERROR;
            memcpy(output, mock->files[i].contents, length + 1);
            return MAL_GC_QUOTA_READ_OK;
        }
    }
    return MAL_GC_QUOTA_READ_MISSING;
}

static bool check(
    const char *membership, const char *mountinfo, const MockFile *files, usize file_count,
    usize available, usize expected, MalGcQuotaStatus status, bool complete) {
    MockFiles mock = {files, file_count};
    MalGcCpuQuota result = mal_gc_cpu_quota_from_cgroups(
        available, membership, mountinfo, mock_read, &mock);
    if (result.cpus != expected || result.status != status || result.complete != complete) {
        fprintf(stderr, "cpu quota: got %zu/%d/%d, expected %zu/%d/%d\n",
            result.cpus, result.status, result.complete, expected, status, complete);
        return false;
    }
    return true;
}

#define CHECK(membership, mounts, files, available, expected, status, complete) \
    do { \
        if (!check(membership, mounts, files, countof(files), available, expected, status, complete)) \
            return __LINE__; \
    } while (0)

int main(void) {
    const char *v2_mount = "21 20 0:42 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n";
    const MockFile nested[] = {
        {"/sys/fs/cgroup/tenant/group/leaf/cpu.max", "max 100000\n"},
        {"/sys/fs/cgroup/tenant/group/cpu.max", "250000 100000\n"},
        {"/sys/fs/cgroup/tenant/cpu.max", "150000 100000\n"},
        {"/sys/fs/cgroup/cpu.max", "400000 100000\n"},
    };
    CHECK("0::/tenant/group/leaf\n", v2_mount, nested, 8, 1, MAL_GC_QUOTA_LIMITED, true);

    const char *v1_mount =
        "30 20 0:32 /docker /sys/fs/cgroup/cpu rw - cgroup cgroup rw,cpu,cpuacct\n"
        "31 20 0:33 /docker /sys/fs/cgroup/cpuset rw - cgroup cgroup rw,cpuset\n";
    const MockFile v1[] = {
        {"/sys/fs/cgroup/cpu/a/cpu.cfs_quota_us", "250000\n"},
        {"/sys/fs/cgroup/cpu/a/cpu.cfs_period_us", "100000\n"},
        {"/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "100000\n"},
        {"/sys/fs/cgroup/cpu/cpu.cfs_period_us", "100000\n"},
    };
    CHECK("7:cpu,cpuacct:/docker/a\n0::/ignored\n", v1_mount, v1, 8, 1,
        MAL_GC_QUOTA_LIMITED, false);
    CHECK("7:cpu,cpuacct:/docker-a\n", v1_mount, v1, 8, 8,
        MAL_GC_QUOTA_UNKNOWN, false);

    const char *escaped_mount = "40 20 0:42 / /run/cgroup\\040space rw - cgroup2 cgroup rw\n";
    const MockFile escaped[] = {
        {"/run/cgroup space/cpu.max", "300000 100000\n"},
    };
    CHECK("0::/\n", escaped_mount, escaped, 8, 3, MAL_GC_QUOTA_LIMITED, true);

    const char *multiple_mounts =
        "41 20 0:42 /tenant/group /short rw - cgroup2 cgroup rw\n"
        "42 20 0:42 / /wide rw - cgroup2 cgroup rw\n";
    const MockFile multiple[] = {
        {"/short/leaf/cpu.max", "400000 100000\n"},
        {"/wide/tenant/cpu.max", "100000 100000\n"},
    };
    CHECK("0::/tenant/group/leaf\n", multiple_mounts, multiple, 8, 1,
        MAL_GC_QUOTA_LIMITED, false);
    CHECK("0::/../tenant/group/leaf\n", multiple_mounts, multiple, 8, 8,
        MAL_GC_QUOTA_UNKNOWN, false);

    const MockFile malformed[] = {
        {"/sys/fs/cgroup/a/cpu.max", "18446744073709551616 100000\n"},
        {"/sys/fs/cgroup/cpu.max", "200000 100000 junk\n"},
    };
    CHECK("0::/a\n", v2_mount, malformed, 8, 8, MAL_GC_QUOTA_UNKNOWN, false);

    const MockFile fractional[] = {
        {"/sys/fs/cgroup/a/cpu.max", "199999 100000\n"},
    };
    CHECK("0::/a\n", v2_mount, fractional, 8, 1, MAL_GC_QUOTA_LIMITED, true);
    const MockFile two[] = {
        {"/sys/fs/cgroup/a/cpu.max", "200000 100000\n"},
    };
    CHECK("0::/a\n", v2_mount, two, 8, 2, MAL_GC_QUOTA_LIMITED, true);
    const MockFile below_three[] = {
        {"/sys/fs/cgroup/a/cpu.max", "299999 100000\n"},
    };
    CHECK("0::/a\n", v2_mount, below_three, 8, 2, MAL_GC_QUOTA_LIMITED, true);
    const MockFile three[] = {
        {"/sys/fs/cgroup/a/cpu.max", "300000 100000\n"},
    };
    CHECK("0::/a\n", v2_mount, three, 8, 3, MAL_GC_QUOTA_LIMITED, true);

    const MockFile unlimited[] = {
        {"/sys/fs/cgroup/a/cpu.max", "max 100000\n"},
        {"/sys/fs/cgroup/cpu.max", "max 100000\n"},
    };
    CHECK("0::/a\n", v2_mount, unlimited, 8, 8, MAL_GC_QUOTA_UNLIMITED, true);
    const MockFile root_error[] = {
        {"/sys/fs/cgroup/a/cpu.max", "max 100000\n"},
        {"/sys/fs/cgroup/cpu.max", nullptr},
    };
    CHECK("0::/a\n", v2_mount, root_error, 8, 8, MAL_GC_QUOTA_UNKNOWN, false);

    const MockFile no_newline[] = {
        {"/sys/fs/cgroup/a/cpu.max", "200000 100000"},
    };
    CHECK("0::/a\n", v2_mount, no_newline, 8, 2, MAL_GC_QUOTA_LIMITED, true);
    const char *enclosing_visible =
        "60 1 0:1 / / rw - ext4 /dev/root rw\n"
        "63 60 0:2 / /sys rw - tmpfs tmpfs rw\n"
        "64 63 0:42 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n";
    CHECK("0::/a\n", enclosing_visible, no_newline, 8, 2,
        MAL_GC_QUOTA_LIMITED, true);
    const MockFile v1_no_newline[] = {
        {"/sys/fs/cgroup/cpu/a/cpu.cfs_quota_us", "-1"},
        {"/sys/fs/cgroup/cpu/a/cpu.cfs_period_us", "100000"},
        {"/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "200000"},
        {"/sys/fs/cgroup/cpu/cpu.cfs_period_us", "100000"},
    };
    CHECK("7:cpu,cpuacct:/docker/a\n", v1_mount, v1_no_newline, 8, 2,
        MAL_GC_QUOTA_LIMITED, false);

    const MockFile invalid_period[] = {
        {"/sys/fs/cgroup/a/cpu.max", "200000 0\n"},
    };
    CHECK("0::/a\n", v2_mount, invalid_period, 8, 8, MAL_GC_QUOTA_UNKNOWN, false);
    const MockFile partial[] = {
        {"/sys/fs/cgroup/tenant/group/leaf/cpu.max", "200000 100000\n"},
    };
    CHECK("0::/tenant/group/leaf\n", v2_mount, partial, 8, 2,
        MAL_GC_QUOTA_LIMITED, false);

    const char *invalid_escape = "50 20 0:42 / /run/cgroup\\000 rw - cgroup2 cgroup rw\n";
    CHECK("0::/a\n", invalid_escape, no_newline, 8, 8, MAL_GC_QUOTA_UNKNOWN, false);
    const char *covered_mounts =
        "51 20 0:42 /a /covered rw - cgroup2 cgroup rw\n"
        "52 20 0:42 /b /covered rw - cgroup2 cgroup rw\n";
    const MockFile covered[] = {
        {"/covered/leaf/cpu.max", "100000 100000\n"},
    };
    CHECK("0::/a/leaf\n", covered_mounts, covered, 8, 8, MAL_GC_QUOTA_UNKNOWN, false);
    const char *nested_cover =
        "53 20 0:42 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n"
        "54 53 0:43 / /sys/fs/cgroup/a rw - tmpfs tmpfs rw\n";
    CHECK("0::/a\n", nested_cover, covered, 8, 8, MAL_GC_QUOTA_UNKNOWN, false);
    const char *enclosing_cover =
        "60 1 0:1 / / rw - ext4 /dev/root rw\n"
        "61 60 0:42 /a /x/cg rw - cgroup2 cgroup rw\n"
        "62 60 0:43 / /x rw - tmpfs tmpfs rw\n";
    const MockFile enclosing[] = {
        {"/x/cg/leaf/cpu.max", "100000 100000\n"},
    };
    CHECK("0::/a/leaf\n", enclosing_cover, enclosing, 8, 8,
        MAL_GC_QUOTA_UNKNOWN, false);
    puts("gc-cgroup-capacity PASS");
    return 0;
}
