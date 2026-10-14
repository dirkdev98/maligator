const collect =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const foreign = $262.createRealm().global,
	original = String.prototype.concat,
	rows = [];
function combined(source, a, b) {
	const part = source.slice(1, -1);
	collect();
	return part.concat(a, b);
}
globalThis.realmConcat = combined;
String.prototype.concat = foreign.String.prototype.concat;
try {
	rows.push(globalThis.realmConcat("xaby", "é", 1n));
	try {
		globalThis.realmConcat("xaby", Symbol("bad"), "!");
		throw new Error("missing foreign error");
	} catch (e) {
		if (Object.getPrototypeOf(e) !== foreign.TypeError.prototype) throw e;
		rows.push("foreign");
	}
	rows.push(
		globalThis.realmConcat(
			"xaby",
			{
				toString() {
					String.prototype.concat = () => {
						throw new Error("wrong captured method");
					};
					collect();
					return "captured";
				},
			},
			"!",
		),
	);
	String.prototype.concat = foreign.String.prototype.concat;
	const marker = { original: true };
	try {
		globalThis.realmConcat(
			"xaby",
			{
				toString() {
					collect();
					throw marker;
				},
			},
			"!",
		);
		throw new Error("missing original");
	} catch (e) {
		if (e !== marker) throw e;
		rows.push("original");
	}
} finally {
	String.prototype.concat = original;
}
console.log(JSON.stringify(rows));
