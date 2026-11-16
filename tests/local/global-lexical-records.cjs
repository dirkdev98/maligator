const vm = require("node:vm");
function observe(fn) {
	try {
		return fn();
	} catch (error) {
		return error.name;
	}
}
const cases = {
	evalVar() {
		(0, eval)("var carriedEvalVar = 1");
		vm.runInThisContext("let carriedEvalVar = 2");
		return [vm.runInThisContext("carriedEvalVar"), globalThis.carriedEvalVar];
	},
	evalFunction() {
		(0, eval)("function carriedEvalFunction() { return 3; }");
		vm.runInThisContext("const carriedEvalFunction = 4");
		return [vm.runInThisContext("carriedEvalFunction"), globalThis.carriedEvalFunction()];
	},
	deletedEvalProperty() {
		(0, eval)("var deletedEvalProperty = 5");
		const deleted = delete globalThis.deletedEvalProperty;
		vm.runInThisContext("let deletedEvalProperty = 6");
		return [deleted, vm.runInThisContext("deletedEvalProperty")];
	},
	cachedGlobalRead() {
		(0, eval)("var shadowedGlobalRead = 7");
		const read = new Function("return shadowedGlobalRead");
		const before = [read(), read()];
		vm.runInThisContext("let shadowedGlobalRead = 8");
		return [before, read(), globalThis.shadowedGlobalRead];
	},
	lexicalMutation() {
		(0, eval)("var mutatedGlobalLexical = 9");
		vm.runInThisContext("let mutatedGlobalLexical = 10");
		const changed = (0, eval)("mutatedGlobalLexical = 11");
		return [
			changed,
			vm.runInThisContext("mutatedGlobalLexical"),
			globalThis.mutatedGlobalLexical,
		];
	},
	immutableLexical() {
		(0, eval)("var immutableGlobalLexical = 12");
		vm.runInThisContext("const immutableGlobalLexical = 13");
		return [
			observe(() => (0, eval)("immutableGlobalLexical = 14")),
			vm.runInThisContext("immutableGlobalLexical"),
		];
	},
	lexicalDelete() {
		(0, eval)("var deletedGlobalLexical = 15");
		vm.runInThisContext("let deletedGlobalLexical = 16");
		const deleted = (0, eval)("delete deletedGlobalLexical");
		return [
			deleted,
			vm.runInThisContext("deletedGlobalLexical"),
			globalThis.deletedGlobalLexical,
		];
	},
	lexicalCollision() {
		vm.runInThisContext("let existingGlobalLexical = 17");
		return [
			observe(() => vm.runInThisContext("var existingGlobalLexical = 18")),
			vm.runInThisContext("existingGlobalLexical"),
		];
	},
	scriptVarCollision() {
		vm.runInThisContext("var restrictedScriptVar = 19");
		return [
			observe(() => vm.runInThisContext("let restrictedScriptVar = 20")),
			globalThis.restrictedScriptVar,
		];
	},
	restrictedProperty() {
		Object.defineProperty(globalThis, "restrictedGlobalProperty", {
			value: 21,
			configurable: false,
		});
		return [
			observe(() => vm.runInThisContext("const restrictedGlobalProperty = 22")),
			globalThis.restrictedGlobalProperty,
		];
	},
	accessorVar() {
		let calls = 0;
		const getter = () => {
			calls++;
			return 23;
		};
		Object.defineProperty(globalThis, "existingAccessorVar", {
			get: getter,
			configurable: true,
			enumerable: false,
		});
		vm.runInThisContext("var existingAccessorVar");
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, "existingAccessorVar");
		return [
			calls,
			descriptor.get === getter,
			descriptor.configurable,
			descriptor.enumerable,
		];
	},
	dataPropertyVar() {
		Object.defineProperty(globalThis, "existingDataVar", {
			value: 24,
			writable: false,
			configurable: true,
			enumerable: false,
		});
		vm.runInThisContext("var existingDataVar");
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, "existingDataVar");
		return [
			descriptor.value,
			descriptor.writable,
			descriptor.configurable,
			descriptor.enumerable,
		];
	},
	annexB() {
		(0, eval)("{ function annexBGlobalFunction() { return 25; } }");
		vm.runInThisContext("let annexBGlobalFunction = 26");
		return [
			vm.runInThisContext("annexBGlobalFunction"),
			globalThis.annexBGlobalFunction(),
		];
	},
	directScriptEval() {
		vm.runInThisContext("eval('var directGlobalEvalVar = 27')");
		vm.runInThisContext("let directGlobalEvalVar = 28");
		return [vm.runInThisContext("directGlobalEvalVar"), globalThis.directGlobalEvalVar];
	},
	realmIsolation() {
		const context = vm.createContext({});
		vm.runInContext("eval('var realmEvalVar = 29')", context);
		vm.runInContext("let realmEvalVar = 30", context);
		return [
			vm.runInContext("realmEvalVar", context),
			context.realmEvalVar,
			typeof globalThis.realmEvalVar,
		];
	},
};
const output = {};
for (const key of Object.keys(cases)) output[key] = observe(cases[key]);
console.log(JSON.stringify(output));
