"use strict";
const foreign = $262.createRealm().global;
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
async function main() {
	const receiver = { factor: 3 };
	let calls = 0;
	const created = [];
	function mapper(value, index) {
		collectGarbage();
		if (this !== receiver || arguments.length !== 2)
			throw new Error("foreign mapper ABI");
		calls++;
		if (index === 0)
			for (let item = 0; item < 4; item++) created.push(Function(`return ${item + 10};`));
		return Promise.resolve(value * this.factor + index);
	}
	const promise = foreign.Array.fromAsync([2, 3, 4], mapper, receiver);
	if (Object.getPrototypeOf(promise) !== foreign.Promise.prototype)
		throw new Error("promise realm");
	const result = await promise;
	if (
		Object.getPrototypeOf(result) !== foreign.Array.prototype ||
		result.join(",") !== "6,10,14" ||
		calls !== 3 ||
		created[3]() !== 13
	)
		throw new Error("retained callback index/result realm");
	const interpreted = foreign.Function("value", "index", "return value + index;");
	const generic = await Array.fromAsync([7, 8], interpreted);
	if (generic.join(",") !== "7,9") throw new Error("eval callback fallback");
	console.log(
		"from-async-realms",
		calls,
		result.join(","),
		generic.join(","),
		created[3](),
	);
}
main().catch((error) => {
	console.log("FAIL", String(error));
});
