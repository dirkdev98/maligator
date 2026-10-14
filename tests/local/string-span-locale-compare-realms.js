const foreign = $262.createRealm().global;
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
globalThis.compareRegion = function (source, that, locales, options, effect) {
	const part = source.slice(1, -1);
	return Math.sign(part.localeCompare(that, locales, options, effect()));
};
const original = String.prototype.localeCompare;
const marker = { marker: true };
let throws = 0;
const rows = [];
try {
	String.prototype.localeCompare = foreign.String.prototype.localeCompare;
	rows.push(
		globalThis.compareRegion("xéy", "e\u0301", "en", undefined, () => {
			collectGarbage();
		}),
	);
	for (const [that, locales, Expected] of [
		[Symbol(), undefined, foreign.TypeError],
		["", ["bad_tag"], foreign.RangeError],
	]) {
		try {
			globalThis.compareRegion("xy", that, locales, undefined, () => {});
		} catch (error) {
			if (
				!(error instanceof Expected) ||
				error instanceof TypeError ||
				error instanceof RangeError
			)
				throw new Error("wrong realm");
			throws++;
		}
	}
	try {
		globalThis.compareRegion(
			"xay",
			{
				toString() {
					collectGarbage();
					throw marker;
				},
			},
			undefined,
			undefined,
			() => {},
		);
	} catch (error) {
		if (error !== marker) throw error;
		throws++;
	}
	const locales = {
		get length() {
			String.prototype.localeCompare = function () {
				return 17;
			};
			collectGarbage();
			return 0;
		},
	};
	rows.push(globalThis.compareRegion("xay", "a", locales, undefined, () => {}));
	rows.push(globalThis.compareRegion("xay", "a", undefined, undefined, () => {}));
} finally {
	String.prototype.localeCompare = original;
}
if (throws !== 3) throw new Error("missing errors");
rows.push(throws);
console.log(JSON.stringify(rows));
