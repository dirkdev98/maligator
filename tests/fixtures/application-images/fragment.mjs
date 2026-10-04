globalThis.fragmentOrder = ["started"];
setInterval(() => {}, 1000);
await new Promise((resolve) => setTimeout(resolve, 1));
globalThis.fragmentOrder.push("settled");
