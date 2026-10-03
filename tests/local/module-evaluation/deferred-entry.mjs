import defer * as deferred from "./deferred-target.mjs";
if (globalThis.deferredModuleCount !== undefined)
	throw new Error("deferred module initialized during startup");
if (deferred.value !== 41 || globalThis.deferredModuleCount !== 1)
	throw new Error("deferred access did not initialize exactly once");
deferred.increment();
const ordinary = await import("./deferred-target.mjs");
if (ordinary.value !== 42 || globalThis.deferredModuleCount !== 1)
	throw new Error(
		"deferred and ordinary imports did not share evaluation and live bindings",
	);
console.log("RESULT 1/1");
