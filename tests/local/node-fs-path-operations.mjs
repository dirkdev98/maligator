import { Buffer } from "node:buffer";
import fs, { rename, unlink } from "node:fs";
import fsp, { rename as renamePromise, unlink as unlinkPromise } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { types } from "node:util";
const root = process.env.MAL_FS_PATH_ROOT + "/ops";
fs.mkdirSync(root, { recursive: true });
const results = [];
function describe(error) {
	return [
		error.name,
		error.code,
		error.syscall,
		error.path?.replace(root, "<root>"),
		error.dest?.replace(root, "<root>"),
	];
}
function seed(name) {
	const path = root + "/" + name;
	fs.writeFileSync(path, "data");
	return path;
}
async function callback(label, fn, args) {
	let returned = false;
	await new Promise((resolve) => {
		try {
			const value = fn(...args, function (error) {
				results.push([
					label,
					"callback",
					returned,
					this === undefined,
					arguments.length,
					error === null ? null : describe(error),
				]);
				resolve();
			});
			returned = true;
			results.push([label, "return", value === undefined]);
		} catch (error) {
			results.push([label, "throw", describe(error)]);
			resolve();
		}
	});
}
async function promise(label, fn, args) {
	let value;
	try {
		value = fn(...args);
	} catch (error) {
		results.push([label, "throw", describe(error)]);
		return;
	}
	results.push([label, "promise", value instanceof Promise]);
	try {
		results.push([label, "fulfilled", (await value) === undefined]);
	} catch (error) {
		results.push([label, "rejected", describe(error)]);
	}
}
try {
	results.push([
		"identity",
		fs.rename === rename,
		fs.unlink === unlink,
		fs.promises.rename === renamePromise,
		fs.promises.unlink === unlinkPromise,
	]);
	const first = seed("first");
	await callback("unlink", unlink, [first]);
	results.push(["gone", !fs.existsSync(first)]);
	await promise("unlink missing", unlinkPromise, [first]);
	const second = seed("second"),
		third = seed("third");
	await callback("rename replace", rename, [Buffer.from(second), pathToFileURL(third)]);
	results.push(["renamed", !fs.existsSync(second), fs.readFileSync(third, "utf8")]);
	await promise("rename", renamePromise, [third, first]);
	results.push([
		"rename promise result",
		!fs.existsSync(third),
		fs.readFileSync(first, "utf8"),
	]);
	await callback("rename missing", rename, [root + "/missing", root + "/dest"]);
	await promise("rename missing", renamePromise, [root + "/missing", root + "/dest"]);
	await callback("unlink directory", unlink, [root]);
	await promise("unlink directory", unlinkPromise, [root]);
	for (const path of [
		null,
		undefined,
		3,
		{},
		"bad\0path",
		new URL("https://example.com/"),
	]) {
		await callback("unlink invalid", unlink, [path]);
		await promise("unlink invalid", unlinkPromise, [path]);
		await callback("rename invalid destination", rename, [first, path]);
		await promise("rename invalid destination", renamePromise, [first, path]);
	}
	for (const fn of [rename, unlink])
		try {
			fn(...(fn === rename ? [first, third] : [first]));
		} catch (error) {
			results.push(["missing callback", fn.name, describe(error)]);
		}
	for (const fn of [rename, unlink, renamePromise, unlinkPromise])
		results.push([
			"metadata",
			fn.name,
			fn.length,
			Reflect.ownKeys(fn),
			Object.prototype.toString.call(fn),
			types.isAsyncFunction(fn),
		]);
	const snapshot = Buffer.from(seed("snapshot"));
	await new Promise((resolve) => {
		unlink(snapshot, (error) => {
			results.push(["snapshot", error === null]);
			resolve();
		});
		snapshot.fill(0);
	});
	const retained = seed("retained");
	fs.readFileSync = () => {
		throw new Error("replaced sync function");
	};
	Object.defineProperty(fs, "promises", {
		get() {
			throw new Error("replaced alias");
		},
		configurable: true,
	});
	results.push([
		"cache",
		process.getBuiltinModule("node:fs/promises") === fsp,
		await fsp.readFile(retained, "utf8"),
	]);
	const marker = {};
	const url = pathToFileURL(first);
	Object.defineProperty(url, "pathname", {
		get() {
			throw marker;
		},
	});
	try {
		unlink(url, () => {});
	} catch (error) {
		results.push(["getter throw", error === marker]);
	}
	try {
		await unlinkPromise(url);
	} catch (error) {
		results.push(["getter rejection", error === marker]);
	}
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify(results));
