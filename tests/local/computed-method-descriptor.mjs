import { hostname } from "node:os";

class Service {
	identify() {
		return hostname();
	}
}

const prototype = Service.prototype;
Object.defineProperty(prototype, process.env.METHOD_KEY, { enumerable: true });
const [method] = Object.values(prototype);
console.log(method());
