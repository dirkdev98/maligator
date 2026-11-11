import {
	closeSync,
	fstatSync,
	lstat,
	lstatSync,
	mkdtempSync,
	openSync,
	promises,
	rmSync,
	stat,
	statSync,
	unwatchFile,
	watchFile,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = new URL(import.meta.url).pathname;
const describe = (stats) => {
	const keys = Object.keys(stats).sort().join(",");
	const types = [...new Set(Object.values(stats).map((value) => typeof value))].join("/");
	const ns = stats.mtimeNs / 1000000n === stats.mtimeMs;
	const date =
		stats.mtime instanceof Date && stats.mtime.getTime() === Number(stats.mtimeMs);
	return `${keys} ${types} ns=${ns} date=${date} file=${stats.isFile()}`;
};
const results = [
	["statSync", describe(statSync(fixture, { bigint: true }))],
	["lstatSync", describe(lstatSync(fixture, { bigint: true }))],
];
const fd = openSync(fixture, "r");
results.push(["fstatSync", describe(fstatSync(fd, { bigint: true }))]);
closeSync(fd);
results.push(["promises.stat", describe(await promises.stat(fixture, { bigint: true }))]);
const handle = await promises.open(fixture, "r");
results.push(["FileHandle.stat", describe(await handle.stat({ bigint: true }))]);
await handle.close();
for (const [name, call] of [
	["stat", stat],
	["lstat", lstat],
]) {
	const stats = await new Promise((resolve, reject) =>
		call(fixture, { bigint: true }, (error, value) =>
			error ? reject(error) : resolve(value),
		),
	);
	results.push([name, describe(stats)]);
}
const numbers = statSync(fixture);
results.push(["default", `${typeof numbers.mtimeMs} ${numbers.mtimeNs}`]);
results.push([
	"exact",
	String(statSync(fixture, { bigint: true }).ino === BigInt(statSync(fixture).ino)),
]);
const directory = mkdtempSync(join(tmpdir(), "bigint-watch-"));
const watched = join(directory, "watched.txt");
writeFileSync(watched, "a");
const watchResult = await new Promise((resolve) => {
	watchFile(watched, { bigint: true, interval: 20 }, (current, previous) => {
		unwatchFile(watched);
		resolve(`${describe(current)} previous=${typeof previous.size} size=${current.size}`);
	});
	setTimeout(() => writeFileSync(watched, "bb"), 60);
});
rmSync(directory, { recursive: true });
results.push(["watchFile", watchResult]);
console.log(results.map((entry) => entry.join(" ")).join("\n"));
