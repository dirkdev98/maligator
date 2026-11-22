import {
	Stats,
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	unwatchFile,
	watch,
	watchFile,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = mkdtempSync(path.join(os.tmpdir(), "mal-fs-watch-"));

function untilEvent(watcher, predicate, poke) {
	return new Promise((resolve, reject) => {
		const deadline = setTimeout(() => {
			clearInterval(timer);
			watcher.close();
			reject(new Error("Timed out waiting for fs.watch notification"));
		}, 10_000);
		const timer = setInterval(poke, 50);
		watcher.on("change", (eventType, filename) => {
			if (!predicate(eventType, filename)) return;
			clearInterval(timer);
			clearTimeout(deadline);
			resolve([eventType, filename]);
		});
		poke();
	});
}

async function watchDirectory() {
	const dir = path.join(root, "dir");
	mkdirSync(dir);
	const watcher = watch(dir);
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
		() => writeFileSync(path.join(dir, "created.txt"), `v${created++}`),
	);
	console.log("dir event", type, name);
	let appended = 0;
	const [, changed] = await untilEvent(
		watcher,
		// Coalesced creation and modification can retain the platform's rename classification.
		(eventType, filename) =>
			(eventType === "change" || eventType === "rename") &&
			filename === "created.txt" &&
			readFileSync(path.join(dir, filename), "utf8").includes("+"),
		() => appendFileSync(path.join(dir, "created.txt"), `+${appended++}`),
	);
	console.log("dir modification", changed);
	const closed = new Promise((resolve) => watcher.on("close", () => resolve("closed")));
	console.log("close returns", watcher.close());
	console.log("dir", await closed);
}

async function watchTree() {
	const dir = path.join(root, "tree");
	mkdirSync(path.join(dir, "sub"), { recursive: true });
	const watcher = watch(dir, { recursive: true });
	let created = 0;
	const [type, name] = await untilEvent(
		watcher,
		(eventType, filename) =>
			eventType === "rename" && filename === path.join("sub", "created.txt"),
		() => writeFileSync(path.join(dir, "sub", "created.txt"), `v${created++}`),
	);
	console.log("tree event", type, name);
	const later = path.join(dir, "sub", "later");
	let nested = 0;
	const [nestedType, nestedName] = await untilEvent(
		watcher,
		(eventType, filename) =>
			eventType === "rename" && filename === path.join("sub", "later", "deep.txt"),
		() => {
			mkdirSync(later, { recursive: true });
			writeFileSync(path.join(later, "deep.txt"), `v${nested++}`);
		},
	);
	console.log("tree event", nestedType, nestedName);
	watcher.close();
}

async function watchSingleFile() {
	const file = path.join(root, "single.txt");
	writeFileSync(file, "start");
	const watcher = watch(file, { encoding: "buffer" });
	let writes = 0;
	const [type, name] = await untilEvent(
		watcher,
		(eventType) => eventType === "change",
		() => appendFileSync(file, `+${writes++}`),
	);
	console.log("file event", type, Buffer.isBuffer(name), name.toString());
	watcher.close();
}

async function watchLargeDirectory() {
	const dir = path.join(root, "many");
	mkdirSync(dir);
	for (let index = 0; index < 300; index++)
		writeFileSync(path.join(dir, `entry-${String(index).padStart(3, "0")}.txt`), "start");
	const nested = path.join(dir, "zz-nested");
	mkdirSync(nested);
	writeFileSync(path.join(nested, "target.txt"), "start");
	const watcher = watch(dir, { recursive: true });
	try {
		const modified = (expected) => (type, name) =>
			(type === "change" || type === "rename") &&
			name === expected &&
			readFileSync(path.join(dir, name), "utf8").includes("+");
		const target = "entry-299.txt";
		await untilEvent(watcher, modified(target), () =>
			appendFileSync(path.join(dir, target), "+"),
		);
		const deep = path.join("zz-nested", "target.txt");
		await untilEvent(watcher, modified(deep), () =>
			appendFileSync(path.join(dir, deep), "+"),
		);
		console.log("large directory and nested changes");
	} finally {
		watcher.close();
	}
}

async function watchAtomicReplacement() {
	const dir = path.join(root, "atomic");
	mkdirSync(dir);
	const target = path.join(dir, "config.json");
	writeFileSync(target, "original");
	const watcher = watch(dir);
	const notification = (content, action) =>
		new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(deadline);
				watcher.off("change", changed);
				watcher.off("error", failed);
			};
			const failed = (error) => {
				cleanup();
				reject(error);
			};
			const changed = (_type, name) => {
				if (name !== "config.json" || readFileSync(target, "utf8") !== content) return;
				cleanup();
				resolve();
			};
			const deadline = setTimeout(
				() => failed(new Error("Missing atomic replacement notification")),
				10_000,
			);
			watcher.on("change", changed);
			watcher.on("error", failed);
			try {
				action();
			} catch (error) {
				failed(error);
			}
		});
	try {
		await notification("replacement", () => {
			const next = path.join(dir, "next.json");
			writeFileSync(next, "replacement");
			renameSync(next, target);
		});
		await notification("modified replacement", () =>
			writeFileSync(target, "modified replacement"),
		);
		console.log("atomic replacement and subsequent modification");
	} finally {
		watcher.close();
	}
}

async function watchErrors() {
	try {
		watch(path.join(root, "missing"));
	} catch (error) {
		console.log(
			"missing",
			error.code,
			error.syscall,
			error.message.replace(root, "<root>"),
		);
	}
	try {
		watch(42);
	} catch (error) {
		console.log("bad path", error.code, error.name);
	}
}

async function statPolling() {
	const file = path.join(root, "polled.txt");
	writeFileSync(file, "a");
	let calls = 0;
	await new Promise((resolve) => {
		const listener = (curr, prev) => {
			calls++;
			console.log(
				"watchFile",
				curr instanceof Stats,
				prev instanceof Stats,
				curr.size,
				prev.size,
			);
			unwatchFile(file, listener);
			resolve();
		};
		const watcher = watchFile(file, { interval: 20 }, listener);
		console.log("stat watcher", typeof watcher.ref, typeof watcher.unref);
		setTimeout(() => {
			// A poll can sample writeFileSync's truncation; publish the completed file atomically.
			const replacement = path.join(root, "polled-next.txt");
			writeFileSync(replacement, "abcd");
			renameSync(replacement, file);
		}, 60);
	});
	writeFileSync(file, "abcdefgh");
	await new Promise((resolve) => setTimeout(resolve, 120));
	console.log("watchFile calls after unwatch", calls);

	const missing = path.join(root, "appears.txt");
	let deadline;
	try {
		await new Promise((resolve, reject) => {
			deadline = setTimeout(
				() => reject(new Error("Timed out waiting for fs.watchFile appearance")),
				10_000,
			);
			let reportedMissing = false;
			watchFile(missing, { interval: 20 }, (curr, prev) => {
				if (!reportedMissing) {
					if (curr.nlink !== 0 || prev.nlink !== 0) {
						reject(new Error("Expected the initial missing-file report"));
						return;
					}
					reportedMissing = true;
					console.log("watchFile missing", curr.size, prev.size);
					// Publish only after the missing report, with no partially written file to sample.
					const replacement = path.join(root, "appears-next.txt");
					writeFileSync(replacement, "xyz");
					renameSync(replacement, missing);
					return;
				}
				if (curr.size !== 3 || prev.nlink !== 0) {
					reject(new Error("Expected the completed file after the missing report"));
					return;
				}
				console.log("appeared", curr.size, prev.size, prev.mtimeMs, prev.ino);
				resolve();
			});
		});
	} finally {
		clearTimeout(deadline);
		unwatchFile(missing);
	}
}

try {
	await watchDirectory();
	await watchTree();
	await watchSingleFile();
	await watchLargeDirectory();
	await watchAtomicReplacement();
	await watchErrors();
	await statPolling();
} finally {
	rmSync(root, { recursive: true, force: true });
}

watch(os.tmpdir(), { persistent: false });
watchFile(
	path.join(os.tmpdir(), "mal-never-there"),
	{ persistent: false, interval: 10 },
	() => {},
);
console.log("non-persistent watchers do not keep the process alive");
