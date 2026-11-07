// Declared class fields a construct receiver's creation defines.
let checks = 0;
function ok(name, condition) {
	if (!condition) throw new Error(`receiver-fields failure: ${name}`);
	checks++;
}

class Point {
	x;
	y;
	label;
	constructor(x, y) {
		this.x = x;
		this.y = y;
	}
	sum() {
		return new Point(this.x + 1, this.y + 1);
	}
}

const point = new Point(1, 2).sum();
ok("values", point.x === 2 && point.y === 3 && point.label === undefined);
ok("order", Object.keys(point).join() === "x,y,label");
ok("own label", Object.hasOwn(point, "label"));
ok(
	"descriptor",
	JSON.stringify(Object.getOwnPropertyDescriptor(point, "label")) ===
		'{"writable":true,"enumerable":true,"configurable":true}',
);

let observed;
class Seen {
	before;
	constructor() {
		observed = Object.keys(this).join();
	}
}
new Seen();
ok("defined before the body", observed === "before");

let setterCalls = 0;
class Base {
	set guarded(value) {
		setterCalls++;
	}
}
class Guarded extends Base {}
Object.defineProperty(Object.prototype, "shadowed", {
	set() {
		setterCalls++;
	},
	configurable: true,
});
class Shadowing {
	shadowed;
	guarded;
}
const shadowing = new Shadowing();
ok("define skips setters", setterCalls === 0 && Object.hasOwn(shadowing, "shadowed"));
delete Object.prototype.shadowed;
ok("subclass", new Guarded() instanceof Base);

class Proto {
	__proto__;
}
const proto = new Proto();
ok(
	"own __proto__",
	Object.hasOwn(proto, "__proto__") && Object.getPrototypeOf(proto) === Proto.prototype,
);

class Other {}
const reflected = Reflect.construct(Point, [5, 6], Other);
ok(
	"new target prototype",
	Object.getPrototypeOf(reflected) === Other.prototype && reflected.y === 6,
);

class Duplicate {
	value;
	value;
}
ok("duplicate", Object.keys(new Duplicate()).join() === "value");

class Child extends Point {
	extra;
	constructor() {
		super(7, 8);
		this.extra = 9;
	}
}
const child = new Child();
ok("derived", Object.keys(child).join() === "x,y,label,extra" && child.extra === 9);

let total = 0;
let last;
for (let i = 0; i < 20000; i++) {
	last = new Point(i, i).sum();
	total += last.x;
}
ok("many", total === 200010000 && Object.keys(last).join() === "x,y,label");
ok("check count", checks === 12);
console.log("receiver-fields PASS");
