const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const foreign = $262.createRealm().global,
	rows = [];
function normalize(source, form, effect) {
	const part = source.slice(1, -1);
	return part.normalize(form, effect());
}
globalThis.normalizeRegion = normalize;
const saved = String.prototype.normalize;
String.prototype.normalize = foreign.String.prototype.normalize;
try {
	rows.push(globalThis.normalizeRegion("xe\u0301y", undefined, () => Symbol("ignored")));
	for (const [form, Expected] of [
		["bad", foreign.RangeError],
		[Symbol("bad"), foreign.TypeError],
		[
			{
				toString() {
					collectGarbage();
					return "bad";
				},
			},
			foreign.RangeError,
		],
	]) {
		try {
			globalThis.normalizeRegion("xy", form, () => 0);
			throw new Error("missing foreign error");
		} catch (e) {
			if (!(e instanceof Expected) || e instanceof RangeError || e instanceof TypeError)
				throw e;
			rows.push(e.name);
		}
	}
	rows.push(
		globalThis.normalizeRegion(
			"xéy",
			{
				toString() {
					String.prototype.normalize = () => "changed";
					collectGarbage();
					return "NFD";
				},
			},
			() => 0,
		),
	);
	rows.push(globalThis.normalizeRegion("xéy", "NFD", () => 0));
	String.prototype.normalize = foreign.String.prototype.normalize;
	const original = { original: true };
	try {
		globalThis.normalizeRegion(
			"xy",
			{
				toString() {
					collectGarbage();
					throw original;
				},
			},
			() => 0,
		);
		throw new Error("missing original");
	} catch (e) {
		if (e !== original) throw e;
		rows.push("original");
	}
} finally {
	String.prototype.normalize = saved;
}
console.log(JSON.stringify(rows));
