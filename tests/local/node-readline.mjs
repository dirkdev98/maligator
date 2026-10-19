import { once } from "node:events";
import readline, {
	clearLine,
	createInterface,
	cursorTo,
	moveCursor,
} from "node:readline";
import readlinePromises from "node:readline/promises";
import { PassThrough, Writable } from "node:stream";

const lines = [];
const show = (label, value) => lines.push(`${label} ${JSON.stringify(value)}`);

const input = new PassThrough();
const rl = createInterface({ input, crlfDelay: Infinity });
const seen = [];
rl.on("line", (line) => seen.push(line));
input.write("first\r\nsecond\nthird\rfourth");
input.write(Buffer.from([0x20, 0xc3]));
input.write(Buffer.from([0xa9, 0x0a]));
input.end("tail without newline");
await once(rl, "close");
show("lines", seen);
show("closed", [rl.closed, rl.terminal, rl.line, typeof rl.getPrompt()]);

const iterated = [];
const iterInput = new PassThrough();
const iterReader = createInterface({ input: iterInput });
setTimeout(() => iterInput.end("a\nb\n\nc"), 1);
for await (const line of iterReader) iterated.push(line);
show("async iterator", iterated);

const output = [];
const sink = new Writable({
	write(chunk, encoding, callback) {
		output.push(chunk.toString());
		callback();
	},
});
const questionInput = new PassThrough();
const asker = createInterface({ input: questionInput, output: sink, terminal: false });
const answer = new Promise((resolve) => asker.question("Name? ", resolve));
questionInput.write("Ada\n");
show("question", await answer);
asker.setPrompt("$ ");
asker.prompt();
const events = [];
asker.on("pause", () => events.push("pause")).on("resume", () => events.push("resume"));
asker.pause();
asker.resume();
asker.close();
show("output", output);
show("events", events);
try {
	asker.question("again?", () => {});
} catch (error) {
	show("after close", [error.code, error.message]);
}

const promiseInput = new PassThrough();
const promised = readlinePromises.createInterface({ input: promiseInput, output: sink });
const pending = promised.question("Promise? ");
promiseInput.write("yes\n");
show("promises question", await pending);
promised.close();
show("promises after close", await promised.question("x").catch((error) => error.code));

const written = [];
const stream = { write: (data) => (written.push(data), true) };
clearLine(stream, -1);
clearLine(stream, 1);
clearLine(stream, 0);
cursorTo(stream, 3);
cursorTo(stream, 3, 4);
moveCursor(stream, -2, 5);
moveCursor(stream, 0, 0);
readline.clearScreenDown(stream);
show("ansi", written);
try {
	cursorTo(stream, undefined, 2);
	show("cursorTo without x", "ignored");
} catch (error) {
	show("cursorTo without x", error.code);
}
show("module", [
	typeof readline.Interface,
	readline.promises === readlinePromises,
	typeof readline.emitKeypressEvents,
]);
console.log(lines.join("\n"));
