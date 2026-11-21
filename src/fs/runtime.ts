import type {
	AppendOptions,
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
	exists,
	mediaType,
	move,
	read,
	remove,
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
function urlPath(url: { protocol: string; hostname: string; pathname: string }): string {
	if (url.protocol !== "file:") throw new TypeError("file() takes a file: URL");
	if (url.hostname !== "" && url.hostname !== "localhost")
		throw new TypeError("file() takes a file: URL without a host");
	if (url.pathname.toLowerCase().includes("%2f"))
		throw new TypeError("file() takes a file: URL without encoded slashes");
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

function toPath(value: unknown): string {
	const path =
		typeof value === "string"
			? value
			: value instanceof DiskFileHandle
				? value.path
				: isUrl(value)
					? urlPath(value)
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

function writeMode(mode: unknown, method: string): number | undefined {
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
		return settle(() => {
			const { followSymlinks } = optionsObject(options, "stat");
			return stat(this.path, followSymlinks !== false).then(fileStat);
		});
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
			return write(this.path, data, flags, writeMode(mode, "write"));
		});
	}

	append(data: FileData, options?: AppendOptions): Promise<number> {
		return settle(() => {
			const { createDirectories, mode } = optionsObject(options, "append");
			const flags = APPEND | (createDirectories === true ? CREATE_DIRECTORIES : 0);
			return write(this.path, data, flags, writeMode(mode, "append"));
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

export function file(path: FilePath): DiskFile {
	return new DiskFileHandle(toPath(path));
}
