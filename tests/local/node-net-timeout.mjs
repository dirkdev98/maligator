import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, Socket } from "node:net";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function checkDetachedSocket() {
	const socket = new Socket();
	assert.throws(() => socket.setTimeout("10"), { code: "ERR_INVALID_ARG_TYPE" });
	assert.throws(() => socket.setTimeout(-1), { code: "ERR_OUT_OF_RANGE" });
	let fired = false;
	assert.equal(
		socket.setTimeout(25, () => {
			fired = true;
			assert.equal(socket.destroyed, false);
		}),
		socket,
	);
	assert.equal(socket.timeout, 25);
	await delay(100);
	assert.equal(fired, true);
	socket.destroy();
	assert.equal(socket.setTimeout(-1), socket);
}

async function checkActivity() {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const connected = once(server, "connection");
	const socket = new Socket();
	socket.connect(server.address().port, "127.0.0.1");
	const [peer] = await connected;
	try {
		let input = "";
		const idleInputs = [];
		socket.on("data", (chunk) => (input += chunk.toString()));
		socket.on("timeout", () => idleInputs.push(input));
		let callbacks = 0;
		const idled = once(socket, "timeout");
		socket.setTimeout(360, () => callbacks++);
		await delay(160);
		peer.write("first");
		await delay(160);
		peer.write("second");
		await delay(160);
		peer.write("third");
		await idled;
		assert.deepEqual(idleInputs, ["firstsecondthird"]);
		assert.equal(callbacks, 1);
		assert.equal(socket.destroyed, false);

		const secondIdle = once(socket, "timeout");
		const received = once(peer, "data");
		peer.resume();
		socket.write("still open");
		const [chunk] = await received;
		assert.equal(chunk.toString(), "still open");
		await secondIdle;
		assert.equal(callbacks, 1);

		const cancelled = () => assert.fail("cancelled timeout listener fired");
		socket.setTimeout(25, cancelled);
		assert.equal(socket.setTimeout(0, cancelled), socket);
		assert.equal(socket.listeners("timeout").includes(cancelled), false);
		const before = idleInputs.length;
		await delay(100);
		assert.equal(idleInputs.length, before);

		socket.setTimeout(25, cancelled);
		const closed = once(socket, "close");
		socket.destroy();
		await closed;
		await delay(100);
		assert.equal(idleInputs.length, before);
	} finally {
		socket.destroy();
		peer.destroy();
		await new Promise((resolve) => server.close(resolve));
	}
}

await checkDetachedSocket();
await checkActivity();
new Socket().setTimeout(60_000, () => assert.fail("idle timeout kept the process alive"));
console.log("NODE NET TIMEOUT PASS");
