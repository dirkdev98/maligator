const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const foreign = $262.createRealm().global;
const rows = [],
	events = [];
function finite(source, namespace) {
	const part = source.slice(1, -1);
	collectGarbage();
	return namespace.isFinite(part);
}
function nan(source, namespace) {
	const part = source.slice(1, -1);
	collectGarbage();
	return namespace.isNaN(part);
}
globalThis.numberPredicates = { finite, nan };
const namespace = { isFinite: foreign.isFinite, isNaN: foreign.isNaN };
rows.push(
	globalThis.numberPredicates.finite("x12y", namespace),
	globalThis.numberPredicates.nan("xNaNy", namespace),
);
for (const value of [1n, Symbol("bad")])
	for (const visit of [
		globalThis.numberPredicates.finite,
		globalThis.numberPredicates.nan,
	]) {
		try {
			visit(
				{
					slice() {
						return value;
					},
				},
				namespace,
			);
			throw new Error("missing foreign error");
		} catch (error) {
			rows.push(error instanceof foreign.TypeError, error instanceof TypeError);
			if (!(error instanceof foreign.TypeError)) throw error;
		}
	}
const changing = {
	slice() {
		return {
			valueOf() {
				events.push("valueOf");
				namespace.isFinite = () => 999;
				collectGarbage();
				return Symbol("bad");
			},
		};
	},
};
try {
	globalThis.numberPredicates.finite(changing, namespace);
	throw new Error("missing captured error");
} catch (error) {
	rows.push(error instanceof foreign.TypeError, error instanceof TypeError);
	if (!(error instanceof foreign.TypeError)) throw error;
}
const abrupt = {
	slice() {
		return {
			valueOf() {
				collectGarbage();
				throw new RangeError("local");
			},
		};
	},
};
try {
	globalThis.numberPredicates.nan(abrupt, namespace);
	throw new Error("missing local error");
} catch (error) {
	rows.push(error instanceof foreign.RangeError, error instanceof RangeError);
	if (!(error instanceof RangeError)) throw error;
}
console.log(JSON.stringify([rows, events]));
