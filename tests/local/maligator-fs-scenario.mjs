// Runs against `maligator:fs` and against a Node fs/promises reference with the same
// contract; both print the same lines from the same starting directory.

const LARGE = 8 * 1024 * 1024;

function show(value) {
	return typeof value === "string" ? value : JSON.stringify(value);
}

async function directoryScenario(directory, URL, log, outcome) {
	const listing = directory("listing/");
	const empty = listing.directory("empty");
	log("directory handles", listing.path, empty.path, await empty.exists());
	await empty.create({ mode: 0o700 });
	const status = await empty.stat();
	log("directory stat", status.isDirectory, status.mode & 0o777);
	log("empty entries", await empty.entries(), await empty.files());
	await outcome("directory already exists", () => empty.create());
	await empty.create({ recursive: true });
	await empty.delete();
	log("empty deleted", await empty.exists());
	await empty.create();

	const deepPath = `${"deep/".repeat(24)}last`;
	await outcome("missing parent", () => listing.directory(deepPath).create());
	await listing.directory(deepPath).create({ recursive: true });
	await listing.directory(".hidden").create();
	for (const relative of [
		"top.txt",
		"\uE000.txt",
		"\u{10000}.txt",
		".root.txt",
		".hidden/hidden.txt",
		"deep/skip.txt",
		`${deepPath}/bottom.txt`,
		"deep/data.json",
	])
		await listing.file(relative).write(relative);

	await outcome("recursive delete of dot directory", () =>
		directory("listing/.").delete({ recursive: true }),
	);
	log(
		"directory get",
		(await listing.get("top.txt"))?.path,
		await listing.get("gone.txt"),
		await listing.get("empty"),
		await listing.get("link"),
	);
	log("directory entries shallow", await listing.entries());
	log("directory entries recursive", await listing.entries({ recursive: true }));
	log(
		"directory entries filtered",
		await listing.entries({ recursive: true, include: ["deep/?ata.json", "link"] }),
	);
	log(
		"directory files",
		(await listing.files()).map(({ path }) => path),
	);
	log(
		"directory files shallow",
		(await listing.files({ recursive: false })).map(({ path }) => path),
	);
	log(
		"directory files filtered",
		(await listing.files({ include: ["**/*.txt"], exclude: ["**/s?ip.txt"] })).map(
			({ path }) => path,
		),
	);
	log(
		"explicit dot path",
		(await listing.files({ include: [".hidden/*.txt"] })).map(({ path }) => path),
	);
	log(
		"directory files with dots",
		(await listing.files({ dot: true })).map(({ path }) => path),
	);
	log("directory files no match", await listing.files({ include: ["**/*.sql"] }));
	await outcome("nonrecursive delete of nonempty directory", () => listing.delete());
	await outcome("invalid child path", () => listing.file("../outside/kept.txt"));
	await outcome("invalid include", () => listing.files({ include: ["../*.txt"] }));
	await outcome("listing a regular file", () => listing.directory("top.txt").entries());
	await outcome("creating beneath a regular file", () =>
		listing.directory("top.txt/child").create({ recursive: true }),
	);
	await outcome("deleting a regular file as a directory", () =>
		listing.directory("top.txt").delete({ recursive: true }),
	);
	await outcome("deleting a directory symlink with trailing slash", () =>
		directory("listing/link/").delete({ recursive: true }),
	);
	await listing.delete({ recursive: true });
	log(
		"recursive directory delete",
		await listing.exists(),
		await directory("outside").file("kept.txt").text(),
	);
	await outcome("listing a missing directory", () => listing.entries());
	await outcome("deleting a missing directory", () => listing.delete());
	if (URL !== undefined)
		log("directory url", directory(new URL("file:///tmp/a%20b")).path);
}

// `URL` is absent from a program built without the web surface.
export async function scenario({ directory, file, FileSystemError, URL }) {
	const lines = [];
	const log = (...parts) => lines.push(parts.map(show).join(" "));
	const outcome = async (label, operation) => {
		try {
			const value = await operation();
			log(label, "fulfilled", value === undefined ? "-" : value);
		} catch (error) {
			if (error instanceof FileSystemError) {
				log(
					label,
					error.name,
					error instanceof Error,
					error.code,
					error.syscall,
					error.path,
					error.destination ?? "-",
					error.message,
				);
			} else log(label, "threw", error.constructor.name);
		}
	};

	const notes = file("notes.txt");
	log("handle", notes.path, notes.type, Object.isFrozen(notes));
	log("types", file("data.json").type, file("raw.bin").type, file("README").type);
	log("exists before", await notes.exists());
	log("write", await notes.write("héllo\n"));
	log("append", await notes.append(new Uint8Array([119, 111, 114, 108, 100, 10])));
	log("text", JSON.stringify(await notes.text()));
	const bytes = await notes.bytes();
	log(
		"bytes",
		bytes.constructor.name,
		bytes.length,
		bytes.buffer.byteLength,
		Array.from(bytes.subarray(0, 3)),
	);
	bytes[0] = 0;
	log("bytes are a copy", (await notes.bytes())[0]);
	const info = await notes.stat();
	log(
		"stat",
		info.size,
		info.isFile,
		info.isDirectory,
		info.isSymbolicLink,
		(info.mode & 0o170000).toString(8),
		info.mtime instanceof Date,
		Math.abs(info.mtime.getTime() - Date.now()) < 600_000,
		Object.isFrozen(info),
	);
	log("exists after", await notes.exists());

	await file("bom.txt").write(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69, 0xff]));
	log("bom", await file("bom.txt").text(), (await file("bom.txt").bytes()).length);
	await file("data.json").write(JSON.stringify({ answer: 42 }));
	log("json", await file("data.json").json());
	await file("broken.json").write("{");
	await outcome("json syntax", () => file("broken.json").json());

	const buffer = new Uint8Array([1, 2, 3, 4, 5]).buffer;
	log("array buffer", await file("raw.bin").write(buffer));
	log("view", await file("raw.bin").write(new DataView(buffer, 1, 3)));
	log("raw", Array.from(await file("raw.bin").bytes()));
	log("empty", await file("empty.txt").write(""), (await file("empty.txt").stat()).size);
	log("truncates", await file("raw.bin").write("z"), await file("raw.bin").text());

	await outcome("nested", () => file("a/b/c.txt").write("x"));
	log(
		"create directories",
		await file("a/b/c.txt").write("x", { createDirectories: true }),
		await file("a/b/c.txt").text(),
	);
	log(
		"append creates",
		await file("d/log.txt").append("1", { createDirectories: true }),
		await file("d/log.txt").append("2"),
		await file("d/log.txt").text(),
	);

	log(
		"atomic",
		await file("atomic.txt").write("first", { atomic: true }),
		await file("atomic.txt").text(),
	);
	await file("atomic.txt").write("second", { atomic: true, mode: 0o600 });
	log(
		"atomic mode",
		((await file("atomic.txt").stat()).mode & 0o777).toString(8),
		await file("atomic.txt").text(),
	);
	await file("atomic.txt").write("third", { atomic: true });
	log(
		"atomic keeps mode",
		((await file("atomic.txt").stat()).mode & 0o777).toString(8),
		await file("atomic.txt").text(),
	);
	await file("folder/inner.txt").write("inside", { createDirectories: true });
	await outcome("atomic onto directory", () =>
		file("folder").write("x", { atomic: true }),
	);
	await outcome("atomic into missing directory", () =>
		file("nowhere/x.txt").write("x", { atomic: true }),
	);
	await outcome("mode option", () => file("x.txt").write("x", { mode: 0o10000 }));
	await outcome("data type", () => file("x.txt").write(42));

	await outcome("missing text", () => file("missing.txt").text());
	await outcome("missing bytes", () => file("missing.txt").bytes());
	await outcome("missing stat", () => file("missing.txt").stat());
	await outcome("missing delete", () => file("missing.txt").delete());
	await outcome("missing copy", () => file("missing.txt").copyTo("copy.txt"));
	await outcome("missing move", () => file("missing.txt").moveTo("moved.txt"));
	log("missing exists", await file("missing.txt").exists());
	await outcome("directory text", () => file("folder").text());
	await outcome("directory write", () => file("folder").write("x"));
	await outcome("directory append", () => file("folder").append("x"));
	await outcome("directory delete", () => file("folder").delete());
	const folder = await file("folder").stat();
	log(
		"directory stat",
		folder.isFile,
		folder.isDirectory,
		(folder.mode & 0o170000).toString(8),
	);
	await outcome("not a directory", () => file("notes.txt/child").text());
	await outcome("locked write", () => file("locked/new.txt").write("x"));
	await outcome("unreadable text", () => file("unreadable.txt").text());

	await notes.copyTo("copy.txt");
	await notes.copyTo(file("copy-from-handle.txt"));
	log(
		"copy",
		JSON.stringify(await file("copy.txt").text()),
		JSON.stringify(await file("copy-from-handle.txt").text()),
	);
	await outcome("copy onto existing", () => notes.copyTo("copy.txt"));
	await file("data.json").copyTo("copy.txt", { overwrite: true });
	log("copy overwrite", await file("copy.txt").text());
	await file("atomic.txt").copyTo("copied-mode.txt");
	log(
		"copy keeps mode",
		((await file("copied-mode.txt").stat()).mode & 0o777).toString(8),
	);

	await file("copy.txt").moveTo("moved.txt");
	log("move", await file("copy.txt").exists(), await file("moved.txt").text());
	await file("moved.txt").moveTo(file("notes.txt"), { overwrite: true });
	log("move overwrite", await file("moved.txt").exists(), await file("notes.txt").text());
	await outcome("delete", () => file("copy-from-handle.txt").delete());
	log("deleted", await file("copy-from-handle.txt").exists());

	if (URL !== undefined) {
		log("url", file(new URL("file:///tmp/a%20b.txt")).path);
		await outcome("url scheme", () => file(new URL("https://example.com/")));
		await outcome("url host", () => file(new URL("file://server/share")));
		await outcome("url slash", () => file(new URL("file:///a%2Fb")));
	}
	for (const [label, value] of [
		["empty path", ""],
		["null byte", "a\0b"],
		["number", 42],
	]) {
		await outcome(label, () => file(value));
	}
	await directoryScenario(directory, URL, log, outcome);

	const contenders = Array.from({ length: 24 }, (_, i) => file(`contender-${i}.txt`));
	await Promise.all(contenders.map((handle) => handle.write(handle.path)));
	const shared = file("move-winner.txt");
	const moved = await Promise.all(
		contenders.map(async (handle) => {
			try {
				await handle.moveTo(shared);
				return handle.path;
			} catch (error) {
				if (!(error instanceof FileSystemError) || error.code !== "EEXIST") throw error;
				return undefined;
			}
		}),
	);
	const retained = await Promise.all(contenders.map((handle) => handle.exists()));
	const winners = moved.filter(Boolean);
	log(
		"exclusive concurrent moves",
		winners.length,
		retained.filter(Boolean).length,
		(await shared.text()) === winners[0],
	);
	await Promise.all(
		contenders.filter((_, index) => retained[index]).map((handle) => handle.delete()),
	);

	const large = "0123456789abcdef".repeat(LARGE / 16);
	log("large write", await file("large.txt").write(large, { atomic: true }));
	const largeText = await file("large.txt").text();
	const largeBytes = await file("large.txt").bytes();
	log(
		"large read",
		largeText.length,
		largeText === large,
		largeBytes.length,
		largeBytes[0],
		largeBytes[LARGE - 1],
	);
	log(
		"large binary",
		await file("large.bin").write(largeBytes),
		(await file("large.bin").text()) === large,
		(await file("large.bin").stat()).size,
	);

	const names = Array.from(
		{ length: 64 },
		(_, i) => `many/${String(i).padStart(2, "0")}.txt`,
	);
	const written = await Promise.all(
		names.map((name, i) => file(name).write("x".repeat(i), { createDirectories: true })),
	);
	const read = await Promise.all(names.map((name) => file(name).text()));
	log(
		"concurrent",
		written.reduce((sum, count) => sum + count, 0),
		read.every((text, i) => text === "x".repeat(i)),
	);
	await Promise.all(
		Array.from({ length: 32 }, () => file("shared.log").append("line\n")),
	);
	log("concurrent appends", (await file("shared.log").text()).split("\n").length - 1);
	await Promise.all(names.slice(0, 32).map((name) => file(name).delete()));
	const remaining = await Promise.all(names.map((name) => file(name).exists()));
	log("concurrent deletes", remaining.filter(Boolean).length);
	return lines;
}
