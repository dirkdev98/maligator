import "./operator-completion-effects.mjs";

const gc = globalThis.__mal_collect_garbage ?? globalThis.gc;
const original = String;
const trace = [];
try {
	globalThis.String = (value) => {
		gc();
		if (value === "symbol") return Symbol("returned");
		return {
			[Symbol.toPrimitive](hint) {
				trace.push(hint);
				gc();
				if (value === "throw") throw { marker: "replacement coercion" };
				return value;
			},
		};
	};
	for (const operator of ["<", "<=", ">", ">=", "==", "!=", "===", "!=="]) {
		for (const left of ["7", "throw", "symbol"]) {
			trace.length = 0;
			try {
				const result = globalThis.mixedRelation(
					left,
					{
						valueOf() {
							trace.push("right");
							gc();
							return 7;
						},
					},
					true,
					operator,
				);
				console.log("replacement", left, operator, result, trace.join(","));
			} catch (error) {
				console.log(
					"replacement throw",
					left,
					operator,
					error instanceof TypeError ? "TypeError" : error.marker,
					trace.join(","),
				);
			}
		}
	}
} finally {
	globalThis.String = original;
}
