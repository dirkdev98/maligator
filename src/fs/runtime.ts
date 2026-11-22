import type {
	AppendOptions,
	CreateDirectoryOptions,
	DeleteDirectoryOptions,
	DeleteOptions,
	DirectoryEntry,
	DirectoryListOptions,
	DiskDirectory,
	DiskFile,
	FileChange,
	FileData,
	FilePath,
	FileStat,
	FileStreamOptions,
	FileWriter,
	FileWriterOptions,
	StatOptions,
	TemporaryDirectoryOptions,
	TransferOptions,
	WatchOptions,
	WriteOptions,
} from "maligator:fs";
import {
	chmod,
	copy,
	createDirectory,
	exists,
	list,
	mediaType,
	move,
	read,
	readlink as readLink,
	realpath as resolvePath,
	remove,
	removeDirectory,
	stat,
	symlink as createLink,
	temporaryDirectory as createTemporaryDirectory,
	write,
} from "maligator:internal/fs";
import {
	closeDescriptor,
	flushDescriptor,
	openDescriptor,
	readChunk,
	writeChunk,
} from "maligator:internal/fs-descriptor";
import type { Descriptor } from "maligator:internal/fs-descriptor";
import { readableStream } from "maligator:internal/fs-stream";
import { closeWatch, openWatch } from "maligator:internal/fs-watch";
import type { WatchListener } from "maligator:internal/fs-watch";

// The bits maligator_fs.c reads.
const APPEND = 1;
const ATOMIC = 2;
const CREATE_DIRECTORIES = 4;
const EXCLUSIVE = 8;

// MalPosixFileType codes.
const TYPE_FILE = 1;
const TYPE_DIRECTORY = 2;
const TYPE_SYMLINK = 3;

interface ErrorFields {
	code: string;
	syscall: string;
	path: string;
	destination?: string;
}

export class FileSystemError extends Error {
	readonly code: string;
	readonly syscall: string;
	readonly path: string;
	readonly destination?: string;

	constructor(message: string, options: ErrorFields) {
		super(message);
		this.name = "FileSystemError";
		this.code = options.code;
		this.syscall = options.syscall;
		this.path = options.path;
		if (options.destination !== undefined) this.destination = options.destination;
	}
}

interface NativeFailure extends ErrorFields {
	description: string;
}

function isNativeFailure(value: unknown): value is NativeFailure {
	return (
		typeof value === "object" &&
		value !== null &&
		!(value instanceof Error) &&
		typeof (value as { code?: unknown }).code === "string"
	);
}

// Native operations reject with a plain description of the system error. Anything
// else, such as a TypeError for data a write cannot take, passes through.
function fileSystemFailure(failure: unknown): unknown {
	if (!isNativeFailure(failure)) return failure;
	const { code, description, syscall, path, destination } = failure;
	const paths = destination === undefined ? `'${path}'` : `'${path}' -> '${destination}'`;
	return new FileSystemError(`${code}: ${description}, ${syscall} ${paths}`, {
		code,
		syscall,
		path,
		destination,
	});
}

// fileURLToPath's POSIX rules, without reaching the URL class: a program that never
// passes a URL must not link it.
function urlPath(
	url: { protocol: string; hostname: string; pathname: string },
	handle: string,
): string {
	if (url.protocol !== "file:") throw new TypeError(`${handle} takes a file: URL`);
	if (url.hostname !== "" && url.hostname !== "localhost")
		throw new TypeError(`${handle} takes a file: URL without a host`);
	if (url.pathname.toLowerCase().includes("%2f"))
		throw new TypeError(`${handle} takes a file: URL without encoded slashes`);
	return decodeURIComponent(url.pathname);
}

function isUrl(
	value: unknown,
): value is { protocol: string; hostname: string; pathname: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { protocol?: unknown }).protocol === "string" &&
		typeof (value as { pathname?: unknown }).pathname === "string"
	);
}

function toPath(value: unknown, handle = "file()"): string {
	const path =
		typeof value === "string"
			? value
			: value instanceof DiskFileHandle
				? value.path
				: isUrl(value)
					? urlPath(value, handle)
					: undefined;
	if (path === undefined) throw new TypeError("path must be a string or a file: URL");
	if (path === "") throw new TypeError("path must not be empty");
	if (path.includes("\0")) throw new TypeError("path must not contain null bytes");
	return path;
}

function optionsObject<T extends object>(options: T | undefined, method: string): T {
	if (options === undefined) return {} as T;
	if (typeof options !== "object" || options === null)
		throw new TypeError(`${method} options must be an object`);
	return options;
}

function permissionMode(mode: unknown, method: string): number | undefined {
	if (mode === undefined) return undefined;
	if (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0 || mode > 0o7777)
		throw new TypeError(`${method} option 'mode' must be an integer from 0 to 0o7777`);
	return mode;
}

function changePermissions(path: string, mode: number): Promise<void> {
	return settle(() => {
		const permissions = permissionMode(mode, "chmod");
		if (permissions === undefined) throw new TypeError("chmod requires a mode");
		return chmod(path, permissions);
	});
}

function fileStat(entry: {
	type: number;
	size: number;
	mtimeMs: number;
	mode: number;
}): FileStat {
	return Object.freeze({
		size: entry.size,
		mtime: new Date(entry.mtimeMs),
		isFile: entry.type === TYPE_FILE,
		isDirectory: entry.type === TYPE_DIRECTORY,
		isSymbolicLink: entry.type === TYPE_SYMLINK,
		mode: entry.mode,
	});
}

function statPath(path: string, options: StatOptions | undefined): Promise<FileStat> {
	const { followSymlinks } = optionsObject(options, "stat");
	return stat(path, followSymlinks !== false).then(fileStat);
}

// Every method settles through here, so invalid arguments reject rather than throw and a
// native rejection becomes a FileSystemError.
async function settle<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (failure) {
		throw fileSystemFailure(failure);
	}
}

function byteOffset(
	value: number,
	option: string,
	minimum: number,
	maximum: number,
): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new RangeError(
			`stream option '${option}' must be an integer from ${minimum} to ${maximum}`,
		);
	}
	return value;
}

function fileStream(
	path: string,
	options?: FileStreamOptions,
): ReadableStream<Uint8Array<ArrayBuffer>> {
	const { start = 0, end, chunkSize = 64 * 1024 } = optionsObject(options, "stream");
	let offset = byteOffset(start, "start", 0, Number.MAX_SAFE_INTEGER);
	if (end !== undefined) byteOffset(end, "end", offset, Number.MAX_SAFE_INTEGER);
	const size = byteOffset(chunkSize, "chunkSize", 1, 0xffff_ffff);
	let opening: Promise<Descriptor> | undefined;
	let reading: Promise<Uint8Array<ArrayBuffer> | undefined> | undefined;
	let closing: Promise<void> | undefined;
	let cancelled = false;

	const close = () =>
		(closing ??= settle(async () => {
			// The active read owns the descriptor until its worker stops using it.
			await reading?.catch(() => undefined);
			const descriptor = await opening?.catch(() => undefined);
			if (descriptor !== undefined) await closeDescriptor(path, descriptor);
		}));

	return readableStream(
		{
			async pull(controller) {
				try {
					const descriptor = await (opening ??= openDescriptor(
						path,
						0,
						false,
						undefined,
					));
					if (cancelled) return;
					const length = end === undefined ? size : Math.min(size, end - offset + 1);
					const chunk = await (reading = readChunk(path, descriptor, offset, length));
					reading = undefined;
					if (cancelled) return;
					if (chunk !== undefined) offset += chunk.byteLength;
					const done = chunk === undefined || (end !== undefined && offset > end);
					if (done) await close();
					if (cancelled) return;
					if (chunk !== undefined) controller.enqueue(chunk);
					if (done) controller.close();
				} catch (failure) {
					await close().catch(() => undefined);
					if (!cancelled) throw fileSystemFailure(failure);
				}
			},
			cancel() {
				cancelled = true;
				return close();
			},
		},
		{ highWaterMark: 0 },
	);
}

function fileWriter(path: string, options?: FileWriterOptions): FileWriter {
	const { append, createDirectories, mode } = optionsObject(options, "writer");
	const permissions = permissionMode(mode, "writer");
	let opening: Promise<Descriptor> | undefined;
	let tail = Promise.resolve();
	let closing: Promise<void> | undefined;

	const enqueue = <T>(operation: (descriptor: Descriptor) => Promise<T>): Promise<T> => {
		const result = tail.then(() =>
			settle(async () => {
				const descriptor = await (opening ??= openDescriptor(
					path,
					append === true ? 2 : 1,
					createDirectories === true,
					permissions,
				));
				return operation(descriptor);
			}),
		);
		tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	const close = () =>
		(closing ??= enqueue((descriptor) => closeDescriptor(path, descriptor)));
	const write = (data: FileData) =>
		closing === undefined
			? enqueue((descriptor) => writeChunk(path, descriptor, data))
			: Promise.reject(new TypeError("File writer is closed"));
	const flush = () =>
		closing === undefined
			? enqueue((descriptor) => flushDescriptor(path, descriptor))
			: Promise.reject(new TypeError("File writer is closed"));

	return { write, flush, close, end: close, [Symbol.asyncDispose]: close };
}

class DiskFileHandle implements DiskFile {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
		Object.freeze(this);
	}

	get type(): string {
		return mediaType(this.path);
	}

	exists(): Promise<boolean> {
		return settle(() => exists(this.path));
	}

	stat(options?: StatOptions): Promise<FileStat> {
		return settle(() => statPath(this.path, options));
	}

	bytes(): Promise<Uint8Array<ArrayBuffer>> {
		return settle(() => read(this.path, false));
	}

	text(): Promise<string> {
		return settle(() => read(this.path, true));
	}

	json(): Promise<unknown> {
		return this.text().then((text) => JSON.parse(text) as unknown);
	}

	stream(options?: FileStreamOptions): ReadableStream<Uint8Array<ArrayBuffer>> {
		return fileStream(this.path, options);
	}

	writer(options?: FileWriterOptions): FileWriter {
		return fileWriter(this.path, options);
	}

	write(data: FileData, options?: WriteOptions): Promise<number> {
		return settle(() => {
			const { atomic, createDirectories, exclusive, mode } = optionsObject(
				options,
				"write",
			);
			const flags =
				(atomic === true ? ATOMIC : 0) |
				(createDirectories === true ? CREATE_DIRECTORIES : 0) |
				(exclusive === true ? EXCLUSIVE : 0);
			return write(this.path, data, flags, permissionMode(mode, "write"));
		});
	}

	append(data: FileData, options?: AppendOptions): Promise<number> {
		return settle(() => {
			const { createDirectories, mode } = optionsObject(options, "append");
			const flags = APPEND | (createDirectories === true ? CREATE_DIRECTORIES : 0);
			return write(this.path, data, flags, permissionMode(mode, "append"));
		});
	}

	chmod(mode: number): Promise<void> {
		return changePermissions(this.path, mode);
	}

	delete(options?: DeleteOptions): Promise<void> {
		return settle(() => {
			const { missingOk } = optionsObject(options, "delete");
			return remove(this.path, missingOk === true);
		});
	}

	copyTo(destination: FilePath | DiskFile, options?: TransferOptions): Promise<void> {
		return settle(() => {
			const { overwrite } = optionsObject(options, "copyTo");
			return copy(this.path, toPath(destination), overwrite === true);
		});
	}

	moveTo(destination: FilePath | DiskFile, options?: TransferOptions): Promise<void> {
		return settle(() => {
			const { overwrite } = optionsObject(options, "moveTo");
			return move(this.path, toPath(destination), overwrite === true, false);
		});
	}
}

function validRelativePath(path: unknown): path is string {
	return (
		typeof path === "string" &&
		!path.includes("\\") &&
		!path.includes("\0") &&
		path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
	);
}

function joinPath(base: string, relative: string): string {
	return base.endsWith("/") ? base + relative : `${base}/${relative}`;
}

function childPath(base: string, relative: string): string {
	if (!validRelativePath(relative))
		throw new TypeError("child path must be a slash-separated path below the directory");
	return joinPath(base, relative);
}

function patterns(value: ReadonlyArray<string> | undefined, option: string) {
	if (value === undefined) return undefined;
	if (!Array.isArray(value))
		throw new TypeError(`${option} must be an array of patterns`);
	const checked: Array<string> = [];
	for (const pattern of value as ReadonlyArray<unknown>) {
		if (!validRelativePath(pattern))
			throw new TypeError(`${option} patterns must be slash-separated relative paths`);
		checked.push(pattern);
	}
	return checked;
}

function entryKind(type: number): DirectoryEntry["kind"] {
	switch (type) {
		case TYPE_FILE:
			return "file";
		case TYPE_DIRECTORY:
			return "directory";
		case TYPE_SYMLINK:
			return "symlink";
		default:
			return "other";
	}
}

class DiskDirectoryHandle implements DiskDirectory {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
		Object.freeze(this);
	}

	exists(): Promise<boolean> {
		return settle(() => exists(this.path));
	}

	stat(options?: StatOptions): Promise<FileStat> {
		return settle(() => statPath(this.path, options));
	}

	file(relative: string): DiskFile {
		return new DiskFileHandle(childPath(this.path, relative));
	}

	directory(relative: string): DiskDirectory {
		return new DiskDirectoryHandle(childPath(this.path, relative));
	}

	get(relative: string): Promise<DiskFile | undefined> {
		return settle(async () => {
			const handle = this.file(relative);
			let entry;
			try {
				entry = await stat(handle.path, false);
			} catch (failure) {
				if (
					isNativeFailure(failure) &&
					(failure.code === "ENOENT" || failure.code === "ENOTDIR")
				)
					return undefined;
				throw failure;
			}
			return entry.type === TYPE_FILE ? handle : undefined;
		});
	}

	files(options?: DirectoryListOptions): Promise<Array<DiskFile>> {
		return settle(async () => {
			const { recursive, include, exclude, dot } = optionsObject(options, "files");
			const paths = await list(
				this.path,
				recursive !== false,
				true,
				dot === true,
				patterns(include, "include"),
				patterns(exclude, "exclude"),
			);
			return paths.map((path) => new DiskFileHandle(joinPath(this.path, path)));
		});
	}

	entries(options?: DirectoryListOptions): Promise<Array<DirectoryEntry>> {
		return settle(async () => {
			const { recursive, include, exclude, dot } = optionsObject(options, "entries");
			const entries = await list(
				this.path,
				recursive === true,
				false,
				dot === true,
				patterns(include, "include"),
				patterns(exclude, "exclude"),
			);
			return entries.map(({ path, type }) => ({
				name: path.slice(path.lastIndexOf("/") + 1),
				path,
				kind: entryKind(type),
			}));
		});
	}

	create(options?: CreateDirectoryOptions): Promise<void> {
		return settle(() => {
			const { recursive, mode } = optionsObject(options, "create");
			return createDirectory(
				this.path,
				recursive === true,
				permissionMode(mode, "create"),
			);
		});
	}

	chmod(mode: number): Promise<void> {
		return changePermissions(this.path, mode);
	}

	delete(options?: DeleteDirectoryOptions): Promise<void> {
		return settle(() => {
			const { recursive, missingOk } = optionsObject(options, "delete");
			return removeDirectory(this.path, recursive === true, missingOk === true);
		});
	}

	moveTo(
		destination: FilePath | DiskDirectory,
		options?: TransferOptions,
	): Promise<void> {
		return settle(() => {
			const { overwrite } = optionsObject(options, "moveTo");
			const target =
				destination instanceof DiskDirectoryHandle
					? destination.path
					: toPath(destination);
			return move(this.path, target, overwrite === true, true);
		});
	}
}

export function file(path: FilePath): DiskFile {
	return new DiskFileHandle(toPath(path));
}

export function directory(path: FilePath): DiskDirectory {
	return new DiskDirectoryHandle(toPath(path, "directory()"));
}

export function realpath(path: FilePath): Promise<string> {
	return settle(() => resolvePath(toPath(path, "realpath()")));
}

export function readlink(path: FilePath): Promise<string> {
	return settle(() => readLink(toPath(path, "readlink()")));
}

export function symlink(target: string, link: FilePath): Promise<void> {
	return settle(() => {
		if (typeof target !== "string")
			throw new TypeError("symlink target must be a string");
		return createLink(toPath(target), toPath(link, "symlink()"));
	});
}

export function temporaryDirectory(
	options?: TemporaryDirectoryOptions,
): Promise<DiskDirectory> {
	return settle(async () => {
		const { parent, prefix = "maligator-" } = optionsObject(
			options,
			"temporaryDirectory",
		);
		if (typeof prefix !== "string" || prefix.includes("/") || prefix.includes("\0"))
			throw new TypeError(
				"temporaryDirectory prefix must be a string without slashes or null bytes",
			);
		const parentPath =
			parent === undefined ? undefined : toPath(parent, "temporaryDirectory()");
		return new DiskDirectoryHandle(await createTemporaryDirectory(parentPath, prefix));
	});
}

type WatchResult = IteratorResult<FileChange, undefined>;

export function watch(
	path: FilePath,
	options?: WatchOptions,
): AsyncIterableIterator<FileChange> {
	const queued: Array<FileChange> = [];
	const waiters: Array<{
		resolve: (result: WatchResult) => void;
		reject: (failure: unknown) => void;
	}> = [];
	let watching = false;
	let closed = false;
	let signal: AbortSignal | undefined;
	let watchedPath: string;
	let terminal: { failure: unknown } | undefined;
	const done = (): WatchResult => ({ done: true, value: undefined });

	const finish = (completion?: { failure: unknown }) => {
		if (closed) return;
		closed = true;
		if (watching) {
			closeWatch(listener);
			signal?.removeEventListener("abort", abort);
		}
		queued.length = 0;
		if (waiters.length === 0) terminal = completion;
		for (const { resolve, reject } of waiters) {
			if (completion === undefined) resolve(done());
			else reject(completion.failure);
		}
		waiters.length = 0;
	};
	const abort = () => finish({ failure: signal?.reason });
	const listener: WatchListener = (kind, relative, failure) => {
		if (closed) return;
		if (kind === "error") {
			finish({ failure: fileSystemFailure(failure) });
			return;
		}
		const change = {
			kind,
			path: relative === "" ? watchedPath : joinPath(watchedPath, relative),
		};
		const waiter = waiters.shift();
		if (waiter !== undefined) waiter.resolve({ done: false, value: change });
		else if (queued.length < 2048) queued.push(change);
		else {
			finish({
				failure: new FileSystemError(
					`EOVERFLOW: watch queue is full, watch '${watchedPath}'`,
					{
						code: "EOVERFLOW",
						syscall: "watch",
						path: watchedPath,
					},
				),
			});
		}
	};

	return {
		async next(): Promise<WatchResult> {
			if (!watching && !closed) {
				try {
					const checked = optionsObject(options, "watch");
					watchedPath = toPath(path, "watch()");
					signal = checked.signal;
					if (
						signal !== undefined &&
						(typeof signal?.addEventListener !== "function" ||
							typeof signal.removeEventListener !== "function")
					) {
						throw new TypeError("watch option 'signal' must be an AbortSignal");
					}
					if (signal?.aborted) {
						abort();
					} else {
						openWatch(watchedPath, checked.recursive === true, listener);
						watching = true;
						signal?.addEventListener("abort", abort, { once: true });
						if (signal?.aborted) abort();
					}
				} catch (failure) {
					finish({ failure: fileSystemFailure(failure) });
				}
			}
			if (terminal !== undefined) {
				const { failure } = terminal;
				terminal = undefined;
				throw failure;
			}
			if (closed) return done();
			const value = queued.shift();
			if (value !== undefined) return { done: false, value };
			return new Promise<WatchResult>((resolve, reject) => {
				waiters.push({ resolve, reject });
			});
		},
		return() {
			finish();
			terminal = undefined;
			return Promise.resolve(done());
		},
		[Symbol.asyncIterator]() {
			return this;
		},
	};
}
