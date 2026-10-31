let calls = 0;
function literalMethodCalls(mutate) {
	const counter = {
		bias: 5,
		step(value) {
			calls++;
			return this.bias + value;
		},
	};
	let total = 0;
	for (let index = 0; index < 8; index++) {
		mutate(counter, index);
		total += counter.step(index);
	}
	return total;
}
const collect = globalThis.__mal_collect_garbage;
let original;
console.log(
	"unchanged",
	literalMethodCalls(() => {}),
	calls,
);
console.log(
	"reassigned",
	literalMethodCalls((object, index) => {
		if (index === 1) original = object.step;
		if (index === 2)
			object.step = function (value) {
				return this.bias * value;
			};
		if (index === 3) object.step = Math.abs;
		if (index === 4)
			Object.defineProperty(object, "step", {
				configurable: true,
				get() {
					if (typeof collect === "function") collect();
					return (value) => value + 1000;
				},
			});
		if (index === 5)
			Object.defineProperty(object, "step", { writable: true, value: original });
		if (index === 6) object.step = original.bind({ bias: 50 });
	}),
	calls,
);
try {
	literalMethodCalls((object, index) => {
		if (index === 2) object.step = 42;
	});
} catch (error) {
	console.log("non-callable", error instanceof TypeError, calls);
}
