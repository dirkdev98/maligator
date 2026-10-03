export let value = 1;
globalThis.selfModuleCount = (globalThis.selfModuleCount ?? 0) + 1;
const self = import("./sync-self.mjs");
value = 42;
self.then((namespace) => {
	if (namespace.value !== 42 || globalThis.selfModuleCount !== 1)
		throw new Error("self import did not observe completed synchronous startup");
	console.log("RESULT 1/1");
});
