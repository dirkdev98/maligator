let ownCalls = 0;
let inheritedCalls = 0;

function own() {}
Object.defineProperty(own, "ownValue", {
	get() {
		ownCalls++;
		return 2;
	},
});

class Base {
	get inheritedValue() {
		inheritedCalls++;
		return 3;
	}
}
class Child extends Base {}
const inherited = new Child();
const absent = [];

let total = 0;
for (let i = 0; i < 50; i++) {
	total += own.ownValue;
	total += inherited.inheritedValue;
	total += absent.missingValue === undefined ? 1 : 0;
}
console.log(total, ownCalls, inheritedCalls);
