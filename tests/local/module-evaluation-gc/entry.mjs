import "./sync.mjs";
import defer * as deferred from "./deferred.mjs";
import { token } from "./parent.mjs";
import { probe } from "./probe.mjs";

probe("entry");
if (token.value !== 42) throw new Error("dependency result did not survive collection");
const dynamic = await import("./dynamic.mjs");
if (dynamic.value !== 43 || deferred.value !== 44)
	throw new Error("dynamic or deferred namespace did not survive collection");
globalThis.moduleGcFailure = { reason: "cached" };
for (let index = 0; index < 2; index++) {
	let rejected = false;
	try {
		await import("./failure.mjs");
	} catch (error) {
		rejected = error === globalThis.moduleGcFailure;
	}
	if (!rejected) throw new Error("module rejection lost its identity");
}
if (
	globalThis.moduleGcStages.join(",") !==
	"startup,tla-before,tla-after,ancestor,entry,dynamic,deferred,reject-before,reject-after"
)
	throw new Error(`unexpected evaluation order: ${globalThis.moduleGcStages}`);
globalThis.moduleGcFinished = true;
