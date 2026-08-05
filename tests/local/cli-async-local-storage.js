import { AsyncLocalStorage } from "node:async_hooks";

const requestScope = new AsyncLocalStorage();

requestScope.run({ requestId: "als-ok" }, async () => {
	await Promise.resolve();
	console.log(requestScope.getStore().requestId);
});
