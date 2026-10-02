import * as fs from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function check(condition, name) {
	if (!condition) throw new Error(name);
	checked++;
}

let checked = 0;
const root = fs.mkdtempSync("/tmp/mal-write-workers-");
try {
	const writes = [];
	for (let i = 0; i < 64; i++) {
		const bytes = new Uint8Array(65538);
		bytes.fill(i);
		const path = join(root, String(i));
		writes.push(
			writeFile(pathToFileURL(path), bytes.subarray(1, 65537), {
				flag: "wx",
				mode: 0o600,
			}),
		);
	}
	await Promise.all(writes);
	for (let i = 0; i < 64; i++) {
		const bytes = fs.readFileSync(join(root, String(i)));
		check(
			bytes.length === 65536 && bytes[0] === i && bytes[65535] === i,
			"concurrent view writes retain their own bytes",
		);
	}
	const text = join(root, "text");
	await writeFile(text, "616263", "hex");
	await appendFile(text, "def", { encoding: "utf8", flush: true });
	check(fs.readFileSync(text, "utf8") === "abcdef", "encoding, append and flush");
	const descriptor = fs.openSync(text, "a");
	try {
		await writeFile(descriptor, Buffer.from("ghi"));
		fs.writeSync(descriptor, "j");
	} finally {
		fs.closeSync(descriptor);
	}
	check(fs.readFileSync(text, "utf8") === "abcdefghij", "borrowed fd remains open");
	for (const [path, options, code, syscall] of [
		[text, { flag: "wx" }, "EEXIST", "open"],
		[join(root, "absent", "file"), {}, "ENOENT", "open"],
		[root, {}, "EISDIR", "open"],
	]) {
		let caught;
		try {
			await writeFile(path, "x", options);
		} catch (error) {
			caught = error;
		}
		check(
			caught?.code === code && caught?.syscall === syscall && caught?.path === path,
			"worker errors preserve errno, syscall and path",
		);
	}
	let validation;
	try {
		await writeFile(text, "x", { flush: 1 });
	} catch (error) {
		validation = error;
	}
	check(validation instanceof TypeError, "invalid options reject the promise");
	const empty = join(root, "empty");
	await writeFile(empty, new Uint8Array(0));
	check(fs.statSync(empty).size === 0, "empty writes create files");
	console.log("RESULT " + checked + "/" + checked);
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
