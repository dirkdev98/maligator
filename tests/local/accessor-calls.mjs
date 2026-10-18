// Static loads and stores of a name that one class defines as an accessor call
// that accessor directly once their probe proves the receiver resolves to it;
// every other receiver must keep ordinary [[Get]] and [[Set]] semantics.
const lines = [];
const show = (label, value) => lines.push(`${label}: ${value}`);

class Temperature {
	#celsius = 0;
	get celsius() {
		return this.#celsius;
	}
	set celsius(value) {
		this.#celsius = value;
	}
	get fahrenheit() {
		return this.#celsius * 1.8 + 32;
	}
}

class Gauge extends Temperature {
	reads = 0;
}

function readCelsius(value) {
	return value.celsius;
}
function writeCelsius(value, next) {
	value.celsius = next;
}
function readFahrenheit(value) {
	return value.fahrenheit;
}

const temperature = new Temperature();
let total = 0;
for (let round = 0; round < 2000; round++) {
	temperature.celsius = round & 15;
	total += temperature.celsius + temperature.fahrenheit;
}
show("loop", total);

const gauge = new Gauge();
writeCelsius(gauge, 21);
show("subclass", `${readCelsius(gauge)} ${readFahrenheit(gauge)}`);

const shadowed = new Temperature();
Object.defineProperty(shadowed, "celsius", { value: 99, writable: true });
show("own data shadows", readCelsius(shadowed));
writeCelsius(shadowed, 7);
show("own data write", `${shadowed.celsius} ${readFahrenheit(shadowed)}`);

// Parsed receivers keep data properties of these names out of the compiler's view.
const plain = JSON.parse('{"celsius": 5}');
show("plain object", readCelsius(plain));
writeCelsius(plain, 6);
show("plain write", plain.celsius);
show("primitive", readCelsius(42));
show("missing", readCelsius({}));
show("array", readCelsius(Object.assign([], JSON.parse('{"celsius": 3}'))));
const proxy = new Proxy(new Temperature(), {
	get(target, key) {
		return key === "celsius" ? "trapped" : Reflect.get(target, key);
	},
});
show("proxy", readCelsius(proxy));
for (const unbranded of [
	Object.create(temperature),
	Object.create(Temperature.prototype),
]) {
	try {
		readCelsius(unbranded);
	} catch (error) {
		show("unbranded getter throws", error instanceof TypeError);
	}
}

const original = Object.getOwnPropertyDescriptor(Temperature.prototype, "celsius");
Object.defineProperty(Temperature.prototype, "celsius", {
	get() {
		return "redefined";
	},
	set(value) {
		lines.push(`redefined setter ${value}`);
	},
	configurable: true,
});
show("redefined getter", readCelsius(temperature));
writeCelsius(temperature, 1);
Object.defineProperty(Temperature.prototype, "celsius", original);
show("restored getter", readCelsius(temperature));

class ReadOnly {
	get kelvin() {
		return "read only";
	}
}
const readOnly = new ReadOnly();
show("getter only", readOnly.kelvin);
try {
	readOnly.kelvin = 3;
} catch (error) {
	show("missing setter throws", error instanceof TypeError);
}

class Throwing {
	get boom() {
		throw new RangeError("boom");
	}
}
function readBoom(value) {
	return value.boom;
}
for (const value of [new Throwing(), new Throwing()]) {
	try {
		readBoom(value);
	} catch (error) {
		show("getter throws", error instanceof RangeError);
	}
}

const mixed = [
	new Temperature(),
	JSON.parse('{"fahrenheit": "data"}'),
	new Gauge(),
	7,
	new Temperature(),
];
show("mixed receivers", mixed.map((value) => String(readFahrenheit(value))).join(","));
const seen = [];
for (let round = 0; round < 50; round++) {
	for (const value of mixed) {
		if (typeof value === "object") value.celsius = round;
		seen.push(String(value.fahrenheit));
	}
}
show("mixed in a loop", seen.slice(-mixed.length).join(","));
show("mixed written", mixed.map((value) => String(value.celsius)).join(","));

console.log(lines.join("\n"));
