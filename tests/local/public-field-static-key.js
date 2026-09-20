function ok(condition, message) {
	if (!condition) throw new Error("FAIL " + message);
}

let setterCalls = 0;
class Base {
	set value(_value) {
		setterCalls++;
	}
}
class OwnField extends Base {
	value = 41;
}
const ownField = new OwnField();
ok(ownField.value === 41 && setterCalls === 0, "field bypasses inherited setter");

const trapKeys = [];
class ProxyBase {
	constructor() {
		return new Proxy(this, {
			defineProperty(target, key, descriptor) {
				trapKeys.push(key + ":" + descriptor.value);
				return Reflect.defineProperty(target, key, descriptor);
			},
		});
	}
}
class ProxyFields extends ProxyBase {
	first = 1;
	second = 2;
}
const proxyFields = new ProxyFields();
ok(
	proxyFields.first === 1 && proxyFields.second === 2,
	"proxy fields installed: " +
		proxyFields.first +
		"," +
		proxyFields.second +
		" traps=" +
		trapKeys.join(","),
);
ok(trapKeys.join(",") === "first:1,second:2", "proxy traps preserve order");

let laterRan = false;
class FrozenDuringInitialization {
	first = Object.freeze(this);
	second = (laterRan = true);
}
let frozenThrew = false;
try {
	new FrozenDuringInitialization();
} catch (error) {
	frozenThrew = error instanceof TypeError;
}
ok(frozenThrew && !laterRan, "rejected define stops later initializer");

console.log("public-field-static-key PASS");
