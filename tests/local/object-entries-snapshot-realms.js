function inspect(namespace, record, index, prototype) {
	const entries = namespace.entries(record);
	const first = entries[0];
	const observed = entries[index];
	return [
		Object.getPrototypeOf(first) === prototype,
		observed,
		first === entries[0],
		entries.length,
	];
}
const other = $262.createRealm().global;
const rows = [];
Object.defineProperty(Array.prototype, "17", {
	configurable: true,
	get() {
		globalThis.__mal_collect_garbage?.();
		return (
			Object.getPrototypeOf(this) === Array.prototype &&
			Object.getPrototypeOf(this[0]) === Array.prototype
		);
	},
});
Object.defineProperty(other.Array.prototype, "17", {
	configurable: true,
	get() {
		globalThis.__mal_collect_garbage?.();
		this[0][1] = "foreign";
		return (
			Object.getPrototypeOf(this) === other.Array.prototype &&
			Object.getPrototypeOf(this[0]) === other.Array.prototype
		);
	},
});
try {
	rows.push(inspect(other.Object, { alpha: 1 }, 17, other.Array.prototype));
	rows.push(inspect(Object, { alpha: 1 }, 17, Array.prototype));
} finally {
	delete Array.prototype[17];
	delete other.Array.prototype[17];
}
console.log(JSON.stringify(rows));
