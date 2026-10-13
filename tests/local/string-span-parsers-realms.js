const collect = globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc;
const other = $262.createRealm().global;
const rows = [];
function integer(source, radix) {
	const token = source.slice(1, -1);
	collect?.();
	return [Number.parseInt(token, radix), token.length];
}
function floating(source) {
	const token = source.slice(1, -1);
	collect?.();
	return [Number.parseFloat(token), token.length];
}
globalThis.realmParsers = { integer, floating };
const originalInt = Number.parseInt,
	originalFloat = Number.parseFloat;
Number.parseInt = other.parseInt;
Number.parseFloat = other.parseFloat;
rows.push(globalThis.realmParsers.integer("[ff]", 16));
rows.push(globalThis.realmParsers.floating("[1.5e2tail]"));
for (const radix of [Symbol("radix"), 1n]) {
	try {
		globalThis.realmParsers.integer("[12]", radix);
	} catch (error) {
		rows.push(error instanceof other.TypeError, error instanceof TypeError);
	}
}
const events = [];
const changing = {
	valueOf() {
		events.push("radix");
		Number.parseInt = () => 999;
		collect?.();
		return Symbol("bad");
	},
};
try {
	globalThis.realmParsers.integer("[12]", changing);
} catch (error) {
	rows.push(error instanceof other.TypeError, error instanceof TypeError, events);
}
Number.parseInt = other.parseInt;
const boxed = {
	slice() {
		return {
			toString() {
				collect?.();
				return Symbol("bad");
			},
		};
	},
};
try {
	globalThis.realmParsers.floating(boxed);
} catch (error) {
	rows.push(error instanceof other.TypeError, error instanceof TypeError);
}
const abrupt = {
	slice() {
		return {
			toString() {
				collect?.();
				throw new RangeError("local");
			},
		};
	},
};
try {
	globalThis.realmParsers.floating(abrupt);
} catch (error) {
	rows.push(error instanceof other.RangeError, error instanceof RangeError);
}
Number.parseInt = originalInt;
Number.parseFloat = originalFloat;
console.log(JSON.stringify(rows));
