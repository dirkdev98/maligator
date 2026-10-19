import os, { constants, getPriority, networkInterfaces, setPriority } from "node:os";

const lines = [];
const show = (label, value) => lines.push(`${label} ${JSON.stringify(value)}`);
const interfaces = networkInterfaces();
const loopback = Object.values(interfaces)
	.flat()
	.filter((entry) => entry.internal && entry.family === "IPv4");
show(
	"loopback",
	loopback.map(({ address, netmask, family, mac, internal, cidr }) => ({
		address,
		netmask,
		family,
		mac,
		internal,
		cidr,
	})),
);
show(
	"interface shape",
	Object.values(interfaces).every((list) =>
		list.every(
			(entry) =>
				typeof entry.address === "string" &&
				(entry.family === "IPv6") === "scopeid" in entry,
		),
	),
);
show("priority", [typeof getPriority(), getPriority(0) === getPriority()]);
setPriority(getPriority());
for (const run of [
	() => getPriority(2 ** 31 - 1),
	() => setPriority(30),
	() => getPriority("1"),
]) {
	try {
		run();
	} catch (error) {
		show("error", [error.name, error.code, error.message, error.info?.syscall]);
	}
}
show("constants", [
	Object.keys(constants),
	Object.getPrototypeOf(constants.errno),
	constants.priority,
	constants.UV_UDP_REUSEADDR,
	typeof constants.dlopen.RTLD_NOW,
]);
show("errno", [
	constants.errno.ENOENT,
	constants.errno.EACCES,
	constants.errno.EWOULDBLOCK === constants.errno.EAGAIN,
]);
show("signals", [
	constants.signals.SIGINT,
	constants.signals.SIGTERM,
	Object.getPrototypeOf(constants.signals),
]);
show("default", os.networkInterfaces === networkInterfaces);
console.log(lines.join("\n"));
