globalThis.moduleOrder = [];
await 0;
globalThis.moduleOrder.push("leaf");
Promise.resolve()
	.then(() => globalThis.moduleOrder.push("q1"))
	.then(() => globalThis.moduleOrder.push("q2"));
