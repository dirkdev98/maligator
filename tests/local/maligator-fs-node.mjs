// The maligator:fs contract over Node's fs/promises, as the reference for the native
// module. Where the contract adds to a Node call (atomic writes, refusing an existing
// destination, EISDIR for unlinking a directory), this does the same steps.
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { scenario } from "./maligator-fs-scenario.mjs";

class FileSystemError extends Error {
	constructor(message, options) {
		super(message);
		this.name = "FileSystemError";
		this.code = options.code;
		this.syscall = options.syscall;
		this.path = options.path;
		if (options.destination !== undefined) this.destination = options.destination;
	}
}

function description(error) {
	return error.message.slice(
		error.code.length + 2,
		error.message.lastIndexOf(`, ${error.syscall}`),
	);
}

function failure(code, text, syscall, filePath, destination) {
	const paths =
		destination === undefined ? `'${filePath}'` : `'${filePath}' -> '${destination}'`;
	return new FileSystemError(`${code}: ${text}, ${syscall} ${paths}`, {
		code,
		syscall,
		path: filePath,
		destination,
	});
}

async function node(operation, filePath, destination) {
	try {
		return await operation();
	} catch (error) {
		if (typeof error?.syscall !== "string") throw error;
		throw failure(error.code, description(error), error.syscall, filePath, destination);
	}
}

const types = { txt: "text/plain; charset=utf-8", json: "application/json" };
let serial = 0;

function toPath(value) {
	if (typeof value === "string") {
		if (value === "" || value.includes("\0")) throw new TypeError("invalid path");
		return value;
	}
	if (value instanceof URL) return fileURLToPath(value);
	if (value?.constructor === Handle) return value.path;
	throw new TypeError("invalid path");
}

async function atomicWrite(target, data, mode) {
	const resolved = await fs.realpath(target).catch(() => target);
	const existing = await fs.stat(resolved).catch(() => undefined);
	const temporary = path.join(
		path.dirname(resolved),
		`.${path.basename(resolved)}.${process.pid}.${serial++}.tmp`,
	);
	await node(
		() => fs.writeFile(temporary, data, { flag: "wx", mode: mode ?? 0o666 }),
		target,
	);
	try {
		if (mode === undefined && existing?.isFile())
			await fs.chmod(temporary, existing.mode & 0o7777);
		await fs.rename(temporary, resolved);
	} catch (error) {
		await fs.unlink(temporary);
		throw failure(error.code, description(error), error.syscall, target);
	}
}

function bytesOf(data) {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data))
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	throw new TypeError("invalid data");
}

function checkMode(mode) {
	if (mode !== undefined && (!Number.isInteger(mode) || mode < 0 || mode > 0o7777))
		throw new TypeError("invalid mode");
}

class Handle {
	constructor(filePath) {
		this.path = filePath;
		Object.freeze(this);
	}
	get type() {
		const dot = this.path.lastIndexOf(".");
		return (dot > 0 && types[this.path.slice(dot + 1)]) || "application/octet-stream";
	}
	exists() {
		return fs.access(this.path).then(
			() => true,
			() => false,
		);
	}
	async stat(options = {}) {
		const entry = await node(
			() => (options.followSymlinks === false ? fs.lstat : fs.stat)(this.path),
			this.path,
		);
		return Object.freeze({
			size: entry.size,
			mtime: entry.mtime,
			isFile: entry.isFile(),
			isDirectory: entry.isDirectory(),
			isSymbolicLink: entry.isSymbolicLink(),
			mode: entry.mode,
		});
	}
	async bytes() {
		return new Uint8Array(await node(() => fs.readFile(this.path), this.path));
	}
	async text() {
		const text = await node(() => fs.readFile(this.path, "utf8"), this.path);
		return text.startsWith("﻿") ? text.slice(1) : text;
	}
	async json() {
		return JSON.parse(await this.text());
	}
	async write(data, options = {}) {
		checkMode(options.mode);
		const bytes = bytesOf(data);
		if (options.createDirectories) {
			const directory = path.dirname(this.path);
			await node(() => fs.mkdir(directory, { recursive: true }), directory);
		}
		if (options.atomic) await atomicWrite(this.path, bytes, options.mode);
		else
			await node(
				() => fs.writeFile(this.path, bytes, { mode: options.mode ?? 0o666 }),
				this.path,
			);
		return Buffer.byteLength(bytes);
	}
	async append(data, options = {}) {
		checkMode(options.mode);
		const bytes = bytesOf(data);
		if (options.createDirectories)
			await fs.mkdir(path.dirname(this.path), { recursive: true });
		await node(
			() => fs.appendFile(this.path, bytes, { mode: options.mode ?? 0o666 }),
			this.path,
		);
		return Buffer.byteLength(bytes);
	}
	async delete() {
		try {
			await fs.unlink(this.path);
		} catch (error) {
			const directory =
				error.code === "EPERM" && (await fs.lstat(this.path)).isDirectory();
			if (directory)
				throw failure("EISDIR", "illegal operation on a directory", "unlink", this.path);
			throw failure(error.code, description(error), error.syscall, this.path);
		}
	}
	async copyTo(destination, options = {}) {
		const target = toPath(destination);
		const mode = options.overwrite ? 0 : constants.COPYFILE_EXCL;
		await node(() => fs.copyFile(this.path, target, mode), this.path, target);
	}
	async moveTo(destination, options = {}) {
		const target = toPath(destination);
		if (options.overwrite) {
			await node(() => fs.rename(this.path, target), this.path, target);
			return;
		}
		// Node has no exclusive rename. Publish a hard link before removing the source.
		try {
			await fs.link(this.path, target);
		} catch (error) {
			throw failure(error.code, description(error), "rename", this.path, target);
		}
		await node(() => fs.unlink(this.path), this.path, target);
	}
}

function file(value) {
	return new Handle(toPath(value));
}

function childPath(base, relative) {
	if (
		typeof relative !== "string" ||
		!relative
			.split("/")
			.every((segment) => segment && segment !== "." && segment !== "..") ||
		/[\\\0]/.test(relative)
	)
		throw new TypeError("invalid relative path");
	return path.join(base, relative);
}

class Directory extends Handle {
	file(relative) {
		return file(childPath(this.path, relative));
	}
	directory(relative) {
		return directory(childPath(this.path, relative));
	}
	async get(relative) {
		const handle = this.file(relative);
		const entry = await fs.lstat(handle.path).catch((error) => {
			if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
		});
		return entry?.isFile() ? handle : undefined;
	}
	async entries({ recursive = false, include, exclude = [], dot = false } = {}) {
		for (const pattern of [...(include ?? []), ...exclude]) childPath(this.path, pattern);
		const rows = [];
		const readDirectory = async (directory) => {
			const children = await node(
				() => fs.readdir(directory, { withFileTypes: true }),
				directory,
			);
			rows.push(...children);
			// A recursive Node readdir can follow directory symlinks.
			if (recursive)
				for (const row of children) {
					if (row.isDirectory()) await readDirectory(path.join(directory, row.name));
				}
		};
		await readDirectory(this.path);
		return rows
			.map((row) => ({
				name: row.name,
				path: path.relative(this.path, path.join(row.parentPath, row.name)),
				kind: row.isFile()
					? "file"
					: row.isDirectory()
						? "directory"
						: row.isSymbolicLink()
							? "symlink"
							: "other",
			}))
			.filter(
				({ path: relative }) =>
					(include === undefined
						? dot || path.matchesGlob(relative, "**")
						: include.some((pattern) => path.matchesGlob(relative, pattern))) &&
					!exclude.some((pattern) => path.matchesGlob(relative, pattern)),
			)
			.sort((left, right) =>
				Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
			);
	}
	async files({ recursive = true, ...options } = {}) {
		return (await this.entries({ recursive, ...options }))
			.filter(({ kind }) => kind === "file")
			.map(({ path: relative }) => this.file(relative));
	}
	async create({ recursive = false, mode } = {}) {
		checkMode(mode);
		await node(() => fs.mkdir(this.path, { recursive, mode }), this.path);
	}
	async delete({ recursive = false } = {}) {
		const target = this.path.replace(/(.)\/+$/, "$1");
		const removeTree = recursive && !["", ".", ".."].includes(path.basename(target));
		if (removeTree && !(await node(() => fs.lstat(target), this.path)).isDirectory())
			throw failure("ENOTDIR", "not a directory", "rmdir", this.path);
		await node(
			() => (removeTree ? fs.rm(target, { recursive: true }) : fs.rmdir(target)),
			this.path,
		);
	}
}

function directory(value) {
	return new Directory(toPath(value));
}

console.log((await scenario({ directory, file, FileSystemError, URL })).join("\n"));
