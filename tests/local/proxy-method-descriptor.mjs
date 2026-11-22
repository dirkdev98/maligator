import os from "node:os";

class Catalog {
	lookupRecord() {
		return os.hostname();
	}
}

class DescriptorHandler {
	getOwnPropertyDescriptor() {
		return { enumerable: true, configurable: true };
	}
}

const prototype = new Proxy(Catalog.prototype, new DescriptorHandler());
console.log(Object.values(prototype).at(-1)());
