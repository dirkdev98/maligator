const gc = globalThis.__mal_collect_garbage;
const other = $262.createRealm().global;
const saved = String.prototype.codePointAt;
const rows = [];
function inspect(source, position) {
	const part = source.substring(1, 3);
	gc?.();
	return [part.codePointAt(position), part.length];
}
String.prototype.codePointAt = other.String.prototype.codePointAt;
rows.push(["x😀z", "xabz", "x12z"].map(inspect));
for (const position of [Symbol("position"), 1n]) {
	try {
		inspect("x😀z", position);
	} catch (error) {
		rows.push(error instanceof other.TypeError, error instanceof TypeError);
	}
}
try {
	inspect("x😀z", {
		valueOf() {
			gc?.();
			throw new RangeError("local coercion");
		},
	});
} catch (error) {
	rows.push(error instanceof other.RangeError, error instanceof RangeError);
}
rows.push(
	inspect("x😀z", {
		valueOf() {
			String.prototype.codePointAt = String.prototype.charCodeAt;
			gc?.();
			return 0;
		},
	}),
);
rows.push(inspect("x😀z", 0));
String.prototype.codePointAt = saved;
console.log(JSON.stringify(rows));
