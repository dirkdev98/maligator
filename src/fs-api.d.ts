// Generated from src/platform/catalog.ts; edit the catalog and regenerate.
/**
 * Read and write files through lazy handles. No surface flag is required. Every
 * operation is asynchronous and runs on the blocking-work pool, so the event loop
 * keeps running while a file is read or written.
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
		/** Permission bits for a created file, before the umask. Defaults to 0o666; an atomic write keeps the bits of the file it replaces. */
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
		/** Replace the contents, creating the file when it is missing. Fulfills with the number of bytes written. */
		write(data: FileData, options?: WriteOptions): Promise<number>;
		/** Add to the end of the file, creating it when it is missing. Fulfills with the number of bytes written. */
		append(data: FileData, options?: AppendOptions): Promise<number>;
		/** Remove the file; rejects when it is missing or a directory. */
		delete(): Promise<void>;
		/** Copy the contents and permission bits to another path. */
		copyTo(destination: FilePath | DiskFile, options?: TransferOptions): Promise<void>;
		/** Rename the file, copying across file systems. This handle keeps naming the old path. */
		moveTo(destination: FilePath | DiskFile, options?: TransferOptions): Promise<void>;
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
		/** The destination of a failed copy or move. */
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
