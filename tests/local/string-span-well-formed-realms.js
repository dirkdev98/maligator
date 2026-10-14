const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const foreign = $262.createRealm().global,
	rows = [];
function region(source, effect) {
	const part = source.slice(1, -1);
	return [part.isWellFormed(effect()), part.toWellFormed(effect())];
}
globalThis.wellFormedRegion = region;
const check = String.prototype.isWellFormed,
	repair = String.prototype.toWellFormed;
String.prototype.isWellFormed = foreign.String.prototype.isWellFormed;
String.prototype.toWellFormed = foreign.String.prototype.toWellFormed;
try {
	rows.push(
		globalThis.wellFormedRegion("X\ud800Y", () => {
			collectGarbage();
			return Symbol("ignored");
		}),
	);
	for (const method of ["isWellFormed", "toWellFormed"]) {
		try {
			foreign.String.prototype[method].call({
				[Symbol.toPrimitive]() {
					collectGarbage();
					return Symbol("bad");
				},
			});
			throw new Error("missing foreign error");
		} catch (e) {
			if (!(e instanceof foreign.TypeError) || e instanceof TypeError) throw e;
			rows.push(e.name);
		}
	}
	let calls = 0;
	rows.push(
		globalThis.wellFormedRegion("X\ud800Y", () => {
			if (calls++ === 0) String.prototype.isWellFormed = () => "changed check";
			else String.prototype.toWellFormed = () => "changed repair";
			collectGarbage();
		}),
	);
	rows.push(globalThis.wellFormedRegion("X\ud800Y", () => 0));
} finally {
	String.prototype.isWellFormed = check;
	String.prototype.toWellFormed = repair;
}
console.log(JSON.stringify(rows));
