/* oxlint-disable no-console -- The fixture reports observable C ABI behavior. */
import {
	tagged_make,
	makeAsync,
	tagged_take,
	takeAsync,
	tagged_out,
	outAsync,
	tagged_inout,
	inoutAsync,
	tagged_sum,
	sumAsync,
	tagged_pair,
	pairAsync,
	tagged_pair_inout,
	pairInoutAsync,
	tagged_visit,
	visitAsync,
	notifyAsync,
	tagged_calls,
	tagged_callback,
	callbackAsync,
} from "maligator:ffi/const_tagged";
function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
for (const kind of [0, 1, 2, 3]) {
	const expected = kind === 0 ? 5 : kind === 1 ? 11 : 18;
	for (const value of [tagged_make(kind, 5), await makeAsync(kind, 5)]) {
		check(value.kind === kind && value.id === 5, "C initializes the const discriminator");
		check(tagged_take(value) === expected, "selected const payload enters C");
		check(
			(await takeAsync(value)) === expected,
			"worker snapshots selected const payload",
		);
		check(
			tagged_visit(value, tagged_take) === expected,
			"const tagged callback argument",
		);
		check(
			(await visitAsync(value, tagged_take)) === expected,
			"waiting const tagged callback argument",
		);
		let notified = false;
		await notifyAsync(value, (received) => {
			notified = tagged_take(received) === expected;
		});
		check(notified, "notification copies the const tagged argument");
	}
}
const events: Array<string> = [];
const observed = {
	get kind() {
		events.push("kind");
		return 2 as const;
	},
	get id() {
		events.push("id");
		return 5;
	},
	get payload() {
		events.push("payload");
		return {
			get value() {
				events.push("value");
				return 6;
			},
			get writable() {
				events.push("writable");
				const garbage = Array.from({ length: 16 }, () => ({ value: "tagged roots" }));
				check(garbage.length === 16, "allocating payload getter");
				return 7;
			},
		};
	},
};
check(tagged_take(observed) === 18, "constructs a fresh selected record");
check(
	events.join(",") === "kind,id,payload,value,writable",
	"reads the discriminator once before selected getters",
);
const inactive = {
	kind: 0 as const,
	id: 23,
	get payload(): never {
		throw new Error("inactive payload");
	},
};
check(tagged_take(inactive) === 23, "empty selection leaves inactive storage unread");

for (const run of [tagged_out, outAsync]) {
	const result = await run();
	check(
		result.value.kind === 2 && tagged_take(result.value) === 36,
		"C output initializes const tagged storage",
	);
}
for (const run of [tagged_inout, inoutAsync]) {
	const original = tagged_make(2, 5);
	const result = await run(original);
	check(
		tagged_take(result.value) === 118 && tagged_take(original) === 18,
		"inout changes only its native snapshot",
	);
}
const pair = [tagged_make(2, 5), tagged_make(2, 7)] as const;
for (const run of [tagged_pair_inout, pairInoutAsync]) {
	const result = await run([...pair]);
	check(tagged_sum(result.value) === 242, "fixed arrays construct each tagged element");
}
check(
	tagged_pair({ id: 10, values: [...pair] }) === 52,
	"tagged arrays nested in a const record",
);
check(
	(await pairAsync({ id: 10, values: [...pair] })) === 52,
	"worker constructs nested tagged arrays",
);
for (const values of [[], [tagged_make(1, 5)], [...pair]]) {
	const expected = values.reduce((sum, value) => sum + tagged_take(value), 0);
	check(
		tagged_sum(values) === expected && (await sumAsync(values)) === expected,
		"counted tagged arrays use aligned native staging",
	);
}
const queued = tagged_make(2, 5);
const pending = takeAsync(queued);
queued.id = 1000;
if (queued.kind === 2) queued.payload.writable = 2000;
check((await pending) === 18, "worker owns its selected const snapshot");
for (const mode of ["tag", "payload", "throw"] as const) {
	const before = tagged_calls();
	let rejected = false;
	try {
		tagged_take(
			new Proxy(tagged_make(2, 5), {
				get(target, key, receiver): unknown {
					if (key === "kind" && mode === "tag") return 7;
					if (key === "payload" && mode === "payload") return { value: 1.5, writable: 7 };
					if (key === "payload" && mode === "throw")
						throw new Error("tagged getter failed");
					return Reflect.get(target, key, receiver);
				},
			}),
		);
	} catch (error) {
		rejected =
			error instanceof Error &&
			(mode !== "throw" || error.message === "tagged getter failed");
	}
	check(
		rejected && tagged_calls() === before,
		"failed tagged construction never enters C",
	);
}
let invalidResult = false;
try {
	tagged_make(7, 0);
} catch (error) {
	invalidResult = error instanceof TypeError;
}
check(
	invalidResult && tagged_take(tagged_make(1, 2)) === 5,
	"unknown native tags throw and later calls remain valid",
);
for (const run of [tagged_callback, callbackAsync]) {
	check(
		tagged_take(await run(() => tagged_make(2, 13))) === 42,
		"JavaScript constructs const tagged callback results",
	);
}
console.log("const tagged passed");
