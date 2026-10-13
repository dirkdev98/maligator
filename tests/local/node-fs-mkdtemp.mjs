import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import fs, { mkdtemp, mkdtempSync } from "node:fs";
import fsp, { mkdtemp as mkdtempPromise } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { types } from "node:util";
const root = process.env.MAL_MKDTEMP_ROOT + "/dirs";
fs.mkdirSync(root, { recursive: true });
const results = [];
function created(label, value, encoding = "utf8") {
	const buffer = Buffer.isBuffer(value);
	const hex = buffer || encoding === "hex";
	const text = buffer ? value.toString("hex") : value;
	results.push([label, "created", buffer, text.slice(0, hex ? -12 : -6), text.length]);
}
function errorRow(error) {
	let path = error.path;
	if (error.syscall === "mkdtemp" && typeof path === "string")
		path = path.slice(0, -6) + "<suffix>";
	return [error.name, error.code, error.syscall, path];
}
async function callback(label, prefix, options, encoding) {
	let returned = false;
	await new Promise((resolve) => {
		try {
			const cb = function (error, value) {
				results.push([
					label,
					"callback",
					returned,
					this === undefined,
					arguments.length,
					error === null ? null : errorRow(error),
				]);
				if (error === null) created(label, value, encoding);
				resolve();
			};
			const value =
				options === "omitted" ? mkdtemp(prefix, cb) : mkdtemp(prefix, options, cb);
			returned = true;
			results.push([label, "return", value === undefined]);
		} catch (error) {
			results.push([label, "throw", errorRow(error)]);
			resolve();
		}
	});
}
async function promise(label, prefix, options, encoding) {
	let value;
	try {
		value = mkdtempPromise(prefix, options);
	} catch (error) {
		results.push([label, "throw", errorRow(error)]);
		return;
	}
	results.push([label, "promise", value instanceof Promise]);
	try {
		created(label, await value, encoding);
	} catch (error) {
		results.push([label, "reject", errorRow(error)]);
	}
}
try {
	results.push([
		"identity",
		fs.mkdtemp === mkdtemp,
		fsp.mkdtemp === mkdtempPromise,
		fs.promises.mkdtemp === mkdtempPromise,
	]);
	for (const [label, options, encoding] of [
		["default", undefined, "utf8"],
		["null", null, "utf8"],
		["UTF-8", "UTF-8", "utf8"],
		["buffer", "buffer", "buffer"],
		["latin1", "latin1", "latin1"],
		["ascii", "ascii", "ascii"],
		["hex", "hex", "hex"],
		["object buffer", { encoding: "buffer" }, "buffer"],
		["falsy encoding", { encoding: false }, "utf8"],
		["empty", "", "utf8"],
		["function", function () {}, "utf8"],
	]) {
		const prefix = root + "/é-";
		if (label !== "function") await callback(label, prefix, options, encoding);
		await promise(label, prefix, options, encoding);
		try {
			created(label + ":sync", mkdtempSync(prefix, options), encoding);
		} catch (error) {
			results.push([label + ":sync", "throw", errorRow(error)]);
		}
	}
	for (const prefix of [Buffer.from(root + "/bytes-"), pathToFileURL(root + "/url-")]) {
		await callback("prefix", prefix, "omitted", "utf8");
		await promise("prefix", prefix, undefined, "utf8");
	}
	for (const options of [false, 0, "bogus", { encoding: 7 }, { signal: null }]) {
		await callback("invalid options", root + "/p-", options, "utf8");
		await promise("invalid options", root + "/p-", options, "utf8");
	}
	for (const prefix of [
		undefined,
		null,
		3,
		"bad\0prefix",
		root + "/missing/p-",
		new URL("http://example.com/"),
	]) {
		await callback("invalid prefix", prefix, "omitted", "utf8");
		await promise("invalid prefix", prefix, undefined, "utf8");
	}
	for (const fn of [mkdtemp, mkdtempPromise, mkdtempSync])
		results.push([
			"metadata",
			fn.name,
			fn.length,
			Reflect.ownKeys(fn),
			types.isAsyncFunction(fn),
		]);
	const effects = [];
	let count = 0;
	const options = {
		get encoding() {
			effects.push("encoding");
			return ++count === 3 ? "BUFFER" : "utf8";
		},
		get signal() {
			effects.push("signal");
			return undefined;
		},
	};
	created(
		"dynamic encoding",
		await mkdtempPromise(root + "/dynamic-", options),
		"buffer",
	);
	results.push(["effects", effects]);
	const prefix = Buffer.from(root + "/before-");
	let n = 0;
	const mutate = {
		get encoding() {
			if (++n === 3) prefix.set(Buffer.from(root + "/after--"));
			return "utf8";
		},
	};
	created("mutated prefix", await mkdtempPromise(prefix, mutate));
	results.push(["mutate gets", n]);
	const hasEffects = [];
	const signal = new Proxy(
		{ aborted: false },
		{
			has(target, key) {
				hasEffects.push(String(key));
				return Reflect.has(target, key);
			},
		},
	);
	created("signal", await mkdtempPromise(root + "/signal-", { signal }));
	results.push(["signal effects", hasEffects]);
	const marker = {};
	const throwOptions = {
		get encoding() {
			throw marker;
		},
	};
	try {
		await mkdtempPromise(null, throwOptions);
	} catch (error) {
		results.push(["options before prefix", error === marker]);
	}
	let got = false;
	try {
		mkdtemp(
			null,
			{
				get encoding() {
					got = true;
					throw marker;
				},
			},
			3,
		);
	} catch (error) {
		results.push(["callback before options", got, error.code]);
	}
	const storage = new AsyncLocalStorage();
	await new Promise((resolve) =>
		storage.run("context", () =>
			mkdtemp(root + "/context-", function (error, value) {
				results.push(["context", storage.getStore(), error === null]);
				created("context", value);
				resolve();
			}),
		),
	);
	const targetEffects = [];
	const target = new Proxy(function Target() {}, {
		get(object, key) {
			targetEffects.push(String(key));
			return Reflect.get(object, key);
		},
	});
	await new Promise((resolve) => {
		const instance = Reflect.construct(
			mkdtemp,
			[
				root + "/construct-",
				(error, value) => {
					results.push(["construct callback", error === null]);
					created("construct", value);
					resolve();
				},
			],
			target,
		);
		results.push([
			"construct",
			Object.getPrototypeOf(instance) === target.prototype,
			targetEffects,
		]);
	});
	const instance = Reflect.construct(mkdtempSync, [root + "/sync-"]);
	results.push(["sync construct", instance instanceof mkdtempSync]);
	const buffer = Reflect.construct(mkdtempSync, [root + "/sync-buffer-", "buffer"]);
	results.push([
		"sync buffer construct",
		Buffer.isBuffer(buffer),
		buffer instanceof mkdtempSync,
	]);
	created("sync buffer", buffer, "buffer");
	const dirs = fs.readdirSync(root);
	results.push([
		"directories",
		dirs.length,
		dirs.every((name) => fs.statSync(root + "/" + name).isDirectory()),
	]);
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify(results));
