const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
const other = $262.createRealm().global;
function values(namespace, record, index) {
	const snapshot = namespace.values(record);
	return [snapshot[0], snapshot[index]];
}
function entries(namespace, record, index) {
	const snapshot = namespace.entries(record);
	return [snapshot[0], snapshot[index], snapshot[0] === snapshot[0]];
}
globalThis.observedRealmValues = values;
globalThis.observedRealmEntries = entries;
const rows = [];
for (const namespace of [Object, other.Object]) {
	const prototype = namespace === Object ? Array.prototype : other.Array.prototype;
	Object.defineProperty(prototype, "17", {
		configurable: true,
		get() {
			collectGarbage();
			return Object.getPrototypeOf(this) === prototype;
		},
	});
	try {
		let calls = 0;
		const retained = { marker: Symbol("retained") };
		const record = {
			get first() {
				calls++;
				collectGarbage();
				return retained;
			},
		};
		const value = globalThis.observedRealmValues(namespace, record, 17);
		const entry = globalThis.observedRealmEntries(namespace, record, 17);
		if (
			calls !== 2 ||
			value[0] !== retained ||
			!value[1] ||
			entry[0][0] !== "first" ||
			entry[0][1] !== retained ||
			!entry[1] ||
			!entry[2] ||
			Object.getPrototypeOf(entry[0]) !== prototype
		)
			throw new Error("captured enumeration realm");
		rows.push([calls, value[1], entry[1], entry[2]]);
		const original = new other.Error("getter");
		for (const read of [
			globalThis.observedRealmValues,
			globalThis.observedRealmEntries,
		]) {
			let thrown;
			try {
				read(
					namespace,
					{
						get first() {
							collectGarbage();
							throw original;
						},
					},
					17,
				);
			} catch (error) {
				thrown = error;
			}
			if (thrown !== original) throw new Error("foreign getter exception");
		}
	} finally {
		delete prototype[17];
	}
}
console.log(JSON.stringify(rows));
