import type { FixtureBridge } from "./types.ts";
const bridge = mal as unknown as FixtureBridge;
import type { ApplicationData, FixtureGlobals } from "./types.ts";
const globals = globalThis as typeof globalThis & FixtureGlobals;
globals.fragmentOrder = ["started"];
setInterval(() => {}, 1000);
const data = bridge._applicationData() as ApplicationData;
if (data.mode === "evaluation-gate") {
	Atomics.store(new Int32Array(data.gate), 1, 1);
	await new Promise(() => {});
}
await new Promise<void>((resolve) => {
	setTimeout(resolve, 1);
});
globals.fragmentOrder.push("settled");
