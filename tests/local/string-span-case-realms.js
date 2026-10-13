const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const foreign = $262.createRealm().global,
	rows = [];
function lower(source, effect) {
	const part = source.slice(1, -1);
	return part.toLowerCase(effect());
}
function upper(source, effect) {
	const part = source.slice(1, -1);
	return part.toUpperCase(effect());
}
globalThis.caseLower = lower;
globalThis.caseUpper = upper;
for (const [name, invoke] of [
	["toLowerCase", globalThis.caseLower],
	["toUpperCase", globalThis.caseUpper],
]) {
	const saved = String.prototype[name];
	String.prototype[name] = foreign.String.prototype[name];
	try {
		rows.push(
			invoke("AΑΣA", () => Symbol("ignored")),
			invoke("AµßÿA", () => {
				collectGarbage();
				return 1n;
			}),
		);
		rows.push(
			invoke("xAbY", () => {
				String.prototype[name] = () => "replaced";
				collectGarbage();
			}),
		);
		rows.push(invoke("xAbY", () => 0));
		const value = {};
		Object.defineProperty(value, name, { value: foreign.String.prototype[name] });
		value[Symbol.toPrimitive] = () => {
			collectGarbage();
			return Symbol("bad");
		};
		try {
			invoke(
				{
					slice() {
						return value;
					},
				},
				() => 0,
			);
			throw new Error("missing foreign TypeError");
		} catch (e) {
			if (!(e instanceof foreign.TypeError) || e instanceof TypeError) throw e;
			rows.push("foreign TypeError");
		}
	} finally {
		String.prototype[name] = saved;
	}
}
console.log(JSON.stringify(rows));
