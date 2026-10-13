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
function inspectCharAt(source, position) {
	const part = source.slice(1, 3);
	const result = part.charAt(position);
	gc?.();
	return [result, part.length];
}
function inspectAt(source, position) {
	const part = source.substring(1, 3);
	const result = part.at(position);
	gc?.();
	return [result, result === undefined, part.length];
}
for (const method of ["charAt", "at"]) {
	const local = String.prototype[method];
	const inspect = method === "charAt" ? inspectCharAt : inspectAt;
	String.prototype[method] = other.String.prototype[method];
	for (const position of [undefined, -2, -1, -0.5, 0, 1, 2, Infinity])
		rows.push(inspect("x😀z", position));
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
				String.prototype[method] = () => "override";
				gc?.();
				return -1;
			},
		}),
	);
	rows.push(inspect("x😀z", 0));
	String.prototype[method] = local;
}
console.log(JSON.stringify(rows));
