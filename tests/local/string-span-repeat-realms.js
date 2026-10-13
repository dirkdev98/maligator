const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const foreign = $262.createRealm().global;
const rows = [],
	events = [];
function repeated(source, count) {
	const part = source.slice(1, -1);
	collectGarbage();
	return part.repeat(count);
}
globalThis.realmRepeat = repeated;
const original = String.prototype.repeat;
String.prototype.repeat = foreign.String.prototype.repeat;
try {
	rows.push(
		globalThis.realmRepeat("xaby", 0),
		globalThis.realmRepeat("xaby", 1),
		globalThis.realmRepeat("xaby", 2),
	);
	for (const value of [-1, Infinity, 1n, Symbol("bad")]) {
		try {
			globalThis.realmRepeat("xaby", value);
			throw new Error("missing foreign error");
		} catch (error) {
			const prototype =
				typeof value === "number" ? foreign.RangeError : foreign.TypeError;
			rows.push(
				error instanceof prototype,
				error instanceof RangeError,
				error instanceof TypeError,
			);
			if (!(error instanceof prototype)) throw error;
		}
	}
	try {
		globalThis.realmRepeat("xaby", {
			valueOf() {
				events.push("valueOf");
				String.prototype.repeat = () => "changed";
				collectGarbage();
				return -1;
			},
		});
		throw new Error("missing captured error");
	} catch (error) {
		if (!(error instanceof foreign.RangeError)) throw error;
		rows.push("captured foreign");
	}
	String.prototype.repeat = foreign.String.prototype.repeat;
	const marker = new Error("original");
	try {
		globalThis.realmRepeat("xaby", {
			valueOf() {
				collectGarbage();
				throw marker;
			},
		});
	} catch (error) {
		if (error !== marker) throw error;
		rows.push("original");
	}
} finally {
	String.prototype.repeat = original;
}
console.log(JSON.stringify([rows, events]));
