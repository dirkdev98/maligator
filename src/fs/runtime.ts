import type {
	AppendOptions,
	CreateDirectoryOptions,
	DeleteDirectoryOptions,
	DirectoryEntry,
	DirectoryListOptions,
	DiskDirectory,
	DiskFile,
	FileData,
	FilePath,
	FileStat,
	StatOptions,
	TransferOptions,
	WriteOptions,
} from "maligator:fs";
import {
	copy,
	createDirectory,
	exists,
	list,
	mediaType,
	move,
	read,
	remove,
	removeDirectory,
	stat,
	write,
} from "maligator:internal/fs";

// The bits maligator_fs.c reads.
const APPEND = 1;
const ATOMIC = 2;
const CREATE_DIRECTORIES = 4;

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
function failed(failure: unknown): never {
	if (!isNativeFailure(failure)) throw failure;
	const { code, description, syscall, path, destination } = failure;
	const paths = destination === undefined ? `'${path}'` : `'${path}' -> '${destination}'`;
	throw new FileSystemError(`${code}: ${description}, ${syscall} ${paths}`, {
		code,
		syscall,
		path,
		...(destination === undefined ? {} : { destination }),
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
		return failed(failure);
	}
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

	write(data: FileData, options?: WriteOptions): Promise<number> {
		return settle(() => {
			const { atomic, createDirectories, mode } = optionsObject(options, "write");
			const flags =
				(atomic === true ? ATOMIC : 0) |
				(createDirectories === true ? CREATE_DIRECTORIES : 0);
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

	delete(): Promise<void> {
		return settle(() => remove(this.path));
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
			return move(this.path, toPath(destination), overwrite === true);
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
	const length = value.length;
	for (let index = 0; index < length; index++) {
		const pattern: unknown = value[index];
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

	delete(options?: DeleteDirectoryOptions): Promise<void> {
		return settle(() => {
			const { recursive } = optionsObject(options, "delete");
			return removeDirectory(this.path, recursive === true);
		});
	}
}

export function file(path: FilePath): DiskFile {
	return new DiskFileHandle(toPath(path));
}

export function directory(path: FilePath): DiskDirectory {
	return new DiskDirectoryHandle(toPath(path, "directory()"));
}
