const Stream = require("node:stream");
const Events = require("events");
const buffer = require("node:buffer");

const checks = [
	require("stream") === Stream,
	require("node:events") === Events,
	require("buffer") === buffer,
	buffer.Buffer === Buffer,
	globalThis.Buffer === Buffer,
	Object.getPrototypeOf(Buffer.alloc(1)) === Buffer.prototype,
	Stream === Stream.Stream,
	Object.getPrototypeOf(new Stream()) === Stream.prototype,
	Object.getPrototypeOf(new Stream.Readable()) === Stream.Readable.prototype,
	Object.getPrototypeOf(new Stream.Writable()) === Stream.Writable.prototype,
	Object.getPrototypeOf(new Stream.Duplex()) === Stream.Duplex.prototype,
	Object.getPrototypeOf(new Stream.Transform()) === Stream.Transform.prototype,
	Object.getPrototypeOf(Stream.prototype) === Events.prototype,
	__ownedBuffer instanceof Buffer,
	__ownedBuffer.toString() === "zlib",
];

console.log("RESULT " + checks.filter(Boolean).length + "/" + checks.length);
