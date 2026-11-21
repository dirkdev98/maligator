import { directory, file, watch } from "maligator:fs";

async function bytes(stream) {
	const values = [];
	for await (const chunk of stream) {
		for (const byte of chunk) values.push(byte);
	}
	return values;
}

async function readScenario() {
	const source = file("input.bin");
	const all = await bytes(source.stream({ chunkSize: 3 }));
	const range = await bytes(source.stream({ start: 2, end: 7, chunkSize: 4 }));
	const pastEnd = await bytes(source.stream({ start: 100, chunkSize: 2 }));
	const missing = await sourceMissing();
	console.log(JSON.stringify({ all, range, pastEnd, missing }));
}

async function sourceMissing() {
	try {
		await file("absent.bin").stream().getReader().read();
	} catch (error) {
		return [error.name, error.code, error.syscall, error.path];
	}
}

async function cancelScenario() {
	const source = file("input.bin");
	let first;
	for (let index = 0; index < 64; index++) {
		const reader = source.stream({ chunkSize: 3 }).getReader();
		if (index % 2 === 0) {
			first = await reader.read();
			await reader.cancel();
		} else {
			const pending = reader.read();
			await reader.cancel();
			await pending;
		}
		if (!(await reader.read()).done) throw new Error("Cancelled reader is still open");
	}
	console.log(JSON.stringify(Array.from(first.value)));
}

async function sizeScenario() {
	const reader = file("input.bin").stream().getReader();
	let length = 0;
	let checksum = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.byteLength;
		for (let index = 0; index < value.length; index++) checksum += value[index];
	}
	console.log(JSON.stringify({ length, checksum }));
}

async function writerScenario() {
	const source = file("out/part.txt");
	const written = [];
	let flushed;
	{
		await using sink = source.writer({ createDirectories: true, mode: 0o600 });
		const first = sink.write("first");
		const second = sink.write(new Uint8Array([88, 33, 88]).subarray(1, 2));
		await sink.flush();
		written.push(await first, await second);
		flushed = await source.text();
		await source.moveTo("out/result.txt");
		written.push(await sink.write(" second"));
	}
	const destination = file("out/result.txt");
	const sink = destination.writer({ append: true });
	written.push(await sink.write(" third"));
	await sink.end();
	await sink.close();
	console.log(
		JSON.stringify({
			written,
			flushed,
			contents: await destination.text(),
			mode: (await destination.stat()).mode & 0o777,
		}),
	);
}

async function findChange(events, kind, path, after) {
	let next = events.next();
	await after();
	for (;;) {
		const result = await next;
		if (result.done) throw new Error(`Watch closed before ${kind} ${path}`);
		const change = result.value;
		if (change.path === "watched/sub/ignored.txt")
			throw new Error("Shallow watch visited a subdirectory");
		if (change.kind === kind && change.path === path) return change;
		next = events.next();
	}
}

async function watchScenario(recursive) {
	await directory("watched/sub").create({ recursive: true });
	const prefix = recursive ? "watched/sub/" : "watched/";
	const source = file(prefix + "entry.txt");
	const destination = file(prefix + "renamed.txt");
	const existing = file(prefix + "existing.txt");
	await existing.write("before");
	const events = watch("watched", { recursive });
	try {
		const created = await findChange(events, "create", source.path, async () => {
			if (!recursive) await file("watched/sub/ignored.txt").write("ignored");
			await source.write("open");
		});
		const modified = await findChange(events, "modify", existing.path, () =>
			existing.append("+"),
		);
		const renamed = await findChange(events, "rename", destination.path, () =>
			source.moveTo(destination),
		);
		const deleting = (async () => {
			for await (const change of events) {
				if (change.kind === "delete" && change.path === destination.path) return change;
			}
			throw new Error("Watch closed before deletion");
		})();
		await destination.delete();
		const deleted = await deleting;
		console.log(
			JSON.stringify({
				created,
				modified,
				renamed,
				deleted,
				closed: (await events.next()).done,
			}),
		);
	} finally {
		await events.return();
	}
}

async function abortScenario() {
	await directory("watched").create();
	const controller = new AbortController();
	const events = watch("watched", { signal: controller.signal });
	const pending = events.next();
	const reason = new Error("stop watching");
	controller.abort(reason);
	const rejected = await pending.then(
		() => false,
		(failure) => failure === reason,
	);
	const alreadyAborted = watch("absent", { signal: controller.signal });
	const rejectedBeforeOpen = await alreadyAborted.next().then(
		() => false,
		(failure) => failure === reason,
	);
	let missing;
	try {
		await watch("absent").next();
	} catch (error) {
		missing = [error.name, error.code, error.syscall, error.path];
	}
	console.log(
		JSON.stringify({
			rejected,
			rejectedBeforeOpen,
			closed: (await events.next()).done,
			missing,
		}),
	);
}

export async function incrementalScenario(name) {
	switch (name) {
		case "read":
			return readScenario();
		case "cancel":
			return cancelScenario();
		case "size":
			return sizeScenario();
		case "writer":
			return writerScenario();
		case "watch":
			return watchScenario(false);
		case "watch-recursive":
			return watchScenario(true);
		case "watch-abort":
			return abortScenario();
		default:
			throw new Error(`Unknown filesystem scenario: ${name}`);
	}
}
