import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mal-fs-streams-")));
const at = (...parts) => path.join(root, ...parts);
const relative = (value) => String(value).replaceAll(root, "<root>");
const failure = (error) =>
	`${error.code} ${error.syscall ?? ""} ${relative(error.path ?? "")}`.trim();

function vectors() {
	const file = at("vectors.txt");
	const fd = fs.openSync(file, "w+");
	const written = fs.writevSync(fd, [Buffer.from("abc"), Buffer.from("defg")], 0);
	const head = Buffer.alloc(2);
	const tail = Buffer.alloc(3);
	const read = fs.readvSync(fd, [head, tail], 1);
	console.log("writevSync", written, "readvSync", read, head.toString(), tail.toString());
	try {
		fs.writevSync(fd, ["text"]);
	} catch (error) {
		console.log("writevSync invalid", error.code);
	}
	return new Promise((resolve) => {
		fs.writev(
			fd,
			[Buffer.from("XY"), new Uint8Array([90])],
			7,
			(error, bytes, buffers) => {
				console.log("writev", error, bytes, buffers.length);
				const parts = [Buffer.alloc(4), Buffer.alloc(6)];
				fs.readv(fd, parts, 0, (error, bytes, buffers) => {
					console.log(
						"readv",
						error,
						bytes,
						buffers === parts,
						Buffer.concat(buffers).toString(),
					);
					fs.closeSync(fd);
					fs.readv(fd, parts, (error) => {
						console.log("readv closed", error.code, error.syscall);
						resolve();
					});
				});
			},
		);
	});
}

async function directories() {
	fs.mkdirSync(at("dir", "child"), { recursive: true });
	fs.writeFileSync(at("dir", "a.txt"), "a");
	const dir = fs.opendirSync(at("dir"));
	console.log("opendirSync", dir instanceof fs.Dir, relative(dir.path));
	const names = [];
	for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
		names.push(
			`${entry.name}:${entry.isDirectory()}:${entry instanceof fs.Dirent}:${relative(entry.parentPath)}`,
		);
	}
	console.log("readSync", names.sort().join(" "));
	dir.closeSync();
	try {
		dir.readSync();
	} catch (error) {
		console.log("readSync closed", error.code);
	}
	await dir.close().catch((error) => console.log("close closed", error.code));

	const iterated = [];
	for await (const entry of await fsp.opendir(at("dir"))) iterated.push(entry.name);
	console.log("promises opendir", iterated.sort().join(" "));

	await new Promise((resolve) => {
		fs.opendir(at("dir"), (error, dir) => {
			dir.read((error, entry) => {
				console.log("read callback", error, typeof entry.name);
				dir.read().then((entry) => {
					console.log("read promise", typeof entry.name);
					dir.close((error) => {
						console.log("close callback", error);
						resolve();
					});
				});
			});
		});
	});
	await fsp
		.opendir(at("missing"))
		.catch((error) => console.log("opendir missing", failure(error)));
	const dirent = new fs.Dirent("made", 2, "/parent");
	console.log(
		"Dirent",
		dirent.name,
		dirent.isDirectory(),
		dirent.isFile(),
		dirent.parentPath,
	);
}

async function writeStreams() {
	const file = at("stream.txt");
	const stream = fs.createWriteStream(file);
	console.log(
		"createWriteStream",
		stream instanceof fs.WriteStream,
		fs.FileWriteStream === fs.WriteStream,
		relative(stream.path),
		stream.fd,
		stream.bytesWritten,
	);
	const events = [];
	stream.on("open", (fd) => events.push(`open:${typeof fd}`));
	stream.on("ready", () => events.push("ready"));
	stream.write("hello ");
	stream.write(Buffer.from("world"));
	await new Promise((resolve) => stream.end("!", resolve));
	console.log(
		"finish",
		events.join(" "),
		stream.bytesWritten,
		fs.readFileSync(file, "utf8"),
	);

	const append = fs.createWriteStream(file, { flags: "r+", start: 6, flush: true });
	await new Promise((resolve) => append.end("WORLD", resolve));
	console.log("start", append.bytesWritten, fs.readFileSync(file, "utf8"));

	const fd = fs.openSync(file, "a");
	const borrowed = new fs.WriteStream(null, { fd, autoClose: false });
	await new Promise((resolve) => borrowed.end("?", resolve));
	console.log(
		"fd",
		borrowed instanceof fs.WriteStream,
		borrowed.fd === fd,
		fs.readFileSync(file, "utf8"),
	);
	fs.closeSync(fd);

	const broken = fs.createWriteStream(at("missing", "file.txt"));
	await new Promise((resolve) => {
		const seen = [];
		broken.on("error", (error) => seen.push(`error:${failure(error)}`));
		broken.on("close", () => {
			console.log("open failure", seen.join(" "), broken.destroyed);
			resolve();
		});
	});

	const reader = fs.createReadStream(file);
	console.log(
		"ReadStream",
		reader instanceof fs.ReadStream,
		fs.FileReadStream === fs.ReadStream,
	);
	let text = "";
	for await (const chunk of new fs.ReadStream(file, { start: 6 })) text += chunk;
	console.log("ReadStream constructor", text);
	reader.destroy();
}

async function promiseOperations() {
	const file = at("promises.txt");
	fs.writeFileSync(file, "truncate me");
	await fsp.truncate(file, 8);
	console.log("truncate", JSON.stringify(fs.readFileSync(file, "utf8")));
	const { uid, gid } = fs.statSync(file);
	await fsp.chown(file, uid, gid);
	fs.symlinkSync(file, at("link"));
	await fsp.lchown(at("link"), uid, gid);
	await fsp.lutimes(at("link"), 1000, 2000);
	console.log(
		"lutimes",
		fs.lstatSync(at("link")).mtimeMs,
		fs.statSync(file).mtimeMs !== 2000000,
	);
	const statfs = await fsp.statfs(root);
	console.log("statfs", typeof statfs.bsize, statfs.blocks > 0);
	await fsp
		.truncate(at("missing.txt"))
		.catch((error) => console.log("truncate missing", failure(error)));
	await fsp
		.chown(file, "x", gid)
		.catch((error) => console.log("chown invalid", error.code));
	await new Promise((resolve) => {
		fs.statfs(root, (error, stats) => {
			console.log("statfs callback", error, stats.bsize === statfs.bsize);
			fs.statfs(at("missing"), (error) => {
				console.log("statfs missing", failure(error));
				resolve();
			});
		});
	});
}

try {
	await vectors();
	await directories();
	await writeStreams();
	await promiseOperations();
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
