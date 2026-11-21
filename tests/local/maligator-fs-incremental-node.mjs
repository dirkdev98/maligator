import { appendFileSync, createReadStream } from "node:fs";
import * as fs from "node:fs/promises";

async function bytes(stream) {
	const result = [];
	for await (const chunk of stream) {
		for (const byte of chunk) result.push(byte);
	}
	return result;
}

async function readScenario() {
	const source = await fs.open("input.bin");
	try {
		const all = await bytes(source.readableWebStream({ autoClose: false }));
		const range = await bytes(
			createReadStream("input.bin", { start: 2, end: 7, highWaterMark: 4 }),
		);
		const pastEnd = await bytes(createReadStream("input.bin", { start: 100 }));
		let missing;
		try {
			await bytes(createReadStream("absent.bin"));
		} catch (error) {
			missing = ["FileSystemError", error.code, error.syscall, error.path];
		}
		return { all, range, pastEnd, missing };
	} finally {
		await source.close();
	}
}

async function writerScenario() {
	await fs.mkdir("out");
	const written = [];
	let flushed;
	{
		await using sink = await fs.open("out/part.txt", "w", 0o600);
		written.push((await sink.write("first")).bytesWritten);
		written.push((await sink.write(new Uint8Array([33]))).bytesWritten);
		await sink.sync();
		flushed = await fs.readFile("out/part.txt", "utf8");
		await fs.rename("out/part.txt", "out/result.txt");
		written.push((await sink.write(" second")).bytesWritten);
	}
	{
		await using sink = await fs.open("out/result.txt", "a");
		written.push((await sink.write(" third")).bytesWritten);
	}
	return {
		written,
		flushed,
		contents: await fs.readFile("out/result.txt", "utf8"),
		mode: (await fs.stat("out/result.txt")).mode & 0o777,
	};
}

async function watchScenario(recursive) {
	await fs.mkdir("watched/sub", { recursive: true });
	const prefix = recursive ? "watched/sub/" : "watched/";
	const source = prefix + "entry.txt";
	const destination = prefix + "renamed.txt";
	const existing = prefix + "existing.txt";
	await fs.writeFile(existing, "before");
	const events = fs.watch("watched", { recursive, signal: AbortSignal.timeout(5000) });
	async function observe(kind, expected, change) {
		let next = events.next();
		await change();
		for (;;) {
			const { done, value } = await next;
			if (done) throw new Error(`Node watch closed before ${kind} ${expected}`);
			const path = `watched/${value.filename}`;
			if (path === "watched/sub/ignored.txt")
				throw new Error("Shallow Node watch visited a subdirectory");
			const type = kind === "modify" ? "change" : "rename";
			// FSEvents can coalesce a write into the rename notification for its file.
			if (path === expected && (value.eventType === type || kind === "modify"))
				return { kind, path };
			next = events.next();
		}
	}
	try {
		// Node can start its OS subscription after next() returns. Wait for a
		// notification on a separate path before changing the files under test.
		const readiness = prefix + "ready.txt";
		const poke = () => appendFileSync(readiness, "+");
		const timer = setInterval(poke, 25);
		try {
			await observe("modify", readiness, poke);
		} finally {
			clearInterval(timer);
		}
		const created = await observe("create", source, async () => {
			if (!recursive) await fs.writeFile("watched/sub/ignored.txt", "ignored");
			await fs.writeFile(source, "open");
		});
		const modified = await observe("modify", existing, () =>
			fs.appendFile(existing, "+"),
		);
		const renamed = await observe("rename", destination, () =>
			fs.rename(source, destination),
		);
		const deleted = await observe("delete", destination, () => fs.unlink(destination));
		await events.return();
		return { created, modified, renamed, deleted, closed: (await events.next()).done };
	} finally {
		await events.return();
	}
}

async function abortScenario() {
	await fs.mkdir("watched");
	const controller = new AbortController();
	const events = fs.watch("watched", { signal: controller.signal });
	const pending = events.next();
	const reason = new Error("stop watching");
	controller.abort(reason);
	const isAborted = (error) => error.code === "ABORT_ERR" && error.cause === reason;
	const rejected = await pending.then(() => false, isAborted);
	const alreadyAborted = fs.watch("watched", { signal: controller.signal });
	const rejectedBeforeOpen = await alreadyAborted.next().then(() => false, isAborted);
	let missing;
	try {
		await fs.watch("absent").next();
	} catch (error) {
		missing = ["FileSystemError", error.code, error.syscall, error.path];
	}
	return { rejected, rejectedBeforeOpen, closed: (await events.next()).done, missing };
}

const scenarios = {
	read: readScenario,
	writer: writerScenario,
	watch: () => watchScenario(false),
	"watch-recursive": () => watchScenario(true),
	"watch-abort": abortScenario,
};
console.log(JSON.stringify(await scenarios[process.argv[2]]()));
