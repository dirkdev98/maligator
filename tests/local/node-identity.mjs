import bufferDefault, { Buffer as ImportedBuffer } from "node:buffer";
import Events, { EventEmitter } from "node:events";
import Stream, {
	Duplex,
	Readable,
	Stream as NamedStream,
	Transform,
	Writable,
} from "node:stream";

const checks = [
	ImportedBuffer === Buffer,
	bufferDefault.Buffer === Buffer,
	globalThis.Buffer === Buffer,
	Object.getPrototypeOf(Buffer.alloc(1)) === Buffer.prototype,
	Stream === NamedStream,
	Stream.Stream === Stream,
	Stream.Readable === Readable,
	Stream.Writable === Writable,
	Stream.Duplex === Duplex,
	Stream.Transform === Transform,
	Object.getPrototypeOf(new Stream()) === Stream.prototype,
	Object.getPrototypeOf(new Readable()) === Readable.prototype,
	Object.getPrototypeOf(new Writable()) === Writable.prototype,
	Object.getPrototypeOf(new Duplex()) === Duplex.prototype,
	Object.getPrototypeOf(new Transform()) === Transform.prototype,
	Events === EventEmitter,
	Object.getPrototypeOf(Stream.prototype) === EventEmitter.prototype,
	__ownedBuffer instanceof Buffer,
	__ownedBuffer.toString() === "zlib",
];

console.log("RESULT " + checks.filter(Boolean).length + "/" + checks.length);
