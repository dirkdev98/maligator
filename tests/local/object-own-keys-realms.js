const foreign = $262.createRealm().global;
const collectGarbage = globalThis.__mal_collect_garbage ?? $262.gc ?? (() => {});
function names(holder, record, key) {
	const snapshot = holder.getOwnPropertyNames(record);
	collectGarbage();
	return snapshot[key];
}
function symbols(holder, record, key) {
	const snapshot = holder.getOwnPropertySymbols(record);
	collectGarbage();
	return snapshot[key];
}
Object.defineProperty(Array.prototype, "snapshotRealm", {
	get() {
		return Object.getPrototypeOf(this);
	},
});
Object.defineProperty(foreign.Array.prototype, "snapshotRealm", {
	get() {
		return Object.getPrototypeOf(this);
	},
});
const symbol = Symbol("held");
for (const holder of [Object, foreign.Object]) {
	const expected = holder === Object ? Array.prototype : foreign.Array.prototype;
	for (const record of [{ hidden: 1, [symbol]: 2 }, [1, 2]]) {
		if (
			names(holder, record, "snapshotRealm") !== expected ||
			symbols(holder, record, "snapshotRealm") !== expected
		)
			throw new Error("snapshot result realm");
	}
}
console.log("own-key-realms 8");
