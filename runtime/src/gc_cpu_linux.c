#include "./gc_cpu_linux.h"

#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAL_GC_CGROUP_TEXT_LIMIT (1024u * 1024u)
#define MAL_GC_CGROUP_PATH_LIMIT 4096u

static bool mal_gc_csv_has_token(const char *list, const char *token) {
    usize length = strlen(token);
    for (const char *item = list; *item != '\0';) {
        const char *end = strchr(item, ',');
        if (end == nullptr) end = item + strlen(item);
        if ((usize) (end - item) == length && strncmp(item, token, length) == 0) return true;
        item = *end == ',' ? end + 1 : end;
    }
    return false;
}

static bool mal_gc_cgroup_path_valid(const char *path) {
    if (path[0] != '/') return false;
    const char *part = path + 1;
    while (*part != '\0') {
        const char *end = strchr(part, '/');
        if (end == nullptr) end = part + strlen(part);
        usize length = (usize) (end - part);
        if (length == 0 || (length == 1 && part[0] == '.') ||
            (length == 2 && part[0] == '.' && part[1] == '.')) return false;
        part = *end == '/' ? end + 1 : end;
    }
    return true;
}

static bool mal_gc_decode_mount_path(const char *encoded, char *output, usize capacity) {
    usize used = 0;
    for (usize i = 0; encoded[i] != '\0'; ++i) {
        if (used + 1 >= capacity) return false;
        if (encoded[i] == '\\') {
            if (encoded[i + 1] < '0' || encoded[i + 1] > '7' ||
                encoded[i + 2] < '0' || encoded[i + 2] > '7' ||
                encoded[i + 3] < '0' || encoded[i + 3] > '7') return false;
            unsigned escaped = (unsigned) (((encoded[i + 1] - '0') << 6) |
                ((encoded[i + 2] - '0') << 3) | (encoded[i + 3] - '0'));
            if (escaped != 040 && escaped != 011 && escaped != 012 && escaped != 0134) {
                return false;
            }
            output[used++] = (char) escaped;
            i += 3;
        } else {
            output[used++] = encoded[i];
        }
    }
    output[used] = '\0';
    return mal_gc_cgroup_path_valid(output);
}

static bool mal_gc_component_prefix(const char *prefix, const char *path) {
    if (strcmp(prefix, "/") == 0) return path[0] == '/';
    usize length = strlen(prefix);
    return strncmp(prefix, path, length) == 0 &&
        (path[length] == '\0' || path[length] == '/');
}

static bool mal_gc_parse_positive(const char **cursor, unsigned long long *result) {
    const char *start = *cursor;
    while (isspace((unsigned char) *start)) start++;
    if (*start < '0' || *start > '9') return false;
    errno = 0;
    char *end;
    unsigned long long value = strtoull(start, &end, 10);
    if (errno == ERANGE || value == 0 ||
        (*end != '\0' && !isspace((unsigned char) *end))) {
        return false;
    }
    *cursor = end;
    *result = value;
    return true;
}

static bool mal_gc_parse_quota(
    const char *quota_text, const char *period_text, bool unified,
    bool *unlimited, unsigned long long *cpus) {
    const char *quota = quota_text;
    while (isspace((unsigned char) *quota)) quota++;
    if (unified && strncmp(quota, "max", 3) == 0 && isspace((unsigned char) quota[3])) {
        quota += 3;
        *unlimited = true;
    } else if (!unified && quota[0] == '-' && quota[1] == '1' &&
               (quota[2] == '\0' || isspace((unsigned char) quota[2]))) {
        quota += 2;
        *unlimited = true;
    } else {
        unsigned long long value;
        if (!mal_gc_parse_positive(&quota, &value)) return false;
        *cpus = value;
        *unlimited = false;
    }
    const char *period = unified ? quota : period_text;
    unsigned long long period_value;
    if (!mal_gc_parse_positive(&period, &period_value)) return false;
    while (isspace((unsigned char) *period)) period++;
    if (*period != '\0') return false;
    if (!unified) {
        while (isspace((unsigned char) *quota)) quota++;
        if (*quota != '\0') return false;
    }
    if (!*unlimited) {
        *cpus /= period_value;
        if (*cpus == 0) *cpus = 1;
    }
    return true;
}

static bool mal_gc_read_quota_ancestors(
    MalGcCpuQuota *result, const char *leaf, const char *mountpoint, bool unified,
    bool hierarchy_root_visible, MalGcQuotaReadFile read_file, void *context) {
    char directory[MAL_GC_CGROUP_PATH_LIMIT];
    if (strlen(leaf) >= sizeof(directory)) return false;
    strcpy(directory, leaf);
    bool complete = true;
    for (;;) {
        char quota_path[MAL_GC_CGROUP_PATH_LIMIT + 32];
        char period_path[MAL_GC_CGROUP_PATH_LIMIT + 32];
        snprintf(quota_path, sizeof(quota_path), "%s%s%s", directory,
            strcmp(directory, "/") == 0 ? "" : "/",
            unified ? "cpu.max" : "cpu.cfs_quota_us");
        char quota_text[128];
        char period_text[128];
        MalGcQuotaReadStatus quota_read =
            read_file(quota_path, quota_text, sizeof(quota_text), context);
        MalGcQuotaReadStatus period_read = MAL_GC_QUOTA_READ_OK;
        if (!unified) {
            snprintf(period_path, sizeof(period_path), "%s%scpu.cfs_period_us", directory,
                strcmp(directory, "/") == 0 ? "" : "/");
            period_read = read_file(period_path, period_text, sizeof(period_text), context);
        }
        bool readable = quota_read == MAL_GC_QUOTA_READ_OK &&
            period_read == MAL_GC_QUOTA_READ_OK;
        bool unlimited;
        unsigned long long cpus;
        if (readable && mal_gc_parse_quota(quota_text, unified ? nullptr : period_text,
                unified, &unlimited, &cpus)) {
            if (result->status == MAL_GC_QUOTA_UNKNOWN) result->status = MAL_GC_QUOTA_UNLIMITED;
            if (!unlimited) {
                result->status = MAL_GC_QUOTA_LIMITED;
                if (cpus < result->cpus) result->cpus = (usize) cpus;
            }
        } else if (!(unified && hierarchy_root_visible &&
                     strcmp(directory, mountpoint) == 0 &&
                     quota_read == MAL_GC_QUOTA_READ_MISSING)) {
            complete = false;
        }
        if (strcmp(directory, mountpoint) == 0) break;
        char *last = strrchr(directory, '/');
        if (last == nullptr) return false;
        if (last == directory) last[1] = '\0';
        else *last = '\0';
    }
    return complete;
}

typedef struct MalGcMountSite {
    unsigned long id;
    unsigned long parent;
    char *path;
    bool ancestor;
} MalGcMountSite;

/* Covered mounts remain listed in mountinfo but cannot name the visible cgroup. */
static bool mal_gc_mount_mapping_covered(
    const char *mountinfo, const char *mountpoint, const char *leaf) {
    char *mounts = strdup(mountinfo);
    if (mounts == nullptr) return true;
    MalGcMountSite *sites = nullptr;
    usize count = 0;
    bool covered = false;
    for (char *line = mounts; line != nullptr;) {
        char *next = strchr(line, '\n');
        if (next != nullptr) *next++ = '\0';
        char *save = nullptr;
        char *id_text = strtok_r(line, " ", &save);
        char *parent_text = strtok_r(nullptr, " ", &save);
        (void) strtok_r(nullptr, " ", &save);
        (void) strtok_r(nullptr, " ", &save);
        char *path_text = strtok_r(nullptr, " ", &save);
        if (id_text != nullptr && parent_text != nullptr && path_text != nullptr &&
            strlen(path_text) < MAL_GC_CGROUP_PATH_LIMIT) {
            char *id_end;
            char *parent_end;
            errno = 0;
            unsigned long id = strtoul(id_text, &id_end, 10);
            unsigned long parent = strtoul(parent_text, &parent_end, 10);
            if (errno == ERANGE || *id_end != '\0' || *parent_end != '\0' || id == 0) {
                covered = true;
                break;
            }
            char *path = malloc(strlen(path_text) + 1);
            if (path == nullptr) {
                covered = true;
                break;
            }
            if (!mal_gc_decode_mount_path(path_text, path, strlen(path_text) + 1)) {
                free(path);
                covered = true;
                break;
            }
            MalGcMountSite *grown = realloc(sites, (count + 1) * sizeof(*sites));
            if (grown == nullptr) {
                free(path);
                covered = true;
                break;
            }
            sites = grown;
            sites[count++] = (MalGcMountSite) {id, parent, path, false};
        }
        line = next;
    }
    usize selected = count;
    for (usize i = 0; i < count; ++i) {
        if (strcmp(sites[i].path, mountpoint) == 0) {
            if (selected != count) covered = true;
            selected = i;
        }
        if (strcmp(sites[i].path, mountpoint) != 0 &&
            mal_gc_component_prefix(mountpoint, sites[i].path) &&
            mal_gc_component_prefix(sites[i].path, leaf)) covered = true;
    }
    if (selected == count) covered = true;
    if (!covered) {
        unsigned long id = sites[selected].id;
        for (usize depth = 0; depth < count && id != 0; ++depth) {
            usize index = count;
            for (usize i = 0; i < count; ++i) {
                if (sites[i].id == id) { index = i; break; }
            }
            if (index == count || sites[index].ancestor) break;
            sites[index].ancestor = true;
            id = sites[index].parent;
        }
        for (usize i = 0; i < count; ++i) {
            if (!sites[i].ancestor &&
                mal_gc_component_prefix(sites[i].path, mountpoint) &&
                strcmp(sites[i].path, mountpoint) != 0) covered = true;
        }
    }
    for (usize i = 0; i < count; ++i) free(sites[i].path);
    free(sites);
    free(mounts);
    return covered;
}

MalGcCpuQuota mal_gc_cpu_quota_from_cgroups(
    usize available_cpus, const char *membership, const char *mountinfo,
    MalGcQuotaReadFile read_file, void *context) {
    MalGcCpuQuota result = {available_cpus == 0 ? 1 : available_cpus,
        MAL_GC_QUOTA_UNKNOWN, false};
    if (membership == nullptr || mountinfo == nullptr || read_file == nullptr) return result;
    char member_path[MAL_GC_CGROUP_PATH_LIMIT] = {0};
    bool unified = false;
    char *members = strdup(membership);
    if (members == nullptr) return result;
    for (char *line = members; line != nullptr;) {
        char *next = strchr(line, '\n');
        if (next != nullptr) *next++ = '\0';
        char *first = strchr(line, ':');
        char *second = first == nullptr ? nullptr : strchr(first + 1, ':');
        if (second != nullptr) {
            *first++ = '\0';
            *second++ = '\0';
            bool v1_cpu = mal_gc_csv_has_token(first, "cpu");
            bool v2 = strcmp(line, "0") == 0 && *first == '\0';
            if (v1_cpu && (!mal_gc_cgroup_path_valid(second) ||
                strlen(second) >= sizeof(member_path))) {
                free(members);
                return result;
            }
            if ((v1_cpu || (v2 && member_path[0] == '\0')) &&
                strlen(second) < sizeof(member_path) && mal_gc_cgroup_path_valid(second)) {
                if (v1_cpu) {
                    strcpy(member_path, second);
                    unified = false;
                    break;
                }
                strcpy(member_path, second);
                unified = true;
            }
        }
        line = next;
    }
    free(members);
    if (member_path[0] == '\0') return result;

    char *mounts = strdup(mountinfo);
    if (mounts == nullptr) return result;
    bool matched = false;
    bool complete = true;
    for (char *line = mounts; line != nullptr;) {
        char *next = strchr(line, '\n');
        if (next != nullptr) *next++ = '\0';
        char *separator = strstr(line, " - ");
        if (separator != nullptr) {
            *separator = '\0';
            char *save = nullptr;
            char *token = strtok_r(line, " ", &save);
            char *root_encoded = nullptr;
            char *mount_encoded = nullptr;
            for (usize field = 1; token != nullptr && field <= 5; ++field) {
                if (field == 4) root_encoded = token;
                if (field == 5) mount_encoded = token;
                token = strtok_r(nullptr, " ", &save);
            }
            char *post_save = nullptr;
            char *filesystem = strtok_r(separator + 3, " ", &post_save);
            (void) strtok_r(nullptr, " ", &post_save);
            char *options = strtok_r(nullptr, " ", &post_save);
            bool matching = filesystem != nullptr &&
                (unified ? strcmp(filesystem, "cgroup2") == 0 :
                    strcmp(filesystem, "cgroup") == 0 && options != nullptr &&
                    mal_gc_csv_has_token(options, "cpu"));
            if (matching && root_encoded != nullptr && mount_encoded != nullptr) {
                char root[MAL_GC_CGROUP_PATH_LIMIT];
                char mountpoint[MAL_GC_CGROUP_PATH_LIMIT];
                if (mal_gc_decode_mount_path(root_encoded, root, sizeof(root)) &&
                    mal_gc_decode_mount_path(mount_encoded, mountpoint, sizeof(mountpoint)) &&
                    mal_gc_component_prefix(root, member_path)) {
                    const char *suffix = strcmp(root, "/") == 0 ? member_path :
                        member_path + strlen(root);
                    usize mount_length = strlen(mountpoint);
                    usize suffix_length = strlen(suffix);
                    if (mount_length + suffix_length < MAL_GC_CGROUP_PATH_LIMIT) {
                        char leaf[MAL_GC_CGROUP_PATH_LIMIT];
                        strcpy(leaf, mountpoint);
                        if (strcmp(suffix, "/") != 0) {
                            if (strcmp(mountpoint, "/") == 0 && suffix[0] == '/') {
                                strcpy(leaf, suffix);
                            } else {
                                strcat(leaf, suffix);
                            }
                        }
                        if (!mal_gc_mount_mapping_covered(mountinfo, mountpoint, leaf)) {
                            matched = true;
                            if (!mal_gc_read_quota_ancestors(&result, leaf, mountpoint, unified,
                                    strcmp(root, "/") == 0, read_file, context) ||
                                strcmp(root, "/") != 0) complete = false;
                        } else complete = false;
                    }
                }
            }
        }
        line = next;
    }
    free(mounts);
    result.complete = matched && complete;
    if (!result.complete && result.status == MAL_GC_QUOTA_UNLIMITED) {
        result.status = MAL_GC_QUOTA_UNKNOWN;
    }
    return result;
}

#if defined(__linux__) && !defined(__wasi__)
static char *mal_gc_read_proc_text(const char *path, usize limit) {
    FILE *file = fopen(path, "r");
    if (file == nullptr) return nullptr;
    char *text = malloc(limit + 1);
    if (text == nullptr) {
        fclose(file);
        return nullptr;
    }
    usize count = fread(text, 1, limit + 1, file);
    bool failed = ferror(file) != 0;
    fclose(file);
    if (failed || count > limit) {
        free(text);
        return nullptr;
    }
    text[count] = '\0';
    return text;
}

static MalGcQuotaReadStatus mal_gc_read_quota_file(
    const char *path, char *output, usize capacity, void *context) {
    (void) context;
    FILE *file = fopen(path, "r");
    if (file == nullptr) return errno == ENOENT ? MAL_GC_QUOTA_READ_MISSING :
        MAL_GC_QUOTA_READ_ERROR;
    usize count = fread(output, 1, capacity, file);
    bool valid = count < capacity && (feof(file) || !ferror(file));
    fclose(file);
    if (!valid) return MAL_GC_QUOTA_READ_ERROR;
    output[count] = '\0';
    return MAL_GC_QUOTA_READ_OK;
}

MalGcCpuQuota mal_gc_linux_cpu_quota(usize available_cpus) {
    MalGcCpuQuota fallback = {available_cpus, MAL_GC_QUOTA_UNKNOWN, false};
    char *membership = mal_gc_read_proc_text("/proc/thread-self/cgroup", MAL_GC_CGROUP_TEXT_LIMIT);
    if (membership == nullptr) {
        membership = mal_gc_read_proc_text("/proc/self/cgroup", MAL_GC_CGROUP_TEXT_LIMIT);
    }
    char *mountinfo = mal_gc_read_proc_text("/proc/self/mountinfo", MAL_GC_CGROUP_TEXT_LIMIT);
    if (membership == nullptr || mountinfo == nullptr) {
        free(membership);
        free(mountinfo);
        return fallback;
    }
    MalGcCpuQuota result = mal_gc_cpu_quota_from_cgroups(available_cpus, membership,
        mountinfo, mal_gc_read_quota_file, nullptr);
    free(membership);
    free(mountinfo);
    return result;
}
#endif
