const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const foreign = $262.createRealm().global,
	rows = [];
function region(source, locales, effect) {
	const part = source.slice(1, -1);
	return [
		part.toLocaleLowerCase(locales, effect()),
		part.toLocaleUpperCase(locales, effect()),
	];
}
globalThis.localeCaseRegion = region;
const lower = String.prototype.toLocaleLowerCase,
	upper = String.prototype.toLocaleUpperCase;
String.prototype.toLocaleLowerCase = foreign.String.prototype.toLocaleLowerCase;
String.prototype.toLocaleUpperCase = foreign.String.prototype.toLocaleUpperCase;
try {
	rows.push(
		globalThis.localeCaseRegion("xIİY", "tr", () => {
			collectGarbage();
			return Symbol("ignored");
		}),
	);
	for (const [locales, Expected] of [
		["bad_tag", foreign.RangeError],
		[null, foreign.TypeError],
		[[1], foreign.TypeError],
	]) {
		try {
			globalThis.localeCaseRegion("xy", locales, () => 0);
			throw new Error("missing foreign error");
		} catch (e) {
			if (!(e instanceof Expected) || e instanceof RangeError || e instanceof TypeError)
				throw e;
			rows.push(e.name);
		}
	}
	const original = { original: true };
	try {
		globalThis.localeCaseRegion(
			"xy",
			{
				get length() {
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
	let gets = 0;
	rows.push(
		globalThis.localeCaseRegion(
			"xIY",
			{
				get length() {
					if (gets++ === 0) String.prototype.toLocaleLowerCase = () => "changed lower";
					else String.prototype.toLocaleUpperCase = () => "changed upper";
					collectGarbage();
					return 1;
				},
				0: "tr",
			},
			() => 0,
		),
	);
	rows.push(globalThis.localeCaseRegion("xIY", "tr", () => 0));
} finally {
	String.prototype.toLocaleLowerCase = lower;
	String.prototype.toLocaleUpperCase = upper;
}
console.log(JSON.stringify(rows));
