// Array.isArray answers arrays and non-objects inline; proxies take the builtin,
// which unwraps nested proxies and rejects a revoked one.
function count(values) {
	let arrays = 0;
	for (const value of values) if (Array.isArray(value)) arrays++;
	return arrays;
}
const values = [
	[1],
	[],
	"text",
	{ length: 1 },
	new Proxy([], {}),
	new Proxy(new Proxy([], {}), {}),
	new Proxy({}, {}),
	null,
	undefined,
	3,
	Object.create(Array.prototype),
	new (class extends Array {})(),
];
const { proxy, revoke } = Proxy.revocable([], {});
const log = [count(values), count(values), Array.isArray(), Array.isArray(proxy)];
revoke();
try {
	Array.isArray(proxy);
} catch (error) {
	log.push(`${error.constructor.name}: ${error.message.includes("revoked")}`);
}
console.log(log.join("\n"));
