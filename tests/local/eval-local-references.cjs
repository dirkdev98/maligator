function observe(fn) {
	try {
		return fn();
	} catch (error) {
		return error.name;
	}
}
const cases = {
	parameter() {
		return (function (eval) {
			let value = 1;
			return [eval("value = 2"), value];
		})(globalThis.eval);
	},
	constant() {
		const eval = globalThis.eval;
		const value = 3;
		return eval("value");
	},
	reassigned() {
		let eval = (source) => source;
		const value = 4;
		eval = globalThis.eval;
		return eval("value");
	},
	mappedArguments() {
		return (function (eval, value) {
			eval("arguments[1] = 5");
			return [value, arguments[1]];
		})(globalThis.eval, 1);
	},
	selectedIntrinsic() {
		let eval = globalThis.eval;
		let value = 1;
		const result = eval(((eval = () => 99), "value = 6"));
		return [result, value, eval("value")];
	},
	selectedReplacement() {
		let eval = function (source) {
			"use strict";
			return [this === undefined, source];
		};
		const result = eval(((eval = globalThis.eval), "value"));
		const value = 7;
		return [result, eval("value")];
	},
	abrupt() {
		const eval = globalThis.eval;
		const token = {};
		let value = 1;
		try {
			eval("value = 8; throw token");
		} catch (error) {
			return [error === token, value];
		}
	},
	escaped() {
		const eval = globalThis.eval;
		let value = 9;
		const pair = eval("[() => value, next => value = next]");
		pair[1](10);
		return [pair[0](), value];
	},
	declarations() {
		return (function (eval) {
			eval("var localCreated = 11");
			return [localCreated, eval("localCreated")];
		})(globalThis.eval);
	},
	spread() {
		return (function (eval) {
			const value = 12;
			return eval(...["value", "ignored"]);
		})(globalThis.eval);
	},
	chainHead() {
		const value = { marker: 13 };
		return eval("value")?.marker;
	},
	localChainHead() {
		const eval = globalThis.eval;
		const value = { marker: 14 };
		return eval("value")?.marker;
	},
	optionalIndirect() {
		const eval = globalThis.eval;
		const localEvalGlobal = "local";
		return [eval?.("localEvalGlobal"), localEvalGlobal];
	},
	sequenceIndirect() {
		const eval = globalThis.eval;
		const localEvalGlobal = "local";
		return [(0, eval)("localEvalGlobal"), localEvalGlobal];
	},
	memberIndirect() {
		const object = { eval: globalThis.eval };
		const localEvalGlobal = "local";
		return [object.eval("localEvalGlobal"), localEvalGlobal];
	},
	withOptionalReceiver() {
		const object = {
			eval: function () {
				"use strict";
				return this === object;
			},
		};
		with (object) {
			return eval?.("ignored");
		}
	},
	withChainReceiver() {
		const object = {
			eval: function () {
				"use strict";
				return { marker: this === object };
			},
		};
		with (object) {
			return eval("ignored")?.marker;
		}
	},
	immutableOrdinary() {
		const eval = function (source) {
			"use strict";
			return [this === undefined, source];
		};
		return eval("unchanged");
	},
	interceptedConstant() {
		const eval = () => 0;
		const value = 15;
		with ({ eval: globalThis.eval }) {
			return eval("value");
		}
	},
	interceptedOuterConstant() {
		const eval = () => 0;
		return (function () {
			with ({ eval: globalThis.eval }) {
				eval("var eval = globalThis.eval");
			}
			const value = 16;
			return eval("value");
		})();
	},
};
globalThis.localEvalGlobal = "global";
const output = {};
for (const key of Object.keys(cases)) output[key] = observe(cases[key]);
delete globalThis.localEvalGlobal;
console.log(JSON.stringify(output));
