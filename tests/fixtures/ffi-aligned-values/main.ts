/* oxlint-disable no-console -- The fixture reports observable C ABI behavior. */
import {
	aligned_address,
	aligned_address_async,
	aligned_huge_address,
	aligned_sum,
	aligned_sum_async,
	aligned_echo,
	aligned_echo_async,
	aligned_apply,
	aligned_apply_async,
	aligned_transform_async,
	aligned_notify_async,
	getValues,
	setValues,
	getHugeValues,
	setHugeValues,
} from "maligator:ffi/alignment";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}

for (const length of [0, 1, 2, 4, 5, 9]) {
	const values = Array.from({ length }, (_, i) => ({ x: i + 1, y: i + 2 }));
	check(aligned_address(values) % 64n === 0n, "C array input keeps its native alignment");
	check(
		(await aligned_address_async(values)) % 64n === 0n,
		"worker array input keeps its native alignment",
	);
	const expected = length * (length + 2);
	check(
		aligned_sum(values) === expected && (await aligned_sum_async(values)) === expected,
		"aligned array values survive inline and heap staging",
	);
}
function reenter(depth: number): void {
	const values = [
		{
			get x() {
				if (depth > 0) reenter(depth - 1);
				return 7;
			},
			y: 9,
		},
	];
	check(
		aligned_address(values) % 64n === 0n,
		"getter reentry preserves native array alignment",
	);
}
reenter(4);
check(
	aligned_huge_address([{ x: 1, y: 2 }]) % 65536n === 0n,
	"large alignment uses native heap storage",
);
setValues([
	{ x: 11, y: 12 },
	{ x: 13, y: 14 },
]);
check(getValues()[1].y === 14, "aligned global array values round-trip");
setHugeValues([{ x: 15, y: 16 }]);
check(getHugeValues()[0].x === 15, "highly aligned global array values round-trip");
check(aligned_echo({ x: 17, y: 18 }).y === 18, "aligned native record result");
check(
	(await aligned_echo_async({ x: 19, y: 20 })).x === 19,
	"aligned context input and result",
);
check(
	aligned_apply({ x: 21, y: 22 }, (pair) => pair.x + pair.y) === 64,
	"aligned synchronous callback argument",
);
check(
	(await aligned_apply_async({ x: 23, y: 24 }, (pair) => pair.x + pair.y)) === 70,
	"aligned queued waiting callback argument",
);
let notify: (value: number) => void = () => {};
const notified = new Promise<number>((resolve) => {
	notify = resolve;
});
check(
	(await aligned_transform_async(29, (value) => ({ x: value, y: value + 1 }))).y === 30,
	"aligned queued callback result",
);
await aligned_notify_async({ x: 25, y: 26 }, (pair) => {
	notify(pair.x + pair.y);
});
check((await notified) === 51, "aligned queued notification argument");
const marker = new Error("aligned conversion");
let caught = false;
try {
	aligned_sum(
		Array.from({ length: 5 }, () => ({
			get x(): number {
				throw marker;
			},
			y: 0,
		})),
	);
} catch (error) {
	caught = error === marker;
}
check(
	caught && aligned_sum([{ x: 27, y: 28 }]) === 55,
	"aligned allocation is released after a throwing getter",
);
console.log("aligned values passed");
