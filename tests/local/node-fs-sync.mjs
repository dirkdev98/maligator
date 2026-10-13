import { AsyncLocalStorage } from "node:async_hooks";
import fs, { fdatasync, fdatasyncSync, fsync, fsyncSync } from "node:fs";
const file = process.env.MAL_FS_SYNC_ROOT + "/data";
const results = [];
const fd = fs.openSync(file, "w");
fs.writeSync(fd, "data");
function errorRow(error) {
	return [error.name, error.code, error.syscall, error.path];
}
async function check(fn, value) {
	let returned = false;
	await new Promise((resolve) => {
		try {
			const result = fn(value, function (error) {
				results.push([
					fn.name,
					"callback",
					returned,
					this === undefined,
					arguments.length,
					error === null ? null : errorRow(error),
				]);
				resolve();
			});
			returned = true;
			results.push([fn.name, "return", result === undefined]);
		} catch (error) {
			results.push([fn.name, "throw", errorRow(error)]);
			resolve();
		}
	});
}
try {
	results.push([
		"identity",
		fs.fdatasync === fdatasync,
		fs.fdatasyncSync === fdatasyncSync,
		fs.fsync === fsync,
		fs.fsyncSync === fsyncSync,
	]);
	for (const fn of [fdatasync, fsync]) {
		await check(fn, fd);
		await check(fn, 2147483647);
		for (const value of [
			-1,
			0.5,
			NaN,
			Infinity,
			2147483648,
			null,
			undefined,
			"1",
			1n,
			Symbol("fd"),
		])
			await check(fn, value);
	}
	for (const fn of [fdatasyncSync, fsyncSync]) {
		results.push([fn.name, "success", fn(fd) === undefined]);
		for (const value of [
			2147483647,
			-1,
			0.5,
			NaN,
			Infinity,
			2147483648,
			null,
			undefined,
			"1",
			1n,
			Symbol("fd"),
		])
			try {
				fn(value);
			} catch (error) {
				results.push([fn.name, "throw", errorRow(error)]);
			}
	}
	for (const fn of [fdatasync, fsync])
		for (const callback of [undefined, null, 3])
			try {
				fn(fd, callback);
			} catch (error) {
				results.push([fn.name, "invalid callback", errorRow(error)]);
			}
	for (const fn of [fdatasync, fsync, fdatasyncSync, fsyncSync]) {
		const d = Object.getOwnPropertyDescriptor(fn, "prototype");
		results.push([
			"metadata",
			fn.name,
			fn.length,
			Reflect.ownKeys(fn),
			d.writable,
			d.enumerable,
			d.configurable,
			fn.prototype.constructor === fn,
		]);
	}
	const storage = new AsyncLocalStorage();
	await new Promise((resolve) =>
		storage.run("sync-context", () =>
			fdatasync(fd, (error) => {
				results.push(["context", storage.getStore(), error === null]);
				resolve();
			}),
		),
	);
	for (const fn of [fdatasync, fsync])
		await new Promise((resolve) => {
			const instance = Reflect.construct(fn, [
				fd,
				(error) => {
					results.push(["construct callback", fn.name, error === null]);
					resolve();
				},
			]);
			results.push(["construct", fn.name, instance instanceof fn]);
		});
	for (const fn of [fdatasyncSync, fsyncSync])
		results.push(["construct sync", fn.name, Reflect.construct(fn, [fd]) instanceof fn]);
} finally {
	fs.closeSync(fd);
	fs.unlinkSync(file);
}
await check(fdatasync, fd);
await check(fsync, fd);
console.log(JSON.stringify(results));
