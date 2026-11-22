// Generated from src/platform/catalog.ts; edit the catalog and regenerate.
/**
 * Read, write, and stream files, work with directories, and watch for changes.
 */
declare module "maligator:fs" {
	/**
	 * A path, or a `file:` URL. A relative path resolves against the working directory
	 * when an operation runs.
	 *
	 * @see https://maligator.ddv.tools/api/fs#FilePath
	 */
	export type FilePath = string | URL;

	/**
	 * Contents to write. Strings are written as UTF-8; views write the bytes they cover.
	 *
	 * @see https://maligator.ddv.tools/api/fs#FileData
	 */
	export type FileData = string | ArrayBufferView | ArrayBuffer;

	/**
	 * How `write` stores the contents.
	 *
	 * @see https://maligator.ddv.tools/api/fs#WriteOptions
	 */
	export type WriteOptions = {
		/** Write a temporary file next to the target and rename it over the target, so readers see the old or the new contents and never a partial file. Defaults to false. */
		atomic?: boolean;
		/** Create missing parent directories first. Defaults to false. */
		createDirectories?: boolean;
		/** Create the file exclusively. Rejects with EEXIST if the path names any entry, including a dangling link. Combines with atomic to publish the complete file in one step. Defaults to false. */
		exclusive?: boolean;
		/** Permission bits for a created file, before the umask. Defaults to 0o666. An atomic replacement uses existing permission bits when this option is omitted. */
		mode?: number;
	};

	/**
	 * How `append` creates a missing file.
	 *
	 * @see https://maligator.ddv.tools/api/fs#AppendOptions
	 */
	export type AppendOptions = {
		/** Create missing parent directories first. Defaults to false. */
		createDirectories?: boolean;
		/** Permission bits for a created file, before the umask. Defaults to 0o666. */
		mode?: number;
	};

	/**
	 * Byte range and read size for `DiskFile.stream()`.
	 *
	 * @see https://maligator.ddv.tools/api/fs#FileStreamOptions
	 */
	export type FileStreamOptions = {
		/** First byte to read, inclusive. Defaults to 0. */
		start?: number;
		/** Last byte to read, inclusive. Defaults to the end of the file. */
		end?: number;
		/** Maximum bytes per chunk. Defaults to 64 KiB. */
		chunkSize?: number;
	};

	/**
	 * How `DiskFile.writer()` opens its file.
	 *
	 * @see https://maligator.ddv.tools/api/fs#FileWriterOptions
	 */
	export type FileWriterOptions = AppendOptions & {
		/** Append to the existing file. Defaults to false, which truncates it when opened. */
		append?: boolean;
	};

	/**
	 * A sink that opens the file on its first operation and queues operations in call
	 * order. Await a write before reusing its input buffer.
	 *
	 * @see https://maligator.ddv.tools/api/fs#FileWriter
	 */
	export interface FileWriter {
		/** Write a chunk and fulfill with the number of bytes written. */
		write(data: FileData): Promise<number>;
		/** Flush preceding writes to the filesystem with fsync. */
		flush(): Promise<void>;
		/** Close after preceding operations. Repeated calls share the same result. */
		close(): Promise<void>;
		/** Close after preceding operations. */
		end(): Promise<void>;
		[Symbol.asyncDispose](): Promise<void>;
	}

	/**
	 * How `watch()` observes changes.
	 *
	 * @see https://maligator.ddv.tools/api/fs#WatchOptions
	 */
	export type WatchOptions = {
		/** Also watch subdirectories. Defaults to false. */
		recursive?: boolean;
		/** Reject with the signal's reason and close the watcher when it aborts. */
		signal?: AbortSignal;
	};

	/**
	 * A filesystem notification. The OS can coalesce changes and may report a move as
	 * creation or deletion.
	 *
	 * @see https://maligator.ddv.tools/api/fs#FileChange
	 */
	export type FileChange = {
		/** The change reported by the filesystem. */
		kind: "create" | "modify" | "delete" | "rename";
		/** The changed path, including the watched path for a child. */
		path: string;
	};

	/**
	 * How `copyTo` and `moveTo` treat an existing destination.
	 *
	 * @see https://maligator.ddv.tools/api/fs#TransferOptions
	 */
	export type TransferOptions = {
		/** Replace an existing destination. Defaults to false, which rejects with `EEXIST`. */
		overwrite?: boolean;
	};

	/**
	 * Which entry `stat` describes.
	 *
	 * @see https://maligator.ddv.tools/api/fs#StatOptions
	 */
	export type StatOptions = {
		/** Describe the target of a symbolic link instead of the link. Defaults to true. */
		followSymlinks?: boolean;
	};

	/**
	 * Metadata of a filesystem entry.
	 *
	 * @see https://maligator.ddv.tools/api/fs#FileStat
	 */
	export type FileStat = {
		/** The size in bytes. */
		readonly size: number;
		/** The last modification time. */
		readonly mtime: Date;
		readonly isFile: boolean;
		readonly isDirectory: boolean;
		/** True only when `followSymlinks` is false and the path is a link. */
		readonly isSymbolicLink: boolean;
		/** The file type and permission bits, as `st_mode` reports them. */
		readonly mode: number;
	};

	/**
	 * A file on disk. Creating a handle does no I/O; each method reads or changes the
	 * file when called. Failed operations reject with a `FileSystemError`.
	 *
	 * @see https://maligator.ddv.tools/api/fs#DiskFile
	 */
	export interface DiskFile {
		/** The path as given, or the path of a `file:` URL. */
		readonly path: string;
		/** The media type implied by the file extension; text types carry `charset=utf-8`. */
		readonly type: string;
		/** Whether the path resolves, following symbolic links. Never rejects. */
		exists(): Promise<boolean>;
		/** Metadata of the entry; rejects when it is missing. */
		stat(options?: StatOptions): Promise<FileStat>;
		/** The contents as a Uint8Array over a fresh ArrayBuffer. */
		bytes(): Promise<Uint8Array<ArrayBuffer>>;
		/** The contents decoded as UTF-8, without a byte order mark. */
		text(): Promise<string>;
		/** The contents parsed as JSON. */
		json(): Promise<unknown>;
		/** Read a range incrementally. Cancellation closes the file. */
		stream(options?: FileStreamOptions): ReadableStream<Uint8Array<ArrayBuffer>>;
		/** Open a sink for incremental writes. */
		writer(options?: FileWriterOptions): FileWriter;
		/** Replace the contents, creating the file when it is missing. Fulfills with the number of bytes written. */
		write(data: FileData, options?: WriteOptions): Promise<number>;
		/** Add to the end of the file, creating it when it is missing. Fulfills with the number of bytes written. */
		append(data: FileData, options?: AppendOptions): Promise<number>;
		/** Set the permission bits of the entry, following symbolic links. */
		chmod(mode: number): Promise<void>;
		/** Unlink the file or symbolic link. */
		delete(options?: DeleteOptions): Promise<void>;
		/** Copy the contents and permission bits to another path. */
		copyTo(destination: FilePath | DiskFile, options?: TransferOptions): Promise<void>;
		/** Rename the file, copying across file systems. This handle keeps naming the old path. */
		moveTo(destination: FilePath | DiskFile, options?: TransferOptions): Promise<void>;
	}

	/**
	 * Which entries to list. Patterns use `*`, `?` and whole-segment `**` on
	 * slash-separated paths relative to the directory. A pattern can match zero entries.
	 *
	 * @see https://maligator.ddv.tools/api/fs#DirectoryListOptions
	 */
	export type DirectoryListOptions = {
		/** Include paths that match any of these patterns. Defaults to `['**']`. */
		include?: ReadonlyArray<string>;
		/** Leave out paths that match any of these patterns, even when included. */
		exclude?: ReadonlyArray<string>;
		/** Let wildcards match segments starting with a dot. Defaults to false. */
		dot?: boolean;
		/** Visit subdirectories. Defaults to true for `files()` and false for `entries()`. */
		recursive?: boolean;
	};

	/**
	 * An entry returned by `DiskDirectory.entries()`.
	 *
	 * @see https://maligator.ddv.tools/api/fs#DirectoryEntry
	 */
	export type DirectoryEntry = {
		/** The final component of the entry's path. */
		name: string;
		/** A slash-separated path relative to the listed directory. */
		path: string;
		/** The entry's own kind. */
		kind: "file" | "directory" | "symlink" | "other";
	};

	/**
	 * How `DiskDirectory.create()` creates a directory.
	 *
	 * @see https://maligator.ddv.tools/api/fs#CreateDirectoryOptions
	 */
	export type CreateDirectoryOptions = {
		/** Create missing parents and succeed if the directory already exists. Defaults to false. */
		recursive?: boolean;
		/** Permission bits for created directories before the umask. Defaults to 0o777. */
		mode?: number;
	};

	/**
	 * How a delete handles a missing entry.
	 *
	 * @see https://maligator.ddv.tools/api/fs#DeleteOptions
	 */
	export type DeleteOptions = {
		/** Succeed when the path is missing. Defaults to false. */
		missingOk?: boolean;
	};

	/**
	 * How `DiskDirectory.delete()` removes a directory.
	 *
	 * @see https://maligator.ddv.tools/api/fs#DeleteDirectoryOptions
	 */
	export type DeleteDirectoryOptions = DeleteOptions & {
		/** Remove the directory and its contents. Defaults to false. */
		recursive?: boolean;
	};

	/**
	 * Where to create a private temporary directory and how to name it.
	 *
	 * @see https://maligator.ddv.tools/api/fs#TemporaryDirectoryOptions
	 */
	export type TemporaryDirectoryOptions = {
		/** Existing parent directory. Defaults to the system temporary directory. */
		parent?: FilePath;
		/** Prefix for the unique directory name, without slashes or null bytes. Defaults to maligator-. */
		prefix?: string;
	};

	/**
	 * A directory on disk. Creating a handle does no I/O. Directory walks report
	 * symbolic links as entries and skip descending into them.
	 *
	 * @see https://maligator.ddv.tools/api/fs#DiskDirectory
	 */
	export interface DiskDirectory {
		/** The path as given, or the path of a `file:` URL. */
		readonly path: string;
		/** Whether the path resolves, following symbolic links. */
		exists(): Promise<boolean>;
		/** Metadata of the entry at `path`. */
		stat(options?: StatOptions): Promise<FileStat>;
		/** A lazy file handle at a slash-separated path below the directory. */
		file(relative: string): DiskFile;
		/** A lazy directory handle at a slash-separated path below the directory. */
		directory(relative: string): DiskDirectory;
		/** A handle if the named entry is a regular file, or undefined if absent or another kind. */
		get(relative: string): Promise<DiskFile | undefined>;
		/** Regular files ordered by the code points of their relative paths. Visits subdirectories by default. */
		files(options?: DirectoryListOptions): Promise<Array<DiskFile>>;
		/** Entries ordered by the code points of their relative paths. Lists direct children by default. */
		entries(options?: DirectoryListOptions): Promise<Array<DirectoryEntry>>;
		/** Create the directory. A non-recursive create rejects if the path already exists. */
		create(options?: CreateDirectoryOptions): Promise<void>;
		/** Set the permission bits of the entry, following symbolic links. */
		chmod(mode: number): Promise<void>;
		/** Remove the directory. A non-recursive delete requires an empty directory. */
		delete(options?: DeleteDirectoryOptions): Promise<void>;
		/** Rename the directory in one operation on the same file system. This handle keeps naming the old path. */
		moveTo(
			destination: FilePath | DiskDirectory,
			options?: TransferOptions,
		): Promise<void>;
	}

	/**
	 * A failed filesystem operation. The message reads like Node's: the code, a
	 * description, the system call and the paths.
	 *
	 * @see https://maligator.ddv.tools/api/fs#FileSystemError.type
	 */
	export interface FileSystemError extends Error {
		/** The error name, such as `ENOENT` or `EACCES`. */
		readonly code: string;
		/** The system call that failed, such as `open` or `rename`. */
		readonly syscall: string;
		/** The path the call failed on. */
		readonly path: string;
		/** The second path of a failed copy, move or symlink. */
		readonly destination?: string;
	}

	/**
	 * A handle for the file at `path`. It does no I/O, so the file need not exist yet.
	 * Throws a TypeError for an empty path, a path with a null byte or a URL that is not
	 * a `file:` URL.
	 *
	 * @example
	 * import { file } from "maligator:fs";
	 *
	 * const settings = file("settings.json");
	 * if (await settings.exists()) console.log(await settings.json());
	 * await file("out/report.txt").write("done\n", { atomic: true, createDirectories: true });
	 *
	 * @see https://maligator.ddv.tools/api/fs#file
	 */
	export const file: (path: FilePath) => DiskFile;
	/**
	 * A handle for the directory at `path`. It does no I/O, so the directory need not
	 * exist yet. Throws a TypeError for an empty path, a path with a null byte or a URL
	 * that is not a `file:` URL.
	 *
	 * @example
	 * import { directory } from "maligator:fs";
	 *
	 * const reports = directory("out/reports");
	 * await reports.create({ recursive: true });
	 * await reports.file("latest.txt").write("done\n");
	 * for (const report of await reports.files({ include: ["*.txt"] })) console.log(report.path);
	 *
	 * @see https://maligator.ddv.tools/api/fs#directory
	 */
	export const directory: (path: FilePath) => DiskDirectory;
	/**
	 * Return the absolute path of an existing entry after resolving symbolic links.
	 *
	 * @see https://maligator.ddv.tools/api/fs#realpath
	 */
	export const realpath: (path: FilePath) => Promise<string>;
	/**
	 * Read the target stored in a symbolic link, keeping relative targets relative.
	 *
	 * @see https://maligator.ddv.tools/api/fs#readlink
	 */
	export const readlink: (path: FilePath) => Promise<string>;
	/**
	 * Create a symbolic link to `target`. A relative target resolves from the link's
	 * parent. The target can be missing.
	 *
	 * @see https://maligator.ddv.tools/api/fs#symlink
	 */
	export const symlink: (target: string, link: FilePath) => Promise<void>;
	/**
	 * Create a directory accessible only by its owner and return its absolute handle.
	 * Call `delete()` when done.
	 *
	 * @example
	 * import { temporaryDirectory } from "maligator:fs";
	 *
	 * const scratch = await temporaryDirectory({ prefix: "report-" });
	 * try {
	 *   await scratch.file("report.txt").write("done");
	 * } finally {
	 *   await scratch.delete({ recursive: true, missingOk: true });
	 * }
	 *
	 * @see https://maligator.ddv.tools/api/fs#temporaryDirectory
	 */
	export const temporaryDirectory: (
		options?: TemporaryDirectoryOptions,
	) => Promise<DiskDirectory>;
	/**
	 * Watch a file or directory using an async iterator. The first `next()` starts the
	 * watch. Breaking out of the loop, calling `return()`, or aborting the signal closes
	 * it.
	 *
	 * @example
	 * import { watch } from "maligator:fs";
	 *
	 * for await (const change of watch("inbox", { recursive: true })) {
	 *   console.log(change.kind, change.path);
	 *   if (change.kind === "create") break;
	 * }
	 *
	 * @see https://maligator.ddv.tools/api/fs#watch
	 */
	export const watch: (
		path: FilePath,
		options?: WatchOptions,
	) => AsyncIterableIterator<FileChange>;
	/**
	 * The class of every rejection a failed filesystem operation causes.
	 *
	 * @example
	 * import { file, FileSystemError } from "maligator:fs";
	 *
	 * try {
	 *   console.log(await file("notes.txt").text());
	 * } catch (error) {
	 *   if (!(error instanceof FileSystemError) || error.code !== "ENOENT") throw error;
	 *   console.log("no notes yet");
	 * }
	 *
	 * @see https://maligator.ddv.tools/api/fs#FileSystemError
	 */
	export const FileSystemError: {
		new (
			message: string,
			options: { code: string; syscall: string; path: string; destination?: string },
		): FileSystemError;
		readonly prototype: FileSystemError;
	};
}
