#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif
#if defined(__APPLE__) && !defined(_DARWIN_C_SOURCE)
#define _DARWIN_C_SOURCE
#endif

#include "posix_fs.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static u32 mal_posix_ft_from_mode(mode_t m) {
    if (S_ISREG(m)) {
        return MAL_POSIX_FT_FILE;
    }
    if (S_ISDIR(m)) {
        return MAL_POSIX_FT_DIR;
    }
    if (S_ISLNK(m)) {
        return MAL_POSIX_FT_SYMLINK;
    }
    return MAL_POSIX_FT_OTHER;
}

/* Classify a directory entry by lstat on the joined "dir/name" path (the entry's
 * own type — symlinks are not followed). Used only when the readdir d_type is
 * unavailable or DT_UNKNOWN. Any failure degrades to OTHER. */
static u32 mal_posix_lstat_type(const char *dir, const char *name) {
    usize dl = strlen(dir);
    usize nl = strlen(name);
    if (dl > SIZE_MAX - nl - 2) {
        return MAL_POSIX_FT_OTHER;
    }
    char *full = malloc(dl + 1 + nl + 1);
    if (full == nullptr) {
        return MAL_POSIX_FT_OTHER;
    }
    memcpy(full, dir, dl);
    usize o = dl;
    if (dl == 0 || dir[dl - 1] != '/') {
        full[o++] = '/';
    }
    memcpy(full + o, name, nl);
    o += nl;
    full[o] = '\0';
    struct stat st;
    u32 type = MAL_POSIX_FT_OTHER;
    if (lstat(full, &st) == 0) {
        type = mal_posix_ft_from_mode(st.st_mode);
    }
    free(full);
    return type;
}

static u32 mal_posix_dirent_type(const char *dir, const struct dirent *de) {
#ifdef DT_DIR
    switch (de->d_type) {
        case DT_DIR:
            return MAL_POSIX_FT_DIR;
        case DT_REG:
            return MAL_POSIX_FT_FILE;
#ifdef DT_LNK
        case DT_LNK:
            return MAL_POSIX_FT_SYMLINK;
#endif
        case DT_UNKNOWN:
            break; // some filesystems don't fill d_type — fall back to lstat
        default:
            return MAL_POSIX_FT_OTHER; // fifo / socket / device
    }
#endif
    return mal_posix_lstat_type(dir, de->d_name);
}

bool mal_posix_fs_exists(const char *path) {
    struct stat st;
    return stat(path, &st) == 0;
}

int mal_posix_fs_read_file(const char *path, byte **out_data, usize *out_len) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) {
        return errno;
    }
    struct stat st;
    if (fstat(fd, &st) != 0) {
        int err = errno;
        close(fd);
        return err;
    }
    if (S_ISDIR(st.st_mode)) {
        close(fd);
        return EISDIR;
    }
    // Size is a hint only (a growing file / proc entry may exceed it), so the read
    // loop grows the buffer until EOF rather than trusting st_size.
    usize cap = 4096;
    if (st.st_size > 0) {
        if ((uintmax_t) st.st_size >= (uintmax_t) SIZE_MAX) {
            close(fd);
            return EFBIG;
        }
        cap = (usize) st.st_size + 1;
    }
    byte *buf = malloc(cap);
    if (buf == nullptr) {
        close(fd);
        return ENOMEM;
    }
    usize len = 0;
    for (;;) {
        if (len == cap) {
            if (cap > SIZE_MAX / 2) {
                free(buf);
                close(fd);
                return EFBIG;
            }
            cap *= 2;
            byte *grown = realloc(buf, cap);
            if (grown == nullptr) {
                free(buf);
                close(fd);
                return ENOMEM;
            }
            buf = grown;
        }
        ssize_t n = read(fd, buf + len, cap - len);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            int err = errno;
            free(buf);
            close(fd);
            return err;
        }
        if (n == 0) {
            break;
        }
        len += (usize) n;
    }
    if (close(fd) != 0) {
        int err = errno;
        free(buf);
        return err;
    }
    *out_data = buf;
    *out_len = len;
    return 0;
}

static int mal_posix_fs_write_file_flags(
    const char *path, const byte *data, usize len, int flags) {
    int fd = open(path, O_WRONLY | O_CREAT | flags, 0666);
    if (fd < 0) {
        return errno;
    }
    usize off = 0;
    while (off < len) {
        ssize_t n = write(fd, data + off, len - off);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            int err = errno;
            close(fd);
            return err;
        }
        if (n == 0) {
            close(fd);
            return EIO;
        }
        off += (usize) n;
    }
    if (close(fd) < 0) {
        return errno;
    }
    return 0;
}

int mal_posix_fs_write_file(const char *path, const byte *data, usize len) {
    return mal_posix_fs_write_file_flags(path, data, len, O_TRUNC);
}

int mal_posix_fs_append_file(const char *path, const byte *data, usize len) {
    return mal_posix_fs_write_file_flags(path, data, len, O_APPEND);
}

int mal_posix_fs_unlink(const char *path) {
    if (unlink(path) != 0) return errno;
    return 0;
}

int mal_posix_fs_chmod(const char *path, u32 mode) {
    if (chmod(path, (mode_t) mode) != 0) return errno;
    return 0;
}

int mal_posix_fs_write_fd(int fd, const byte *data, usize len, usize *written) {
    usize off = 0;
    while (off < len) {
        ssize_t count = write(fd, data + off, len - off);
        if (count < 0) {
            if (errno == EINTR) continue;
            *written = off;
            return errno;
        }
        if (count == 0) {
            *written = off;
            return EIO;
        }
        off += (usize) count;
    }
    *written = off;
    return 0;
}

int mal_posix_fs_close_fd(int fd) {
    return close(fd) == 0 ? 0 : errno;
}

static void mal_posix_fs_copy_stat(const struct stat *st, MalPosixStat *out) {
    out->type = mal_posix_ft_from_mode(st->st_mode);
    out->dev = (f64) st->st_dev;
    out->ino = (f64) st->st_ino;
    out->size = (f64) st->st_size;
    out->mode = (u32) st->st_mode;
#if defined(__APPLE__)
    out->ctime_ms = (f64) st->st_ctimespec.tv_sec * 1000.0 + (f64) st->st_ctimespec.tv_nsec / 1.0e6;
    out->mtime_ms = (f64) st->st_mtimespec.tv_sec * 1000.0 + (f64) st->st_mtimespec.tv_nsec / 1.0e6;
#else
    out->ctime_ms = (f64) st->st_ctim.tv_sec * 1000.0 + (f64) st->st_ctim.tv_nsec / 1.0e6;
    out->mtime_ms = (f64) st->st_mtim.tv_sec * 1000.0 + (f64) st->st_mtim.tv_nsec / 1.0e6;
#endif
}

int mal_posix_fs_stat(const char *path, MalPosixStat *out) {
    struct stat st;
    if (stat(path, &st) != 0) return errno;
    mal_posix_fs_copy_stat(&st, out);
    return 0;
}

int mal_posix_fs_utimes(const char *path,
    i64 atime_seconds, i64 atime_nanoseconds,
    i64 mtime_seconds, i64 mtime_nanoseconds) {
    struct timespec times[2] = {
        { .tv_sec = (time_t) atime_seconds, .tv_nsec = (long) atime_nanoseconds },
        { .tv_sec = (time_t) mtime_seconds, .tv_nsec = (long) mtime_nanoseconds },
    };
    return utimensat(AT_FDCWD, path, times, 0) == 0 ? 0 : errno;
}

int mal_posix_fs_lstat(const char *path, MalPosixStat *out) {
    struct stat st;
    if (lstat(path, &st) != 0) return errno;
    mal_posix_fs_copy_stat(&st, out);
    return 0;
}

void mal_posix_fs_free_dirents(MalPosixDirent *entries, usize count) {
    if (entries == nullptr) {
        return;
    }
    for (usize i = 0; i < count; i++) {
        free(entries[i].name);
    }
    free(entries);
}

int mal_posix_fs_readdir(const char *path, MalPosixDirent **out_entries, usize *out_count) {
    DIR *dir = opendir(path);
    if (dir == nullptr) {
        return errno;
    }
    usize cap = 16;
    usize count = 0;
    MalPosixDirent *arr = malloc(sizeof(MalPosixDirent) * cap);
    if (arr == nullptr) {
        closedir(dir);
        return ENOMEM;
    }
    errno = 0; // readdir returns null both at end-of-stream and on error
    struct dirent *de;
    while ((de = readdir(dir)) != nullptr) {
        const char *nm = de->d_name;
        if (nm[0] == '.' && (nm[1] == '\0' || (nm[1] == '.' && nm[2] == '\0'))) {
            continue; // skip "." and ".."
        }
        if (count == cap) {
            if (cap > SIZE_MAX / 2 / sizeof(MalPosixDirent)) {
                mal_posix_fs_free_dirents(arr, count);
                closedir(dir);
                return ENOMEM;
            }
            cap *= 2;
            MalPosixDirent *grown = realloc(arr, sizeof(MalPosixDirent) * cap);
            if (grown == nullptr) {
                mal_posix_fs_free_dirents(arr, count);
                closedir(dir);
                return ENOMEM;
            }
            arr = grown;
        }
        usize nlen = strlen(nm);
        char *name = malloc(nlen + 1);
        if (name == nullptr) {
            mal_posix_fs_free_dirents(arr, count);
            closedir(dir);
            return ENOMEM;
        }
        memcpy(name, nm, nlen + 1);
        arr[count].name = name;
        arr[count].type = mal_posix_dirent_type(path, de);
        count++;
        errno = 0;
    }
    int err = errno;
    if (closedir(dir) != 0 && err == 0) {
        err = errno;
    }
    if (err != 0) {
        mal_posix_fs_free_dirents(arr, count);
        return err;
    }
    *out_entries = arr;
    *out_count = count;
    return 0;
}

int mal_posix_fs_mkdir(const char *path, bool recursive) {
    if (!recursive) {
        if (mkdir(path, 0777) != 0) {
            return errno;
        }
        return 0;
    }
    usize len = strlen(path);
    if (len == 0) {
        return ENOENT;
    }
    char *buf = malloc(len + 1);
    if (buf == nullptr) {
        return ENOMEM;
    }
    memcpy(buf, path, len + 1);
    // A trailing slash would make the final component empty; trim it.
    while (len > 1 && buf[len - 1] == '/') {
        buf[--len] = '\0';
    }
    // Create each prefix in turn. EEXIST is success only when that prefix really
    // is a directory; accepting a regular file would incorrectly make the final
    // component of mkdirSync(file, { recursive: true }) succeed.
    for (usize i = 1; i <= len; i++) {
        if (buf[i] == '/' || buf[i] == '\0') {
            char saved = buf[i];
            buf[i] = '\0';
            if (mkdir(buf, 0777) != 0) {
                int err = errno;
                struct stat st;
                if (err == EEXIST && stat(buf, &st) != 0) {
                    err = errno;
                } else if (err == EEXIST && S_ISDIR(st.st_mode)) {
                    buf[i] = saved;
                    continue;
                }
                free(buf);
                return err;
            }
            buf[i] = saved;
        }
    }
    free(buf);
    return 0;
}

int mal_posix_fs_copy_file(const char *source, const char *destination) {
    int source_fd = open(source, O_RDONLY);
    if (source_fd < 0) {
        return errno;
    }
    struct stat st;
    if (fstat(source_fd, &st) != 0) {
        int err = errno;
        close(source_fd);
        return err;
    }
    int destination_fd = open(destination, O_WRONLY | O_CREAT | O_TRUNC, st.st_mode & 0777);
    if (destination_fd < 0) {
        int err = errno;
        close(source_fd);
        return err;
    }
    byte buffer[16384];
    int result = 0;
    for (;;) {
        ssize_t read_count = read(source_fd, buffer, sizeof buffer);
        if (read_count < 0) {
            if (errno == EINTR) {
                continue;
            }
            result = errno;
            break;
        }
        if (read_count == 0) {
            break;
        }
        ssize_t offset = 0;
        while (offset < read_count) {
            ssize_t written = write(destination_fd, buffer + offset, (usize) (read_count - offset));
            if (written < 0 && errno == EINTR) {
                continue;
            }
            if (written <= 0) {
                result = written < 0 ? errno : EIO;
                break;
            }
            offset += written;
        }
        if (result != 0) {
            break;
        }
    }
    if (close(source_fd) != 0 && result == 0) result = errno;
    if (close(destination_fd) != 0 && result == 0) result = errno;
    return result;
}

int mal_posix_fs_realpath(const char *path, char **out_path) {
    char *resolved = realpath(path, nullptr);
    if (resolved == nullptr) {
        return errno;
    }
    *out_path = resolved;
    return 0;
}

int mal_posix_fs_mkdtemp(const char *prefix, char **out_path) {
    usize len = strlen(prefix);
    char *template = malloc(len + 7);
    if (template == nullptr) {
        return ENOMEM;
    }
    memcpy(template, prefix, len);
    memcpy(template + len, "XXXXXX", 7);
    if (mkdtemp(template) == nullptr) {
        int err = errno;
        free(template);
        return err;
    }
    *out_path = template;
    return 0;
}

int mal_posix_fs_private_directory(const char *path, bool *out_private) {
    struct stat st;
    if (lstat(path, &st) != 0) {
        return errno;
    }
    *out_private = S_ISDIR(st.st_mode) && st.st_uid == geteuid() && (st.st_mode & 0077) == 0;
    return 0;
}

int mal_posix_fs_rename(const char *source, const char *destination) {
    return rename(source, destination) == 0 ? 0 : errno;
}

static int mal_posix_fs_rm_recursive(const char *path) {
    struct stat st;
    if (lstat(path, &st) != 0) return errno;
    if (!S_ISDIR(st.st_mode)) return unlink(path) == 0 ? 0 : errno;

    DIR *dir = opendir(path);
    if (dir == nullptr) return errno;
    int result = 0;
    struct dirent *entry;
    while ((entry = readdir(dir)) != nullptr) {
        if (entry->d_name[0] == '.'
            && (entry->d_name[1] == '\0'
                || (entry->d_name[1] == '.' && entry->d_name[2] == '\0'))) {
            continue;
        }
        usize path_len = strlen(path);
        usize name_len = strlen(entry->d_name);
        char *child = malloc(path_len + name_len + 2);
        if (child == nullptr) {
            result = ENOMEM;
            break;
        }
        memcpy(child, path, path_len);
        child[path_len] = '/';
        memcpy(child + path_len + 1, entry->d_name, name_len + 1);
        result = mal_posix_fs_rm_recursive(child);
        free(child);
        if (result != 0) break;
    }
    if (closedir(dir) != 0 && result == 0) result = errno;
    if (result == 0 && rmdir(path) != 0) result = errno;
    return result;
}

int mal_posix_fs_rm(const char *path, bool recursive, bool force) {
    int result;
    if (recursive) result = mal_posix_fs_rm_recursive(path);
    else result = unlink(path) == 0 ? 0 : errno;
    return force && result == ENOENT ? 0 : result;
}

const char *mal_posix_fs_errno_name(int err) {
    switch (err) {
        case EACCES:
            return "EACCES";
        case EEXIST:
            return "EEXIST";
        case EFBIG:
            return "EFBIG";
        case EBADF:
            return "EBADF";
        case EINVAL:
            return "EINVAL";
        case EISDIR:
            return "EISDIR";
        case EIO:
            return "EIO";
        case ELOOP:
            return "ELOOP";
        case EXDEV:
            return "EXDEV";
        case EMFILE:
            return "EMFILE";
        case ENAMETOOLONG:
            return "ENAMETOOLONG";
        case ENFILE:
            return "ENFILE";
        case ENOENT:
            return "ENOENT";
        case ENOMEM:
            return "ENOMEM";
        case ENOSPC:
            return "ENOSPC";
        case ENOTDIR:
            return "ENOTDIR";
        case ENOTEMPTY:
            return "ENOTEMPTY";
        case EPERM:
            return "EPERM";
        case EROFS:
            return "EROFS";
        default:
            return "UNKNOWN";
    }
}
