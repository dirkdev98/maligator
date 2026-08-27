#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif
#if !defined(__APPLE__) && !defined(_DEFAULT_SOURCE)
#define _DEFAULT_SOURCE
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
    if (S_ISBLK(m)) {
        return MAL_POSIX_FT_BLOCK;
    }
    if (S_ISCHR(m)) {
        return MAL_POSIX_FT_CHARACTER;
    }
    if (S_ISFIFO(m)) {
        return MAL_POSIX_FT_FIFO;
    }
    if (S_ISSOCK(m)) {
        return MAL_POSIX_FT_SOCKET;
    }
    return MAL_POSIX_FT_OTHER;
}

const MalPosixFsConstant *mal_posix_fs_constants(usize *out_count) {
    static const MalPosixFsConstant constants[] = {
        {"UV_FS_SYMLINK_DIR", 1},
        {"UV_FS_SYMLINK_JUNCTION", 2},
        {"O_RDONLY", O_RDONLY},
        {"O_WRONLY", O_WRONLY},
        {"O_RDWR", O_RDWR},
        {"UV_DIRENT_UNKNOWN", 0},
        {"UV_DIRENT_FILE", 1},
        {"UV_DIRENT_DIR", 2},
        {"UV_DIRENT_LINK", 3},
        {"UV_DIRENT_FIFO", 4},
        {"UV_DIRENT_SOCKET", 5},
        {"UV_DIRENT_CHAR", 6},
        {"UV_DIRENT_BLOCK", 7},
        {"S_IFMT", S_IFMT},
        {"S_IFREG", S_IFREG},
        {"S_IFDIR", S_IFDIR},
        {"S_IFCHR", S_IFCHR},
        {"S_IFBLK", S_IFBLK},
        {"S_IFIFO", S_IFIFO},
        {"S_IFLNK", S_IFLNK},
        {"S_IFSOCK", S_IFSOCK},
        {"O_CREAT", O_CREAT},
        {"O_EXCL", O_EXCL},
        {"UV_FS_O_FILEMAP", 0},
#ifdef O_NOCTTY
        {"O_NOCTTY", O_NOCTTY},
#endif
        {"O_TRUNC", O_TRUNC},
        {"O_APPEND", O_APPEND},
#ifdef O_DIRECTORY
        {"O_DIRECTORY", O_DIRECTORY},
#endif
#ifdef O_NOFOLLOW
        {"O_NOFOLLOW", O_NOFOLLOW},
#endif
        {"O_SYNC", O_SYNC},
#ifdef O_DSYNC
        {"O_DSYNC", O_DSYNC},
#endif
#ifdef O_SYMLINK
        {"O_SYMLINK", O_SYMLINK},
#endif
#ifdef O_NONBLOCK
        {"O_NONBLOCK", O_NONBLOCK},
#endif
        {"S_IRWXU", S_IRWXU},
        {"S_IRUSR", S_IRUSR},
        {"S_IWUSR", S_IWUSR},
        {"S_IXUSR", S_IXUSR},
        {"S_IRWXG", S_IRWXG},
        {"S_IRGRP", S_IRGRP},
        {"S_IWGRP", S_IWGRP},
        {"S_IXGRP", S_IXGRP},
        {"S_IRWXO", S_IRWXO},
        {"S_IROTH", S_IROTH},
        {"S_IWOTH", S_IWOTH},
        {"S_IXOTH", S_IXOTH},
        {"F_OK", F_OK},
        {"R_OK", R_OK},
        {"W_OK", W_OK},
        {"X_OK", X_OK},
        {"UV_FS_COPYFILE_EXCL", 1},
        {"COPYFILE_EXCL", 1},
        {"UV_FS_COPYFILE_FICLONE", 2},
        {"COPYFILE_FICLONE", 2},
        {"UV_FS_COPYFILE_FICLONE_FORCE", 4},
        {"COPYFILE_FICLONE_FORCE", 4},
    };
    *out_count = sizeof(constants) / sizeof(constants[0]);
    return constants;
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
#ifdef DT_BLK
        case DT_BLK:
            return MAL_POSIX_FT_BLOCK;
#endif
#ifdef DT_CHR
        case DT_CHR:
            return MAL_POSIX_FT_CHARACTER;
#endif
#ifdef DT_FIFO
        case DT_FIFO:
            return MAL_POSIX_FT_FIFO;
#endif
#ifdef DT_SOCK
        case DT_SOCK:
            return MAL_POSIX_FT_SOCKET;
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

int mal_posix_fs_access(const char *path, u32 mode) {
    return access(path, (int) mode) == 0 ? 0 : errno;
}

int mal_posix_fs_open(
    const char *path, u32 flags, bool native_flags, u32 mode, int *out_fd) {
    int native = 0;
    if (native_flags) {
        native = (int) flags;
    } else {
        bool read = (flags & MAL_POSIX_OPEN_READ) != 0;
        bool write = (flags & MAL_POSIX_OPEN_WRITE) != 0;
        if (read && write) native |= O_RDWR;
        else if (write) native |= O_WRONLY;
        else native |= O_RDONLY;
        if (flags & MAL_POSIX_OPEN_APPEND) native |= O_APPEND;
        if (flags & MAL_POSIX_OPEN_CREATE) native |= O_CREAT;
        if (flags & MAL_POSIX_OPEN_EXCLUSIVE) native |= O_EXCL;
        if (flags & MAL_POSIX_OPEN_TRUNCATE) native |= O_TRUNC;
        if (flags & MAL_POSIX_OPEN_SYNC) native |= O_SYNC;
    }
#ifdef O_CLOEXEC
    native |= O_CLOEXEC;
#endif
    int fd;
    do {
        fd = open(path, native, (mode_t) mode);
    } while (fd < 0 && errno == EINTR);
    if (fd < 0) return errno;
    *out_fd = fd;
    return 0;
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

int mal_posix_fs_read_fd(
    int fd, byte *data, usize len, bool has_position, i64 position, usize *read_count) {
    ssize_t count;
    do {
        count = has_position
            ? pread(fd, data, len, (off_t) position)
            : read(fd, data, len);
    } while (count < 0 && errno == EINTR);
    if (count < 0) {
        *read_count = 0;
        return errno;
    }
    *read_count = (usize) count;
    return 0;
}

int mal_posix_fs_close_fd(int fd) {
    return close(fd) == 0 ? 0 : errno;
}

int mal_posix_fs_sync_fd(int fd) {
    int result;
    do {
        result = fsync(fd);
    } while (result != 0 && errno == EINTR);
    return result == 0 ? 0 : errno;
}

int mal_posix_fs_truncate_fd(int fd, i64 length) {
    int result;
    do {
        result = ftruncate(fd, (off_t) length);
    } while (result != 0 && errno == EINTR);
    return result == 0 ? 0 : errno;
}

static void mal_posix_fs_copy_stat(const struct stat *st, MalPosixStat *out) {
    out->type = mal_posix_ft_from_mode(st->st_mode);
    out->dev = (f64) st->st_dev;
    out->ino = (f64) st->st_ino;
    out->size = (f64) st->st_size;
    out->mode = (u32) st->st_mode;
    out->nlink = (f64) st->st_nlink;
    out->uid = (f64) st->st_uid;
    out->gid = (f64) st->st_gid;
    out->rdev = (f64) st->st_rdev;
    out->blksize = (f64) st->st_blksize;
    out->blocks = (f64) st->st_blocks;
#if defined(__APPLE__)
    out->atime_ms = (f64) st->st_atimespec.tv_sec * 1000.0 + (f64) st->st_atimespec.tv_nsec / 1.0e6;
    out->ctime_ms = (f64) st->st_ctimespec.tv_sec * 1000.0 + (f64) st->st_ctimespec.tv_nsec / 1.0e6;
    out->mtime_ms = (f64) st->st_mtimespec.tv_sec * 1000.0 + (f64) st->st_mtimespec.tv_nsec / 1.0e6;
    out->birthtime_ms = (f64) st->st_birthtimespec.tv_sec * 1000.0 + (f64) st->st_birthtimespec.tv_nsec / 1.0e6;
#else
    out->atime_ms = (f64) st->st_atim.tv_sec * 1000.0 + (f64) st->st_atim.tv_nsec / 1.0e6;
    out->ctime_ms = (f64) st->st_ctim.tv_sec * 1000.0 + (f64) st->st_ctim.tv_nsec / 1.0e6;
    out->mtime_ms = (f64) st->st_mtim.tv_sec * 1000.0 + (f64) st->st_mtim.tv_nsec / 1.0e6;
    out->birthtime_ms = out->ctime_ms;
#endif
}

int mal_posix_fs_stat(const char *path, MalPosixStat *out) {
    struct stat st;
    if (stat(path, &st) != 0) return errno;
    mal_posix_fs_copy_stat(&st, out);
    return 0;
}

int mal_posix_fs_fstat(int fd, MalPosixStat *out) {
    struct stat st;
    if (fstat(fd, &st) != 0) return errno;
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
