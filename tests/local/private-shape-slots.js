// Private elements of ordinary objects live in shape slots; every reflective
// path must keep hiding them, and every representation change must keep them.
const lines = [];
const show = (label, value) => lines.push(`${label}: ${value}`);

class Point {
	#x;
	#y = 2;
	z = 3;
	constructor(x) {
		this.#x = x;
	}
	get sum() {
		return this.#x + this.#y + this.z;
	}
	move(dx) {
		this.#x += dx;
		return this;
	}
	static has(value) {
		return #x in value;
	}
	static x(value) {
		return value.#x;
	}
}

const point = new Point(1);
show("sum", point.sum);
show("keys", Object.keys(point).join(","));
show("names", Object.getOwnPropertyNames(point).join(","));
show("ownKeys", Reflect.ownKeys(point).length);
show("symbols", Object.getOwnPropertySymbols(point).length);
show("descriptors", Object.keys(Object.getOwnPropertyDescriptors(point)).join(","));
show("json", JSON.stringify(point));
show("spread", JSON.stringify({ ...point }));
show("assign", JSON.stringify(Object.assign({}, point)));
show("entries", JSON.stringify(Object.entries(point)));
const forIn = [];
for (const key in point) forIn.push(key);
show("for-in", forIn.join(","));
show("clone", JSON.stringify(structuredClone(point)));
show("brand", `${Point.has(point)} ${Point.has({ z: 3 })}`);

Object.freeze(point);
point.move(10);
show("frozen write", `${point.sum} ${Object.isFrozen(point)}`);
Object.seal(point);
show("sealed", Object.isSealed(point));

class Base {
	constructor(target) {
		return target;
	}
}
class Stamp extends Base {
	#stamp = "stamped";
	static read(value) {
		return value.#stamp;
	}
	static has(value) {
		return #stamp in value;
	}
}
const frozen = Object.freeze({ kept: true });
new Stamp(frozen);
show(
	"frozen stamp",
	`${Stamp.read(frozen)} ${Object.isFrozen(frozen)} ${Object.keys(frozen)}`,
);
try {
	new Stamp(frozen);
} catch (error) {
	show("reinstall", error instanceof TypeError);
}
const nonExtensible = Object.preventExtensions({});
new Stamp(nonExtensible);
show("non-extensible stamp", Stamp.read(nonExtensible));
const proxy = new Proxy({}, {});
new Stamp(proxy);
show("proxy stamp", `${Stamp.read(proxy)} ${Reflect.ownKeys(proxy).length}`);
const array = [1, 2];
new Stamp(array);
show("array stamp", `${Stamp.read(array)} ${array.length} ${Object.keys(array)}`);
const fn = function named() {};
new Stamp(fn);
show("function stamp", `${Stamp.read(fn)} ${Object.getOwnPropertyNames(fn).sort()}`);
const typed = new Uint8Array(4);
new Stamp(typed);
show("typed stamp", `${Stamp.read(typed)} ${typed.length}`);
const map = new Map([[1, 2]]);
new Stamp(map);
show("map stamp", `${Stamp.read(map)} ${map.get(1)} ${map.size}`);

const wide = {};
for (let index = 0; index < 70; index++) wide[`k${index}`] = index;
new Stamp(wide);
show("wide stamp", `${Stamp.read(wide)} ${Object.keys(wide).length}`);
const full = {};
for (let index = 0; index < 64; index++) full[`f${index}`] = index;
new Stamp(full);
full.extra = 1;
show("full stamp", `${Stamp.read(full)} ${Object.keys(full).length}`);

const migrating = { a: 1, b: 2 };
new Stamp(migrating);
delete migrating.a;
migrating[Symbol.for("public")] = 3;
show(
	"dictionary stamp",
	`${Stamp.read(migrating)} ${Reflect.ownKeys(migrating).length} ${Stamp.has(migrating)}`,
);

class Child extends Point {
	#own = "child";
	extra = 4;
	read() {
		return `${this.#own} ${Point.x(this)} ${this.sum}`;
	}
}
const children = [new Child(5), new Child(6)];
const mixed = [new Point(7), ...children, new Point(8)];
show("children", children.map((child) => child.read()).join(" | "));
show("mixed", mixed.map((value) => Point.x(value)).join(","));

const factory = () =>
	class {
		#value;
		constructor(value) {
			this.#value = value;
		}
		static read(value) {
			try {
				return value.#value;
			} catch {
				return "foreign";
			}
		}
	};
const First = factory();
const Second = factory();
const first = new First("first");
show("distinct names", `${First.read(first)} ${Second.read(first)}`);

class Many {
	constructor() {
		for (const install of installers) install(this);
	}
}
const installer = (index) =>
	class extends Base {
		#value = index;
		static read(value) {
			return value.#value;
		}
	};
const installers = [];
const readers = [];
for (let index = 0; index < 70; index++) {
	const Installer = installer(index);
	installers.push((target) => new Installer(target));
	readers.push(Installer.read);
}
const many = new Many();
show(
	"many",
	`${readers.reduce((total, read) => total + read(many), 0)} ${Object.keys(many).length}`,
);

class Methods {
	#count = 0;
	#bump() {
		return ++this.#count;
	}
	get #twice() {
		return this.#count * 2;
	}
	run() {
		this.#bump();
		this.#bump();
		return `${this.#count} ${this.#twice}`;
	}
}
show("methods", new Methods().run());

class Statics {
	static #hidden = "static";
	static read() {
		return Statics.#hidden;
	}
}
show("static", `${Statics.read()} ${Object.getOwnPropertyNames(Statics).sort()}`);

let total = 0;
for (let round = 0; round < 2000; round++) total += new Point(round).move(1).sum;
show("allocations", total);
console.log(lines.join("\n"));
