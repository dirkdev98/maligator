import Module, { builtinModules, isBuiltin } from "node:module";

let coerced = false;
const invalid = {
	toString() {
		coerced = true;
		return "fs";
	},
};
let mutation;
try {
	builtinModules.push("fake");
} catch (error) {
	mutation = error.name;
}
console.log(
	JSON.stringify({
		names: builtinModules,
		loadable: builtinModules.every(
			(name) => process.getBuiltinModule(name) !== undefined,
		),
		prefixOnly: process.getBuiltinModule("sqlite") === undefined,
		identity: Module.builtinModules === builtinModules && Module.isBuiltin === isBuiltin,
		valid: builtinModules.every(
			(name) =>
				isBuiltin(name) && isBuiltin(name.startsWith("node:") ? name : `node:${name}`),
		),
		frozen: Object.isFrozen(builtinModules),
		mutation,
		invalid: [
			isBuiltin(),
			isBuiltin(null),
			isBuiltin(invalid),
			isBuiltin("node:node:fs"),
			isBuiltin("sqlite"),
		],
		coerced,
		unsupported: ["repl", "wasi", "trace_events", "inspector/promises"].map(isBuiltin),
	}),
);
