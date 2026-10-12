import { types } from "node:util";
const args = (function () {
	return arguments;
})(1, 2);
const mapped = Function("return arguments;")(1, 2);
Object.setPrototypeOf(args, null);
const fake = { [Symbol.toStringTag]: "Arguments", length: 2, 0: 1 };
const error = new TypeError("x");
const changed = new Error("y");
Object.setPrototypeOf(changed, null);
const stackOnly = {};
Error.captureStackTrace(stackOnly);
const dom = new DOMException("x");
const domBrand = Error.isError(dom);
Object.setPrototypeOf(dom, null);
let read = false;
const proxy = new Proxy(error, {
	get() {
		read = true;
		throw new Error("read");
	},
});
const values = [
	undefined,
	null,
	{},
	args,
	mapped,
	fake,
	new Proxy(args, {}),
	error,
	changed,
	new AggregateError([]),
	dom,
	Object.create(Error.prototype),
	Error.prototype,
	DOMException.prototype,
	stackOnly,
	proxy,
];
console.log(
	JSON.stringify({
		results: values.map((x) => [types.isArgumentsObject(x), types.isNativeError(x)]),
		read,
		domBrand,
	}),
);
