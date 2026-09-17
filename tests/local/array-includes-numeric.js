let passed = 0;

function check(condition, label) {
	if (!condition) throw new Error(`array-includes-numeric: ${label}`);
	passed++;
}

const packed = [-0, 1, 1.5, NaN, Infinity, -Infinity];
check(packed.includes(0), "positive zero matches negative zero");
check(packed.includes(-0), "negative zero matches negative zero");
check(packed.includes(1.5), "fractional hit");
check(packed.includes(NaN), "NaN matches NaN");
check(packed.includes(Infinity), "positive infinity hit");
check(packed.includes(-Infinity), "negative infinity hit");
check(!packed.includes(2), "packed miss");

const holey = [1, , 3];
holey.length = 16;
check(holey.includes(3), "holey hit");
check(!holey.includes(2), "holey miss");
check(!holey.includes(NaN), "holes do not match NaN");
check(!holey.includes(1, 8), "start beyond dense prefix but within length");
check(!holey.includes(1, 16), "start beyond dense prefix");
check(holey.includes(undefined), "nonnumeric search materializes holes");

const lazy = [];
lazy.length = 32;
check(!lazy.includes(0), "lazy empty vector numeric miss");
check(lazy.includes(undefined), "lazy empty vector undefined hit");

const mixed = [1, 1n, "1", { value: 1 }];
check(mixed.includes(1), "mixed numeric hit");
check(!mixed.includes(2), "mixed numeric miss");
check(mixed.includes(1n), "BigInt behavior unchanged");
check(mixed.includes("1"), "string behavior unchanged");
check(mixed.includes(mixed[3]), "object identity unchanged");

const deleted = [4, 5, 6];
check(
	!deleted.includes(5, {
		valueOf() {
			delete deleted[1];
			return 0;
		},
	}),
	"fromIndex deletion is observed",
);

const lengthened = [7, 8];
check(
	!lengthened.includes(9, {
		valueOf() {
			lengthened.push(9);
			return 0;
		},
	}),
	"fromIndex growth does not extend captured length",
);

let inheritedGets = 0;
const inheritedPrototype = Object.create(Array.prototype);
Object.defineProperty(inheritedPrototype, "1", {
	configurable: true,
	get() {
		inheritedGets++;
		return 10;
	},
});
const inherited = [9, , 11];
Object.setPrototypeOf(inherited, inheritedPrototype);
check(inherited.includes(10) && inheritedGets === 1, "inherited indexed getter");

console.log(`array-includes-numeric PASS ${passed}`);
