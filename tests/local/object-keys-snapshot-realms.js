function inspect(namespace, record, index) {
	const keys = namespace.keys(record);
	const value = keys[index];
	return [value, keys.length, keys[0]];
}

function count(namespace, record) {
	return namespace.keys(record).length;
}

const other = $262.createRealm().global;
const record = { alpha: 1 };
const rows = [];
let reads = 0;
Object.defineProperty(Array.prototype, "17", { value: 91, configurable: true });
Object.defineProperty(other.Array.prototype, "17", {
	configurable: true,
	get() {
		reads++;
		globalThis.__mal_collect_garbage?.();
		this[0] = "foreign";
		this.length = 2;
		return Object.getPrototypeOf(this) === other.Array.prototype ? 42 : -1;
	},
});
try {
	rows.push(inspect(other.Object, record, 17));
	rows.push(inspect(Object, record, 17));
	rows.push(count(other.Object, record), reads);
	Object.defineProperty(other.Array.prototype, "17", {
		configurable: true,
		get() {
			reads++;
			throw new other.RangeError("foreign keys");
		},
	});
	try {
		inspect(other.Object, record, 17);
	} catch (error) {
		rows.push(error instanceof other.RangeError, error instanceof RangeError, reads);
	}
} finally {
	delete Array.prototype[17];
	delete other.Array.prototype[17];
}
console.log(JSON.stringify(rows));
