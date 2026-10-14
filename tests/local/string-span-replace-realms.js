const collect =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const foreign = $262.createRealm().global,
	originals = [String.prototype.replace, String.prototype.replaceAll],
	rows = [];
function replaced(source, search, replacement) {
	const part = source.slice(1, -1);
	collect();
	return [part.replace(search, replacement), part.replaceAll(search, replacement)];
}
function replacedAll(source, search, replacement) {
	const part = source.slice(1, -1);
	collect();
	return part.replaceAll(search, replacement);
}
globalThis.realmReplacedAll = replacedAll;
globalThis.realmReplaced = replaced;
String.prototype.replace = foreign.String.prototype.replace;
String.prototype.replaceAll = foreign.String.prototype.replaceAll;
try {
	rows.push(globalThis.realmReplaced("LababaR", "a", "[$`][$&][$']"));
	rows.push(globalThis.realmReplaced("L1212R", 12, 12345678901234567890n));
	rows.push(globalThis.realmReplaced("LundefinedR", undefined, null));
	for (const method of ["replace", "replaceAll"]) {
		try {
			(method === "replace" ? globalThis.realmReplaced : globalThis.realmReplacedAll)(
				"LtextR",
				123,
				Symbol("replacement"),
			);
			throw new Error("missing foreign replacement error");
		} catch (e) {
			if (Object.getPrototypeOf(e) !== foreign.TypeError.prototype) throw e;
			rows.push("foreign replacement");
		}
		try {
			(method === "replace" ? globalThis.realmReplaced : globalThis.realmReplacedAll)(
				"LabR",
				Symbol("bad"),
				"!",
			);
			throw new Error("missing foreign error");
		} catch (e) {
			if (Object.getPrototypeOf(e) !== foreign.TypeError.prototype) throw e;
			rows.push("foreign");
		}
	}
	rows.push(
		globalThis.realmReplaced("LabaR", "a", function (match, index, source) {
			collect();
			return source + index + match;
		}),
	);
	const marker = { original: true };
	try {
		globalThis.realmReplaced("LabR", "a", {
			toString() {
				collect();
				throw marker;
			},
		});
		throw new Error("missing marker");
	} catch (e) {
		if (e !== marker) throw e;
		rows.push("original");
	}
} finally {
	String.prototype.replace = originals[0];
	String.prototype.replaceAll = originals[1];
}
console.log(JSON.stringify(rows));
