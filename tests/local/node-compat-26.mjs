import events, {
	EventEmitter,
	addAbortListener,
	captureRejectionSymbol,
	getEventListeners,
	getMaxListeners,
	on,
	setMaxListeners,
} from "node:events";
import * as fs from "node:fs";
import { maxHeaderSize, setMaxIdleHTTPParsers } from "node:http";
// Node 26 APIs that popular packages probe or call directly.
import * as os from "node:os";
import * as path from "node:path";
import { cpuUsage, uptime, version } from "node:process";
import { domainToASCII, domainToUnicode } from "node:url";
import {
	getHeapSpaceStatistics,
	getHeapStatistics,
	isStringOneByteRepresentation,
	startupSnapshot,
} from "node:v8";
import { isInternalThread, resourceLimits, threadName } from "node:worker_threads";

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

show("process named", [version === process.version, typeof cpuUsage, typeof uptime]);
show("uptime", [typeof process.uptime(), process.uptime() >= 0]);
const usage = process.cpuUsage();
show("cpuUsage", [Object.keys(usage), process.cpuUsage(usage).user >= 0]);
show("threadCpuUsage", Object.keys(process.threadCpuUsage()));
show("resourceUsage", Object.keys(process.resourceUsage()));
show("memory", [typeof process.availableMemory(), process.constrainedMemory() >= 0]);
show("legacy", [
	process.debugPort,
	process.domain,
	Array.isArray(process.moduleLoadList),
	process.allowedNodeEnvironmentFlags instanceof Set,
	typeof process.config.variables,
]);
show("sourceMaps", process.sourceMapsEnabled);
process.setSourceMapsEnabled(true);
show("sourceMaps set", process.sourceMapsEnabled);
process.setSourceMapsEnabled(false);
const refs = [];
process.ref({ ref: () => refs.push("ref") });
process.unref({
	[Symbol.for("nodejs.unref")]: () => refs.push("symbol"),
	unref: () => refs.push("plain"),
});
show("ref", refs);
try {
	process.setuid({});
} catch (error) {
	show("setuid type", [error.code, error.message]);
}
try {
	process.chdir(5);
} catch (error) {
	show("chdir message", error.message);
}
show("capture", process.hasUncaughtExceptionCaptureCallback());

const listened = new EventEmitter();
const listener = () => {};
listened.on("x", listener);
const target = new EventTarget();
target.addEventListener("y", listener);
show("getEventListeners", [
	getEventListeners(listened, "x").length,
	getEventListeners(target, "y")[0] === listener,
	getEventListeners(target, "z").length,
]);
show("events statics", [
	captureRejectionSymbol === Symbol.for("nodejs.rejection"),
	events.captureRejections,
	events.usingDomains,
	typeof events.init,
]);
function Legacy() {
	EventEmitter.init.call(this);
}
Object.setPrototypeOf(Legacy.prototype, EventEmitter.prototype);
const legacy = new Legacy();
legacy.on("ping", () => refs.push("pinged"));
legacy.emit("ping");
show("init", refs.at(-1));
try {
	getEventListeners({}, "x");
} catch (error) {
	show("getEventListeners type", [error.code, error.message]);
}

show("worker_threads", [isInternalThread, threadName, resourceLimits]);
const heap = getHeapStatistics();
show("v8 heap", [
	Object.keys(heap),
	heap.used_heap_size > 0,
	heap.heap_size_limit > heap.used_heap_size,
]);
show("v8 spaces", Object.keys(getHeapSpaceStatistics()[0]));
show("v8 one byte", [
	isStringOneByteRepresentation("abc"),
	isStringOneByteRepresentation("\u20ac"),
]);
show("v8 snapshot", startupSnapshot.isBuildingSnapshot());
try {
	startupSnapshot.addSerializeCallback(() => {});
} catch (error) {
	show("v8 snapshot error", error.code);
}
show(
	"domainToASCII",
	["español.com", "xn--iñvalid.com", "EXAMPLE.org", "", "a..b", "1.2.3.4"].map(
		domainToASCII,
	),
);
show(
	"domainToUnicode",
	["xn--espaol-zwa.com", "xn--iñvalid.com", "example.org", 42].map(domainToUnicode),
);
try {
	domainToASCII();
} catch (error) {
	show("domainToASCII missing", [error.code, error.message]);
}
show("http", [maxHeaderSize, setMaxIdleHTTPParsers(4)]);
try {
	setMaxIdleHTTPParsers(0);
} catch (error) {
	show("http parsers", [error.code, error.message]);
}
console.log(lines.join("\n"));
