import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import fs, { access, promises as namedPromises } from "node:fs";
import fsp, { access as accessPromise } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { types } from "node:util";

const root = process.env.MAL_FS_ACCESS_ROOT;
const present = root + "/present";
const absent = root + "/absent";
const results = [];
function errorRow(error) {
	return [
		error.name,
		error.code,
		error.syscall,
		typeof error.path === "string" ? error.path.replace(root, "<root>") : error.path,
	];
}
async function callbackCase(label, path, mode) {
	let returned = false;
	let callResult;
	await new Promise((resolve) => {
		try {
			const callback = function (error) {
				results.push([
					label,
					"callback",
					returned,
					this === undefined,
					arguments.length,
					error === null ? null : errorRow(error),
				]);
				resolve();
			};
			callResult =
				mode === "omitted" ? access(path, callback) : access(path, mode, callback);
			returned = true;
			results.push([label, "return", callResult === undefined]);
		} catch (error) {
			results.push([label, "throw", errorRow(error)]);
			resolve();
		}
	});
}
async function promiseCase(label, path, mode) {
	let promise;
	try {
		promise = accessPromise(path, mode);
	} catch (error) {
		results.push([label, "throw", errorRow(error)]);
		return;
	}
	results.push([label, "promise", promise instanceof Promise]);
	try {
		results.push([label, "fulfill", (await promise) === undefined]);
	} catch (error) {
		results.push([label, "reject", errorRow(error)]);
	}
}
results.push([
	"identity",
	fs.access === access,
	fs.promises.access === accessPromise,
	fsp.access === accessPromise,
	namedPromises === fsp,
]);
for (const [label, path] of [
	["string", present],
	["buffer", Buffer.from(present)],
	["url", pathToFileURL(present)],
	["missing", absent],
	["notdir", present + "/child"],
	["read-only", root + "/readonly"],
]) {
	await callbackCase(label, path, label === "read-only" ? fs.constants.W_OK : "omitted");
	await promiseCase(label, path, label === "read-only" ? fs.constants.W_OK : undefined);
}
for (const mode of [
	undefined,
	null,
	0,
	4,
	7.9,
	-1,
	8,
	NaN,
	Infinity,
	true,
	"4",
	1n,
	Symbol("mode"),
]) {
	const label = "mode:" + String(mode);
	await callbackCase(label, present, mode);
	await promiseCase(label, present, mode);
}
for (const path of [
	undefined,
	null,
	3,
	{},
	"x\0y",
	new URL("http://example.com/"),
	new URL("file://host/a"),
	new URL("file:///a%2Fb"),
	new URL("file:///a%ff"),
]) {
	await callbackCase("invalid-path", path, "omitted");
	await promiseCase("invalid-path", path, undefined);
}
for (const callback of [undefined, null, 3, {}]) {
	try {
		access(present, callback);
	} catch (error) {
		results.push(["invalid-callback", errorRow(error)]);
	}
}
const snapshot = Buffer.from(present);
await new Promise((resolve) => {
	access(snapshot, function (error) {
		results.push(["snapshot", error === null]);
		resolve();
	});
	snapshot.fill(0);
});
const rawPath = Buffer.concat([Buffer.from(root + "/"), Buffer.from([255])]);
await callbackCase("raw missing path", rawPath, "omitted");
await promiseCase("raw missing path", rawPath, undefined);
const storage = new AsyncLocalStorage();
await new Promise((resolve) =>
	storage.run("outer", () => {
		access(present, function (error) {
			results.push(["context", storage.getStore(), error === null]);
			storage.run("inner", () =>
				access(present, function (innerError) {
					results.push(["nested", storage.getStore(), innerError === null]);
					resolve();
				}),
			);
		});
	}),
);
const multiple = await Promise.all(
	Array.from({ length: 32 }, (_, index) =>
		accessPromise(index % 2 === 0 ? present : absent).then(
			() => true,
			(error) => error.code,
		),
	),
);
results.push(["multiple", multiple]);
for (const fn of [access, accessPromise]) {
	results.push([
		"metadata",
		fn.name,
		fn.length,
		Reflect.ownKeys(fn),
		Object.prototype.toString.call(fn),
		types.isAsyncFunction(fn),
		types.isGeneratorFunction(fn),
	]);
}
const targetEffects = [];
const target = new Proxy(function Target() {}, {
	get(object, key) {
		targetEffects.push(String(key));
		return Reflect.get(object, key);
	},
});
await new Promise((resolve) => {
	const instance = Reflect.construct(access, [present, () => resolve()], target);
	results.push([
		"construct",
		Object.getPrototypeOf(instance) === target.prototype,
		targetEffects,
	]);
});
try {
	Reflect.construct(accessPromise, [present]);
} catch (error) {
	results.push(["async construct", error.name]);
}
const originalPrototype = Object.getPrototypeOf(accessPromise);
Object.setPrototypeOf(accessPromise, null);
results.push([
	"async brand",
	types.isAsyncFunction(accessPromise),
	types.isAsyncFunction(new Proxy(accessPromise, {})),
	types.isAsyncFunction(Function.prototype.bind.call(accessPromise, null)),
]);
Object.setPrototypeOf(accessPromise, originalPrototype);
console.log(JSON.stringify(results));
