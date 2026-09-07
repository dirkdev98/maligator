import { execution } from "maligator:process";
import * as first from "maligator:process";
import * as second from "maligator:process";

let earlyReadThrew = false;
try {
	globalThis.earlyCommand = alias.command;
} catch (error) {
	earlyReadThrew = error instanceof ReferenceError;
}
const alias = execution;
if (!earlyReadThrew || alias.command !== "test") {
	throw new Error("platform alias initialization semantics changed");
}

const dynamic = await import("maligator:process");
if (first !== second || first !== dynamic || execution !== dynamic.execution) {
	throw new Error("platform export or namespace identity changed");
}
globalThis.snapshot = execution;
const snapshot = Reflect.get(globalThis, "snapshot");
const pending = [snapshot];
while (pending.length > 0) {
	const value = pending.pop();
	if (value === null || typeof value !== "object") continue;
	if (!Object.isFrozen(value)) throw new Error("platform data is not deeply frozen");
	for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
		if (descriptor.configurable || descriptor.writable || "get" in descriptor) {
			throw new Error("platform data has an unexpected descriptor");
		}
		pending.push(descriptor.value);
	}
}
if (Reflect.set(snapshot, "command", "changed")) throw new Error("snapshot is mutable");
if (Reflect.deleteProperty(snapshot.config, "engine"))
	throw new Error("snapshot is configurable");
console.log("SNAPSHOT " + JSON.stringify(snapshot));
