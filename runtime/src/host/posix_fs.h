#pragma once

#include "./defaults.h"

/*
 * Synchronous filesystem primitives (host layer). Thin, engine-neutral wrappers
 * over the POSIX syscalls that back `node:fs`'s *Sync surface: no VM types cross
 * this boundary, so the runtime layer (node_fs.c) owns all JS marshalling and this
 * file owns all `<sys/stat.h>` / `<dirent.h>` / `<fcntl.h>` contact.
 *
 * Result convention: every call returns 0 on success or a positive errno on
 * failure (the runtime layer turns that into a Node-shaped Error). `existsSync`
 * is the one exception — a missing path is a normal `false`, not an error. Paths
 * are validated for embedded NUL by the runtime layer before reaching this API.
 */

/* Coarse file classification the Stats / Dirent predicates need. The
 * runtime layer stores this on Stats / Dirent and compares against it, so it never
 * needs the POSIX `S_IF*` bits itself. */
typedef enum MalPosixFileType {
    MAL_POSIX_FT_OTHER = 0,
    MAL_POSIX_FT_FILE = 1,
    MAL_POSIX_FT_DIR = 2,
    MAL_POSIX_FT_SYMLINK = 3,
    MAL_POSIX_FT_BLOCK = 4,
    MAL_POSIX_FT_CHARACTER = 5,
    MAL_POSIX_FT_FIFO = 6,
    MAL_POSIX_FT_SOCKET = 7,
} MalPosixFileType;

typedef struct MalPosixStat {
    f64 atime_ms; // last-access time in milliseconds since the epoch
    f64 ctime_ms; // metadata-change time in milliseconds since the epoch
    f64 mtime_ms; // modification time in milliseconds since the epoch
    f64 birthtime_ms; // creation time, or ctime where unavailable
    f64 dev;
    f64 ino;
    f64 size;
    f64 nlink;
    f64 uid;
    f64 gid;
    f64 rdev;
    f64 blksize;
    f64 blocks;
    u32 mode;
    u32 type;     // MalPosixFileType (follows symlinks, like stat(2))
} MalPosixStat;

typedef struct MalPosixDirent {
    char *name; // owned, NUL-terminated UTF-8; free via mal_posix_fs_free_dirents
    u32 type;   // MalPosixFileType of the entry itself (does NOT follow symlinks)
} MalPosixDirent;

/* Host-independent flags accepted by mal_posix_fs_open. The runtime maps Node's
 * string spellings onto these bits; the host layer owns the platform O_* values. */
typedef enum MalPosixOpenFlags {
    MAL_POSIX_OPEN_READ = 1u << 0,
    MAL_POSIX_OPEN_WRITE = 1u << 1,
    MAL_POSIX_OPEN_APPEND = 1u << 2,
    MAL_POSIX_OPEN_CREATE = 1u << 3,
    MAL_POSIX_OPEN_EXCLUSIVE = 1u << 4,
    MAL_POSIX_OPEN_TRUNCATE = 1u << 5,
    MAL_POSIX_OPEN_SYNC = 1u << 6,
} MalPosixOpenFlags;

/* Platform values published by `node:fs.constants`. Keeping the table in the
 * host layer prevents the JS runtime from depending on POSIX O_* / S_* macros. */
typedef struct MalPosixFsConstant {
    const char *name;
    i64 value;
} MalPosixFsConstant;

const MalPosixFsConstant *mal_posix_fs_constants(usize *out_count);

/* True iff `path` resolves (following symlinks). Never reports an error: any stat
 * failure (missing, permission, dangling symlink) is a plain false, matching
 * fs.existsSync. */
bool mal_posix_fs_exists(const char *path);

/* Check `path` with POSIX F_OK/R_OK/W_OK/X_OK bits. */
int mal_posix_fs_access(const char *path, u32 mode);

/* Open `path` and return its descriptor through `out_fd`. `flags` contains
 * MalPosixOpenFlags unless `native_flags` is true, in which case it is the
 * caller-supplied platform O_* mask used by Node's numeric-flags form. */
int mal_posix_fs_open(
    const char *path, u32 flags, bool native_flags, u32 mode, int *out_fd);

/* Read the whole file at `path` into a fresh malloc'd buffer (*out_data, *out_len).
 * Grows past the stat size hint so streams/proc files still read fully. The caller
 * frees *out_data on success. Returns 0, or an errno (EISDIR if `path` is a
 * directory, mirroring Node). */
int mal_posix_fs_read_file(const char *path, byte **out_data, usize *out_len);

/* Read from an open descriptor's current offset through EOF without closing it.
 * Directory descriptors fail with EISDIR, matching Node's whole-file helpers. */
int mal_posix_fs_read_all_fd(int fd, byte **out_data, usize *out_len);

/* Truncate-or-create `path` (mode 0666 & umask) and write all `len` bytes. Returns
 * 0 or an errno. */
int mal_posix_fs_write_file(const char *path, const byte *data, usize len);

/* Create-or-append `path` (mode 0666 & umask) and write all `len` bytes. */
int mal_posix_fs_append_file(const char *path, const byte *data, usize len);

/* Create hard and symbolic links, and read a symbolic link's uninterpreted byte
 * payload into a fresh malloc-owned buffer. */
int mal_posix_fs_link(const char *existing_path, const char *new_path);
int mal_posix_fs_symlink(const char *target, const char *path);
int mal_posix_fs_readlink(const char *path, byte **out_data, usize *out_len);

/* Remove one non-directory filesystem entry. */
int mal_posix_fs_unlink(const char *path);

/* Replace one filesystem entry's POSIX mode bits. */
int mal_posix_fs_chmod(const char *path, u32 mode);

/* Write all bytes to an open descriptor. Returns 0 or an errno. */
int mal_posix_fs_write_fd(int fd, const byte *data, usize len, usize *written);

/* Read up to `len` bytes into `data`. With `has_position`, use pread(2) so the
 * descriptor's current offset is unchanged; otherwise consume from that offset.
 * The exact number of bytes read (including zero at EOF) is returned in `read`. */
int mal_posix_fs_read_fd(
    int fd, byte *data, usize len, bool has_position, i64 position, usize *read);

/* Close an open descriptor. Returns 0 or an errno. */
int mal_posix_fs_close_fd(int fd);

/* Flush and resize open descriptors. */
int mal_posix_fs_sync_fd(int fd);
int mal_posix_fs_truncate_fd(int fd, i64 length);

/* stat(2) `path` into `*out` (follows symlinks). Returns 0 or an errno. */
int mal_posix_fs_stat(const char *path, MalPosixStat *out);

/* fstat(2) an open descriptor into `*out`. */
int mal_posix_fs_fstat(int fd, MalPosixStat *out);

/* Set access and modification timestamps with nanosecond precision. */
int mal_posix_fs_utimes(const char *path,
    i64 atime_seconds, i64 atime_nanoseconds,
    i64 mtime_seconds, i64 mtime_nanoseconds);

/* lstat(2) `path` into `*out` (does not follow symlinks). */
int mal_posix_fs_lstat(const char *path, MalPosixStat *out);

/* Read the directory at `path` into a fresh malloc'd array (*out_entries,
 * *out_count), skipping "." and "..". Each entry's `type` is the entry's own type
 * (symlinks stay OTHER, like readdir withFileTypes). On success the caller frees
 * the array with mal_posix_fs_free_dirents. Returns 0 or an errno. */
int mal_posix_fs_readdir(const char *path, MalPosixDirent **out_entries, usize *out_count);

/* Free an array returned by mal_posix_fs_readdir (its owned names + the array). */
void mal_posix_fs_free_dirents(MalPosixDirent *entries, usize count);

/* Create the directory `path` (mode 0777 & umask). With `recursive`, create every
 * missing parent and treat an already-existing directory as success (mkdir -p /
 * fs.mkdirSync({recursive:true})). Returns 0 or an errno. */
int mal_posix_fs_mkdir(const char *path, bool recursive);

/* The additional synchronous operations used by native compiler caches. String
 * results are malloc-owned and must be freed by the caller. */
int mal_posix_fs_copy_file(const char *source, const char *destination);
int mal_posix_fs_realpath(const char *path, char **out_path);
int mal_posix_fs_mkdtemp(const char *prefix, char **out_path);
/* lstat-based ownership check for a materialized cache directory: it must be a
 * real directory, owned by the effective user, with no group/other access. */
int mal_posix_fs_private_directory(const char *path, bool *out_private);
int mal_posix_fs_rename(const char *source, const char *destination);
int mal_posix_fs_rm(const char *path, bool recursive, bool force);

/* The symbolic name of an errno ("ENOENT", ...) for Node-shaped error `.code`.
 * Returns "UNKNOWN" for codes outside the mapped set. */
const char *mal_posix_fs_errno_name(int err);
