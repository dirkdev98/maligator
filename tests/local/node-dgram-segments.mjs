import { createSocket } from "node:dgram";
import { once } from "node:events";

const mode = process.env.MAL_DGRAM_CASE ?? "many";
const count = Number(process.env.MAL_DGRAM_SEGMENTS ?? 65);
const server = createSocket("udp4");
const client = createSocket("udp4");
server.bind(0, "127.0.0.1");
await once(server, "listening");
client.bind(0, "127.0.0.1");
await once(client, "listening");

function check(value, message) {
	if (!value) throw new Error(message);
}
async function transmit(socket, parts, address = "127.0.0.1") {
	const received = once(server, "message");
	const sent = new Promise((resolve, reject) =>
		socket.send(parts, server.address().port, address, (error) =>
			error ? reject(error) : resolve(),
		),
	);
	const [[message]] = await Promise.all([received, sent]);
	return message;
}
function expectedBytes(length) {
	return Array.from({ length }, (_, index) => index % 251);
}
function assertBytes(message, expected) {
	check(
		message.toString("hex") === Buffer.from(expected).toString("hex"),
		"all datagram bytes survive",
	);
}
try {
	if (mode === "many") {
		const expected = expectedBytes(count);
		const parts = expected.map((byte) => Buffer.from([byte]));
		assertBytes(await transmit(client, parts), expected);
	} else if (mode === "getters") {
		const expected = expectedBytes(100);
		const parts = new Array(expected.length);
		let getters = 0;
		for (let index = 0; index < expected.length; index++)
			Object.defineProperty(parts, index, {
				get() {
					getters++;
					return new Uint8Array([expected[index]]);
				},
			});
		assertBytes(await transmit(client, parts), expected);
		check(
			getters === expected.length,
			"each getter runs once and its temporary view survives",
		);
	} else if (mode === "resize" || mode === "detach") {
		const storage = new ArrayBuffer(4, { maxByteLength: 8 });
		const first = new Uint8Array(storage);
		first.set([97, 98, 99, 100]);
		const parts = [first];
		Object.defineProperty(parts, 1, {
			get() {
				if (mode === "resize") storage.resize(2);
				else structuredClone(storage, { transfer: [storage] });
				return Buffer.from("z");
			},
		});
		assertBytes(await transmit(client, parts), [122]);
	} else if (mode === "grow") {
		const storage = new ArrayBuffer(2, { maxByteLength: 8 });
		const first = new Uint8Array(storage);
		first.set([97, 98]);
		const parts = [first];
		Object.defineProperty(parts, 1, {
			get() {
				storage.resize(4);
				first[2] = 99;
				first[3] = 100;
				return Buffer.from("z");
			},
		});
		assertBytes(await transmit(client, parts), [97, 98, 122]);
	} else if (mode === "close") {
		const unbound = createSocket("udp4");
		const closed = once(unbound, "close");
		const parts = [Buffer.from("a")];
		Object.defineProperty(parts, 1, {
			get() {
				unbound.close();
				return Buffer.from("b");
			},
		});
		let error;
		try {
			unbound.send(parts, server.address().port, "127.0.0.1");
		} catch (caught) {
			error = caught;
		}
		check(
			error?.code === "ERR_SOCKET_DGRAM_NOT_RUNNING",
			"a getter may close an unbound socket",
		);
		await closed;
	} else if (mode === "queued") {
		const named = createSocket("udp4");
		named.bind(0, "127.1");
		try {
			let getters = 0;
			const parts = [Buffer.from("a")];
			Object.defineProperty(parts, 1, {
				get() {
					getters++;
					return new Uint8Array([98]);
				},
			});
			assertBytes(await transmit(named, parts), [97, 98]);
			check(getters === 1, "a send queued during named bind retains its normalized list");
		} finally {
			named.close();
		}
	} else throw new Error("unknown datagram case");
	console.log("datagram segments PASS");
} finally {
	client.close();
	server.close();
}
