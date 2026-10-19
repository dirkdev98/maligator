import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mal-fs-watch-"));

function untilEvent(watcher, predicate, poke) {
	return new Promise((resolve) => {
		const timer = setInterval(poke, 50);
		watcher.on("change", (eventType, filename) => {
			if (!predicate(eventType, filename)) return;
			clearInterval(timer);
			resolve([eventType, filename]);
		});
		poke();
	});
}

async function watchDirectory() {
	const dir = path.join(root, "dir");
	fs.mkdirSync(dir);
	const watcher = fs.watch(dir);
	console.log(
		"watcher",
		typeof watcher.close,
		typeof watcher.ref,
		typeof watcher.unref,
		typeof watcher.on,
	);
	let created = 0;
	const [type, name] = await untilEvent(
		watcher,
		(eventType, filename) => eventType === "rename" && filename === "created.txt",
		() => fs.writeFileSync(path.join(dir, "created.txt"), `v${created++}`),
	);
	console.log("dir event", type, name);
	let appended = 0;
	const [changeType, changed] = await untilEvent(
		watcher,
		(eventType, filename) => eventType === "change" && filename === "created.txt",
		() => fs.appendFileSync(path.join(dir, "created.txt"), `+${appended++}`),
	);
	console.log("dir event", changeType, changed);
	const closed = new Promise((resolve) => watcher.on("close", () => resolve("closed")));
	console.log("close returns", watcher.close());
	console.log("dir", await closed);
}

async function watchFile() {
	const file = path.join(root, "single.txt");
	fs.writeFileSync(file, "start");
	const watcher = fs.watch(file, { encoding: "buffer" });
	let writes = 0;
	const [type, name] = await untilEvent(
		watcher,
		(eventType) => eventType === "change",
		() => fs.appendFileSync(file, `+${writes++}`),
	);
	console.log("file event", type, Buffer.isBuffer(name), name.toString());
	watcher.close();
}

async function watchErrors() {
	try {
		fs.watch(path.join(root, "missing"));
	} catch (error) {
		console.log(
			"missing",
			error.code,
			error.syscall,
			error.message.replace(root, "<root>"),
		);
	}
	try {
		fs.watch(42);
	} catch (error) {
		console.log("bad path", error.code, error.name);
	}
}

async function statPolling() {
	const file = path.join(root, "polled.txt");
	fs.writeFileSync(file, "a");
	let calls = 0;
	await new Promise((resolve) => {
		const listener = (curr, prev) => {
			calls++;
			console.log(
				"watchFile",
				curr instanceof fs.Stats,
				prev instanceof fs.Stats,
				curr.size,
				prev.size,
			);
			fs.unwatchFile(file, listener);
			resolve();
		};
		const watcher = fs.watchFile(file, { interval: 20 }, listener);
		console.log("stat watcher", typeof watcher.ref, typeof watcher.unref);
		setTimeout(() => fs.writeFileSync(file, "abcd"), 60);
	});
	fs.writeFileSync(file, "abcdefgh");
	await new Promise((resolve) => setTimeout(resolve, 120));
	console.log("watchFile calls after unwatch", calls);

	const missing = path.join(root, "appears.txt");
	await new Promise((resolve) => {
		fs.watchFile(missing, { interval: 20 }, (curr, prev) => {
			console.log("appeared", curr.size, prev.size, prev.mtimeMs, prev.ino);
			fs.unwatchFile(missing);
			resolve();
		});
		setTimeout(() => fs.writeFileSync(missing, "xyz"), 60);
	});
}

async function promisesWatch() {
	const dir = path.join(root, "iter");
	fs.mkdirSync(dir);
	const controller = new AbortController();
	const iterator = fsp.watch(dir, { signal: controller.signal });
	let count = 0;
	const timer = setInterval(
		() => fs.writeFileSync(path.join(dir, `f${count++}.txt`), "x"),
		50,
	);
	try {
		for await (const event of iterator) {
			if (event.eventType === "rename" && event.filename === "f0.txt") {
				console.log("promises event", event.eventType, event.filename);
				controller.abort();
			}
		}
	} catch (error) {
		console.log("promises abort", error.name, error.code);
	} finally {
		clearInterval(timer);
	}
}

await watchDirectory();
await watchFile();
await watchErrors();
await statPolling();
await promisesWatch();
fs.rmSync(root, { recursive: true, force: true });

fs.watch(os.tmpdir(), { persistent: false });
fs.watchFile(
	path.join(os.tmpdir(), "mal-never-there"),
	{ persistent: false, interval: 10 },
	() => {},
);
console.log("non-persistent watchers do not keep the process alive");
