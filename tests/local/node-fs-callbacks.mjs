import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mal-fs-callbacks-")));
const at = (...parts) => path.join(root, ...parts);
const relative = (value) =>
	typeof value === "string" ? value.replaceAll(root, "<root>") : value;

function describe(value) {
	if (value instanceof Error) {
		return `${value.code} ${value.errno} ${value.syscall} ${relative(value.path)} ${relative(value.dest)}`;
	}
	if (Buffer.isBuffer(value)) {
		const text = value.toString().replace(/\0+$/, "");
		const size = text.includes(root) ? "" : `${value.length} `;
		return `<Buffer ${size}${JSON.stringify(relative(text))}>`;
	}
	if (value instanceof fs.Stats) {
		if (value.isFile()) return `<Stats file ${value.size}>`;
		return `<Stats ${value.isDirectory() ? "directory" : value.isSymbolicLink() ? "link" : "other"}>`;
	}
	return JSON.stringify(relative(value)) ?? String(value);
}

function call(name, operation, ...args) {
	return new Promise((resolve) => {
		operation(...args, (...results) => {
			console.log(name, results.length, results.map(describe).join(" "));
			resolve(results);
		});
	});
}

function throws(name, operation) {
	try {
		operation();
		console.log(name, "returned");
	} catch (error) {
		console.log(name, "throws", error.code);
	}
}

function sync(name, operation) {
	try {
		console.log(name, describe(operation()));
	} catch (error) {
		console.log(name, "throws", describe(error));
	}
}

const file = at("file.txt");
const missing = at("missing");

await new Promise((resolve) => {
	const events = ["sync"];
	fs.writeFile(file, "hello world", (error) => {
		events.push(`callback ${error}`);
		console.log("order", events.join(", "));
		resolve();
	});
	Promise.resolve().then(() => events.push("microtask"));
});

await call("appendFile", fs.appendFile, file, "!", "utf8");
console.log("contents", fs.readFileSync(file, "utf8"));
await call("appendFile missing", fs.appendFile, at("missing", "child"), "x");
await call("writeFile exclusive", fs.writeFile, file, "x", { flag: "wx" });

const fd = await new Promise((resolve) =>
	fs.open(file, (...results) => {
		console.log("open", results.length, results[0], typeof results[1]);
		resolve(results[1]);
	}),
);
const buffer = Buffer.alloc(8);
await call("read positional", fs.read, fd, buffer, 0, 5, 0);
await call("read options", fs.read, fd, { buffer: Buffer.alloc(3), position: 6 });
await call("read buffer options", fs.read, fd, Buffer.alloc(4), {
	position: 2,
	length: 3,
});
const [, defaultCount, defaultBuffer] = await call("read default", fs.read, fd);
console.log(
	"default buffer",
	defaultBuffer.length,
	defaultBuffer.subarray(0, defaultCount).toString(),
);
await call("fstat", fs.fstat, fd);
await call("fchmod", fs.fchmod, fd, 0o640);
console.log("fchmod mode", (fs.statSync(file).mode & 0o777).toString(8));
await call("futimes", fs.futimes, fd, 3, 4);
console.log("futimes mtime", fs.statSync(file).mtimeMs);
await call("close", fs.close, fd);
await call("close closed", fs.close, fd);
await call("fstat closed", fs.fstat, fd);
await call("open missing", fs.open, missing, "r");
await call("open exclusive", fs.open, file, "wx", 0o644);

fs.symlinkSync(file, at("link"));
await call("lstat", fs.lstat, file);
await call("lstat link", fs.lstat, at("link"), { bigint: false });
await call("lstat missing", fs.lstat, missing);
await call("realpath", fs.realpath, at("link"));
await call("realpath buffer", fs.realpath, at("link"), "buffer");
await call("realpath missing", fs.realpath, at("missing", "child"));
await call("realpath.native", fs.realpath.native, at("link"));
await call("realpath.native missing", fs.realpath.native, missing);

await call("mkdir", fs.mkdir, at("dir"));
await call("mkdir existing", fs.mkdir, at("dir"));
await call("mkdir recursive", fs.mkdir, at("a", "b", "c"), { recursive: true });
await call("mkdir recursive existing", fs.mkdir, at("a", "b"), { recursive: true });
await call("mkdir mode", fs.mkdir, at("mode"), 0o700);
console.log("mkdir mode", (fs.statSync(at("mode")).mode & 0o777).toString(8));
sync("mkdirSync recursive", () => fs.mkdirSync(at("s", "t"), { recursive: true }));

await call("copyFile", fs.copyFile, file, at("copy.txt"));
console.log("copy", fs.readFileSync(at("copy.txt"), "utf8"));
await call("copyFile missing", fs.copyFile, missing, at("copy2.txt"));
await call(
	"copyFile exclusive",
	fs.copyFile,
	file,
	at("copy.txt"),
	fs.constants.COPYFILE_EXCL,
);

const copied = at("modes.txt");
for (const mode of [0.5, -0.5, NaN, Infinity, -1, 8, 2 ** 32, "1", null]) {
	try {
		fs.copyFileSync(file, copied, mode);
		console.log("copyFileSync mode", String(mode), "copied");
	} catch (error) {
		console.log("copyFileSync mode", String(mode), error.name, error.code, error.message);
	}
}
for (const name of ["COPYFILE_EXCL", "COPYFILE_FICLONE", "COPYFILE_FICLONE_FORCE"]) {
	try {
		fs.copyFileSync(file, copied, fs.constants[name]);
		console.log("copyFileSync", name, fs.readFileSync(copied, "utf8"));
	} catch (error) {
		console.log(
			"copyFileSync",
			name,
			"throws",
			describe(error),
			"dest kept",
			fs.existsSync(copied),
		);
	}
}
await fs.promises.copyFile(file, copied);
for (const mode of [fs.constants.COPYFILE_EXCL, 9, "x"]) {
	await fs.promises.copyFile(file, copied, mode).then(
		() => console.log("promises copyFile", String(mode), "copied"),
		(error) =>
			console.log(
				"promises copyFile",
				String(mode),
				"rejects",
				error.code,
				describe(error),
			),
	);
}

await call("chmod", fs.chmod, file, 0o600);
await call("chmod string", fs.chmod, at("copy.txt"), "644");
console.log(
	"chmod modes",
	(fs.statSync(file).mode & 0o777).toString(8),
	(fs.statSync(at("copy.txt")).mode & 0o777).toString(8),
);
await call("chmod missing", fs.chmod, missing, 0o600);

await call("utimes", fs.utimes, file, 1000, new Date(2_000_000));
console.log("utimes", fs.statSync(file).atimeMs, fs.statSync(file).mtimeMs);
await call("utimes missing", fs.utimes, missing, 1, 1);
await call("lutimes", fs.lutimes, at("link"), 5, 6);
console.log("lutimes", fs.lstatSync(at("link")).mtimeMs, fs.statSync(file).mtimeMs);

await call("truncate", fs.truncate, file, 4);
console.log("truncated", JSON.stringify(fs.readFileSync(file, "utf8")));
await call("truncate default", fs.truncate, at("copy.txt"));
console.log("truncated default", fs.statSync(at("copy.txt")).size);
await call("truncate missing", fs.truncate, missing, 1);
const truncateFd = fs.openSync(file, "r+");
await call("ftruncate", fs.ftruncate, truncateFd, 2);
fs.closeSync(truncateFd);
console.log("ftruncated", JSON.stringify(fs.readFileSync(file, "utf8")));

const { uid, gid } = fs.statSync(file);
await call("chown", fs.chown, file, uid, gid);
await call("chown keep", fs.chown, file, -1, -1);
await call("lchown", fs.lchown, at("link"), uid, gid);
await call("chown missing", fs.chown, missing, uid, gid);
const ownerFd = fs.openSync(file, "r");
await call("fchown", fs.fchown, ownerFd, uid, gid);
sync("fchownSync", () => fs.fchownSync(ownerFd, uid, gid));
sync("fchmodSync", () => fs.fchmodSync(ownerFd, 0o644));
sync("futimesSync", () => fs.futimesSync(ownerFd, 7, 8));
console.log("futimesSync mtime", fs.statSync(file).mtimeMs);
fs.closeSync(ownerFd);
sync("chownSync", () => fs.chownSync(file, uid, gid));
sync("chownSync missing", () => fs.chownSync(missing, uid, gid));
sync("lchownSync", () => fs.lchownSync(at("link"), uid, gid));
sync("lutimesSync", () => fs.lutimesSync(at("link"), 9, 10));
console.log("lutimesSync mtime", fs.lstatSync(at("link")).mtimeMs);
sync("truncateSync", () => fs.truncateSync(file, 1));
console.log("truncateSync size", fs.statSync(file).size);
sync("truncateSync missing", () => fs.truncateSync(missing));
sync("fchmodSync closed", () => fs.fchmodSync(ownerFd, 0o644));

await new Promise((resolve) =>
	fs.exists(file, (...results) => {
		console.log("exists", results.length, results[0]);
		resolve();
	}),
);
await new Promise((resolve) =>
	fs.exists(missing, (...results) => {
		console.log("exists missing", results.length, results[0]);
		resolve();
	}),
);

await call("rmdir", fs.rmdir, at("dir"));
await call("rmdir missing", fs.rmdir, missing);
await call("rmdir not empty", fs.rmdir, at("a"));
await call("rm", fs.rm, at("copy.txt"));
await call("rm missing", fs.rm, missing);
await call("rm missing force", fs.rm, missing, { force: true });
await call("rm directory", fs.rm, at("a"));
await call("rm recursive", fs.rm, at("a"), { recursive: true });
console.log("rm recursive exists", fs.existsSync(at("a")));

throws("open without callback", () => fs.open(file, "r"));
throws("mkdir without callback", () => fs.mkdir(at("never")));
throws("read invalid buffer", () => fs.read(0, "text", 0, 1, 0, () => {}));
throws("chown invalid uid", () => fs.chown(file, "0", 0, () => {}));
throws("copyFile invalid mode", () => fs.copyFile(file, at("never"), 8, () => {}));
throws("mkdir invalid recursive", () =>
	fs.mkdir(at("never"), { recursive: 1 }, () => {}),
);

console.log(
	"lengths",
	[
		"open",
		"close",
		"read",
		"lstat",
		"fstat",
		"realpath",
		"mkdir",
		"writeFile",
		"appendFile",
		"copyFile",
		"copyFileSync",
		"rm",
		"rmdir",
		"chmod",
		"fchmod",
		"utimes",
		"futimes",
		"lutimes",
		"truncate",
		"ftruncate",
		"chown",
		"fchown",
		"lchown",
		"exists",
		"mkdirSync",
		"realpathSync",
		"fchmodSync",
		"chownSync",
		"fchownSync",
		"lchownSync",
		"truncateSync",
		"futimesSync",
		"lutimesSync",
	]
		.map((name) => `${name}=${fs[name].length}`)
		.join(" "),
);
console.log("promises copyFile length", fs.promises.copyFile.length);
console.log("realpath.native", fs.realpath.native.length, fs.realpathSync.native.length);

fs.rmSync(root, { recursive: true, force: true });
