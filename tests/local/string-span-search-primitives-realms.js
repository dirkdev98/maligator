const collect =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const foreign = $262.createRealm().global,
	methods = ["indexOf", "lastIndexOf", "includes", "startsWith", "endsWith"],
	originals = methods.map((name) => String.prototype[name]),
	rows = [];
function index(source, needle, position) {
	const part = source.slice(1, -1);
	collect();
	return part.indexOf(needle, position);
}
function last(source, needle, position) {
	const part = source.slice(1, -1);
	collect();
	return part.lastIndexOf(needle, position);
}
function includes(source, needle, position) {
	const part = source.slice(1, -1);
	collect();
	return part.includes(needle, position);
}
function starts(source, needle, position) {
	const part = source.slice(1, -1);
	collect();
	return part.startsWith(needle, position);
}
function ends(source, needle, position) {
	const part = source.slice(1, -1);
	collect();
	return part.endsWith(needle, position);
}
const probes = [index, last, includes, starts, ends];
globalThis.foreignSearchProbes = probes;
for (const method of methods) String.prototype[method] = foreign.String.prototype[method];
try {
	for (const probe of globalThis.foreignSearchProbes) {
		rows.push(probe("L12345678901234567890R", 12345678901234567890n, undefined));
		for (const [needle, position] of [
			[Symbol("needle"), 0],
			[1, Symbol("position")],
			[1, 0n],
		]) {
			try {
				probe("L12R", needle, position);
				throw new Error("missing foreign error");
			} catch (e) {
				if (Object.getPrototypeOf(e) !== foreign.TypeError.prototype) throw e;
				rows.push("foreign");
			}
		}
		const marker = { original: true };
		try {
			probe(
				"L12R",
				{
					toString() {
						collect();
						throw marker;
					},
				},
				0,
			);
			throw new Error("missing marker");
		} catch (e) {
			if (e !== marker) throw e;
			rows.push("original");
		}
	}
} finally {
	for (let i = 0; i < methods.length; i++) String.prototype[methods[i]] = originals[i];
}
console.log(JSON.stringify(rows));
