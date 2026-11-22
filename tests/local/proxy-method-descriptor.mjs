class Catalog {
	lookupRecord() {
		return "proxy method";
	}
}

class DescriptorHandler {
	getOwnPropertyDescriptor() {
		return { enumerable: true, configurable: true };
	}
}

const prototype = new Proxy(Catalog.prototype, new DescriptorHandler());
console.log(Object.values(prototype).at(-1)());
