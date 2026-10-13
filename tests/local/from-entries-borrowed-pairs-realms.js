const foreign = $262.createRealm().global;
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const key = {
	toString() {
		collectGarbage();
		return "local";
	},
};
const result = foreign.Object.fromEntries(new Map([[key, { marker: 8 }]]));
const local = Object.fromEntries(new foreign.Map([["foreign", 9]]));
const entries = foreign.Array.prototype.entries.call([10, 11]);
const foreignArray = foreign.Object.fromEntries(entries);
if (
	Object.getPrototypeOf(result) !== foreign.Object.prototype ||
	result.local.marker !== 8 ||
	Object.getPrototypeOf(local) !== Object.prototype ||
	local.foreign !== 9 ||
	Object.getPrototypeOf(foreignArray) !== foreign.Object.prototype ||
	foreignArray[1] !== 11
)
	throw new Error("fromEntries realm");
console.log(
	"from-entries-realms",
	result.local.marker,
	local.foreign,
	foreignArray[0],
	foreignArray[1],
);
