import "./order-a.mjs";
import "./order-b.mjs";
if (globalThis.moduleOrder.join(",") !== "leaf,q1,a,b")
	throw new Error(`unexpected module order: ${globalThis.moduleOrder}`);
console.log("RESULT 1/1");
