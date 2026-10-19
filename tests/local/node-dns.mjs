import dns from "node:dns";
import dnsPromises from "node:dns/promises";

const lines = [];
const show = (label, value) => lines.push(`${label} ${JSON.stringify(value)}`);
const errorShape = (error) => [error.name, error.code, error.message];
const lookup = (...args) =>
	new Promise((resolve) =>
		dns.lookup(...args, (error, address, family) =>
			resolve(error ? errorShape(error) : [address, family]),
		),
	);

show("localhost v4", await lookup("localhost", 4));
show("localhost v4 all", await lookup("localhost", { family: "IPv4", all: true }));
show("ip literal", await lookup("::1"));
show("ip literal all", await lookup("10.0.0.1", { all: true }));
let syncAfterCall = "pending";
dns.lookup("127.0.0.1", () => show("literal callback runs later", syncAfterCall));
syncAfterCall = "sync code finished first";
await new Promise((resolve) => setTimeout(resolve, 10));
show("unresolvable", await lookup("maligator-test.invalid"));
for (const run of [
	() => dns.lookup("localhost", 5, () => {}),
	() => dns.lookup("localhost", { family: 7 }, () => {}),
	() => dns.lookup("localhost", { all: "yes" }, () => {}),
	() => dns.lookup("localhost", { order: "random" }, () => {}),
	() => dns.lookup("localhost", "x", () => {}),
	() => dns.lookup("localhost"),
	() => dns.lookup("", () => {}),
	() => dns.lookup(42, () => {}),
	() => dns.lookupService("not an ip", 80, () => {}),
	() => dns.setDefaultResultOrder("sideways"),
]) {
	try {
		run();
		show("no throw", true);
	} catch (error) {
		show("throws", errorShape(error));
	}
}
show("promises.lookup", await dnsPromises.lookup("localhost", 4));
show(
	"promises.lookup all",
	await dnsPromises.lookup("localhost", { all: true, family: 4 }),
);
show("dns.promises", dns.promises === dnsPromises);
show(
	"promise rejection",
	await dnsPromises.lookup("maligator-test.invalid").catch(errorShape),
);
show(
	"lookupService",
	await dnsPromises.lookupService("127.0.0.1", 0).then((value) => Object.keys(value)),
);
show("result order", dns.getDefaultResultOrder());
dns.setDefaultResultOrder("ipv4first");
show("result order set", dns.getDefaultResultOrder());
dns.setDefaultResultOrder("verbatim");
show("servers", Array.isArray(dns.getServers()));
show("constants", [
	typeof dns.ADDRCONFIG,
	dns.NOTFOUND,
	dns.CANCELLED,
	typeof dns.Resolver,
	typeof new dns.Resolver().resolve4,
]);
console.log(lines.join("\n"));
