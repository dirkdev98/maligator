import {
	EventEmitter,
	addAbortListener,
	getMaxListeners,
	on,
	setMaxListeners,
} from "node:events";
import * as fs from "node:fs";
// Node 26 APIs that popular packages probe or call directly.
import * as os from "node:os";
import * as path from "node:path";

const lines = [];
const show = (label, value) => lines.push(`${label} ${JSON.stringify(value)}`);

show("version", [
	process.version.startsWith("v26."),
	process.versions.node === process.version.slice(1),
]);
show("release", process.release.name);
show("execArgv", process.execArgv);
show("features", [typeof process.features.uv, process.features.require_module]);
show("identity", [
	process.getuid() >= 0,
	process.geteuid() >= 0,
	process.getgid() >= 0,
	process.getegid() >= 0,
	Array.isArray(process.getgroups()),
]);
show("ppid", [typeof process.ppid, process.ppid > 0, typeof process.argv0]);

const start = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "node-compat-"));
process.chdir(scratch);
show("chdir", fs.realpathSync(process.cwd()) === fs.realpathSync(scratch));
try {
	process.chdir(path.join(scratch, "missing"));
} catch (error) {
	show("chdir error", [
		error.code,
		error.syscall,
		error.errno < 0,
		typeof error.path,
		error.dest === path.join(scratch, "missing"),
		error.message.startsWith("ENOENT: no such file or directory, chdir '"),
	]);
}
try {
	process.chdir(42);
} catch (error) {
	show("chdir type", [error.code, error.name]);
}
process.chdir(start);
fs.rmSync(scratch, { recursive: true });

const emitter = new EventEmitter();
show("defaultMaxListeners", [EventEmitter.defaultMaxListeners, getMaxListeners(emitter)]);
EventEmitter.defaultMaxListeners = 15;
show("defaultMaxListeners set", [
	EventEmitter.defaultMaxListeners,
	emitter.getMaxListeners(),
]);
EventEmitter.defaultMaxListeners = 10;
setMaxListeners(3, emitter);
show("setMaxListeners", getMaxListeners(emitter));
const controller = new AbortController();
setMaxListeners(20, controller.signal);
show("signal max", typeof getMaxListeners(controller.signal));

const order = [];
const disposable = addAbortListener(controller.signal, () => order.push("aborted"));
show("disposable", typeof disposable[Symbol.dispose]);
controller.abort();
const early = AbortSignal.abort();
addAbortListener(early, () => order.push("early"));
await Promise.resolve();
show("abort listeners", order);

const source = new EventEmitter();
setTimeout(() => {
	source.emit("data", 1, "a");
	source.emit("data", 2);
	source.emit("end");
}, 1);
const received = [];
for await (const args of on(source, "data")) {
	received.push(args);
	if (received.length === 2) break;
}
show("on", [received, source.listenerCount("data"), source.listenerCount("error")]);

const failing = new EventEmitter();
setTimeout(() => failing.emit("error", new Error("boom")), 1);
try {
	for await (const value of on(failing, "data")) received.push(value);
} catch (error) {
	show("on error", error.message);
}
const stop = new AbortController();
const aborting = new EventEmitter();
setTimeout(() => stop.abort(), 1);
try {
	for await (const value of on(aborting, "tick", { signal: stop.signal }))
		received.push(value);
} catch (error) {
	show("on abort", [error.name, error.code]);
}

console.log(lines.join("\n"));
