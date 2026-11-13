import assert from "node:assert/strict";
import { Readable } from "node:stream";
const selection = process.env.MAL_TEST_ITERABLE_BODY_CASE;
if (selection === "bytes") {
	const chunks = () =>
		Readable.from([
			"",
			new Uint8Array(0),
			"hello ",
			new Uint16Array([119, 111]),
			Buffer.from("rld"),
		]);
	const response = new Response(chunks());
	assert.equal(response.headers.get("content-type"), null);
	assert.ok(response.body instanceof ReadableStream);
	assert.equal(await response.text(), "hello world");
	assert.equal(response.bodyUsed, true);
	await assert.rejects(response.text(), TypeError);
	const request = new Request("http://example.test/", {
		method: "POST",
		body: chunks(),
		duplex: "half",
	});
	const clone = request.clone();
	assert.equal(await request.text(), "hello world");
	assert.equal(await clone.text(), "hello world");
	assert.throws(
		() => new Request("http://example.test/", { method: "POST", body: chunks() }),
		TypeError,
	);
	assert.throws(
		() =>
			new Request("http://example.test/", {
				method: "POST",
				body: chunks(),
				duplex: "half",
				mode: "no-cors",
			}),
		TypeError,
	);
	async function* iterable() {
		yield new Uint8Array(0);
		yield "first";
		yield Buffer.from("second");
	}
	const reader = new Response(iterable()).body.getReader();
	assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
	assert.equal(new TextDecoder().decode((await reader.read()).value), "second");
	assert.equal((await reader.read()).done, true);
	const marker = { arbitrary: true };
	assert.equal((await ReadableStream.from([marker]).getReader().read()).value, marker);
} else if (selection === "cancel") {
	let returned;
	let pulls = 0;
	let onReturned;
	const returnedPromise = new Promise((resolve) => {
		onReturned = resolve;
	});
	const source = {
		[Symbol.asyncIterator]() {
			return this;
		},
		async next() {
			pulls++;
			return { done: false, value: "chunk" };
		},
		async return(reason) {
			returned = reason;
			onReturned();
			return { done: true };
		},
	};
	const response = new Response(source);
	const reader = response.body.getReader();
	assert.equal(new TextDecoder().decode((await reader.read()).value), "chunk");
	const reason = new Error("fictional cancellation");
	await reader.cancel(reason);
	await returnedPromise;
	assert.equal(returned, reason);
	assert.ok(pulls < 10);
	let onDestroyed;
	const destroyed = new Promise((resolve) => {
		onDestroyed = resolve;
	});
	const node = new Readable({
		read() {
			this.push(Buffer.from("node chunk"));
		},
		destroy(error, callback) {
			onDestroyed();
			callback(error);
		},
	});
	node.on("error", () => {});
	const nodeReader = new Response(node).body.getReader();
	assert.equal(new TextDecoder().decode((await nodeReader.read()).value), "node chunk");
	await nodeReader.cancel();
	await destroyed;
	assert.equal(node.destroyed, true);
	let settleNext, startNext;
	const started = new Promise((resolve) => {
		startNext = resolve;
	});
	let nextCalls = 0;
	const pendingSource = {
		[Symbol.asyncIterator]() {
			return this;
		},
		next() {
			nextCalls++;
			startNext();
			return new Promise((resolve) => {
				settleNext = resolve;
			});
		},
		return() {
			return Promise.resolve({ done: true });
		},
	};
	const pendingReader = new Response(pendingSource).body.getReader();
	const pendingRead = pendingReader.read();
	await started;
	const cancel = pendingReader.cancel();
	settleNext({ done: false, value: new Uint8Array(0) });
	await cancel;
	await pendingRead;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(nextCalls, 1);
} else if (selection === "errors") {
	let finalized = false;
	async function* invalid() {
		try {
			yield 42;
		} finally {
			finalized = true;
		}
	}
	await assert.rejects(new Response(invalid()).text(), TypeError);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(finalized, true);
	const failure = new Error("fictional producer failure");
	async function* broken() {
		yield "partial";
		throw failure;
	}
	await assert.rejects(new Response(broken()).text(), (error) => error === failure);
	assert.throws(
		() =>
			new Response({
				locked: true,
				async *[Symbol.asyncIterator]() {
					yield "x";
				},
			}),
		TypeError,
	);
	const consumed = new Readable({ read() {} });
	consumed.push("used");
	assert.equal(consumed.read().toString(), "used");
	assert.equal(consumed.readableDidRead, true);
	assert.throws(() => new Response(consumed), TypeError);
	const aborted = new Readable({ read() {} });
	aborted.destroy();
	assert.equal(aborted.readableAborted, true);
	assert.throws(
		() =>
			new Request("http://example.test/", {
				method: "POST",
				body: aborted,
				duplex: "half",
			}),
		TypeError,
	);
} else throw new Error(`Unknown case: ${selection}`);
console.log("FETCH ITERABLE BODY PASS");
