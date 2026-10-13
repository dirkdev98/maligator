const foreign = $262.createRealm().global;
const collectGarbage = globalThis.__mal_collect_garbage ?? $262.gc ?? (() => {});
function ownKeys(holder, record, key) {
	const snapshot = holder.ownKeys(record);
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
for (const holder of [Reflect, foreign.Reflect]) {
	const expected = holder === Reflect ? Array.prototype : foreign.Array.prototype;
	for (const record of [{ hidden: 1, [symbol]: 2 }, [1, 2]]) {
		if (ownKeys(holder, record, "snapshotRealm") !== expected)
			throw new Error("snapshot result realm");
	}
	let thrown;
	try {
		ownKeys(holder, "primitive", 0);
	} catch (error) {
		thrown = error;
	}
	const ErrorType = holder === Reflect ? TypeError : foreign.TypeError;
	if (!(thrown instanceof ErrorType)) throw new Error("primitive error realm");
}
console.log("reflect-key-realms 6");
