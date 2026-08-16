"use strict";

let checks = 0;
function ok(name, condition) {
	if (!condition) throw new Error("object-has-own-known failure: " + name);
	checks++;
}

function known(value, key) {
	return Object.hasOwn(value, key);
}

ok("own", known({ value: 1 }, "value"));
ok("inherited", !known(Object.create({ value: 1 }), "value"));
ok("string exotic", known("abc", 1));
ok(
	"missing arguments",
	(() => {
		try {
			known();
			return false;
		} catch (error) {
			return error instanceof TypeError;
		}
	})(),
);

let trapCalls = 0;
const proxy = new Proxy(
	{ value: 1 },
	{
		getOwnPropertyDescriptor(target, key) {
			trapCalls++;
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
	},
);
ok("proxy trap", known(proxy, "value") && trapCalls === 1);

const key = {
	toString() {
		return "value";
	},
};
ok("key coercion", known({ value: 1 }, key));
ok("check count", checks === 6);
console.log("object-has-own-known PASS");
