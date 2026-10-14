const foreign = $262.createRealm().global;
const collect =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
function inspect(value, extra) {
	const part = value.toString(extra);
	collect();
	return [part.length, part, part];
}
function unwrap(value, extra) {
	const part = value.valueOf(extra);
	collect();
	return [part.length, part, part];
}
globalThis.identityForeignInspect = inspect;
globalThis.identityForeignUnwrap = unwrap;
const originalToString = String.prototype.toString,
	originalValueOf = String.prototype.valueOf;
const rows = [];
const ignored = new Proxy(
	{},
	{
		get() {
			throw Error("ignored argument inspected");
		},
	},
);
try {
	String.prototype.toString = foreign.String.prototype.toString;
	String.prototype.valueOf = foreign.String.prototype.valueOf;
	rows.push(
		inspect("primitive", ignored),
		unwrap("primitive", ignored),
		inspect(new foreign.String("wrapper"), ignored),
		unwrap(new foreign.String("wrapper"), ignored),
	);
	let errors = 0;
	for (const method of [inspect, unwrap])
		for (const value of [
			{
				toString: foreign.String.prototype.toString,
				valueOf: foreign.String.prototype.valueOf,
			},
			new Proxy(new foreign.String("x"), {}),
		])
			try {
				method(value, ignored);
			} catch (error) {
				if (Object.getPrototypeOf(error) !== foreign.TypeError.prototype)
					throw Error("wrong String brand error realm");
				errors++;
			}
	rows.push(errors);
} finally {
	String.prototype.toString = originalToString;
	String.prototype.valueOf = originalValueOf;
}
console.log(JSON.stringify(rows));
