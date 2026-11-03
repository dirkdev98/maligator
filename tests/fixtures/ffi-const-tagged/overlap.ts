/* oxlint-disable no-console -- The fixture reports observable const union construction. */
import {
	event_make,
	makeEventAsync,
	event_take,
	takeEventAsync,
	event_identity,
	identityEventAsync,
	event_out,
	outEventAsync,
	event_inout,
	inoutEventAsync,
	event_sum,
	sumEventsAsync,
	event_visit,
	visitEventAsync,
	event_callback,
	callbackEventAsync,
	notifyEventAsync,
	event_callback_error,
	callbackEventErrorAsync,
	promoted_event_make,
	makePromotedEventAsync,
	promoted_event_take,
	takePromotedEventAsync,
	tagged_overlap,
	tagged_promoted_overlap,
	tagged_calls,
	offset_event_take,
	nested_event_take,
	bit_event_take,
} from "maligator:ffi/const_tagged";
function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
for (const kind of [0, 1, 2, 3]) {
	for (const run of [event_make, makeEventAsync]) {
		const value = await run(kind, 7);
		const expected = kind === 3 ? 3 : 7;
		check(
			event_take(value) === expected && (await takeEventAsync(value)) === expected,
			"common const tag storage enters C",
		);
		check(
			event_take(event_identity(value)) === expected &&
				event_take(await identityEventAsync(value)) === expected,
			"workers copy the selected active member",
		);
		for (const visit of [event_visit, visitEventAsync])
			check(
				(await visit(value, event_take)) === expected,
				"callbacks copy common-prefix union arguments",
			);
		for (const callback of [event_callback, callbackEventAsync])
			check(
				event_take(await callback(() => value)) === expected,
				"callbacks construct common-prefix const results",
			);
		let saved: typeof value | undefined;
		await notifyEventAsync(value, (received) => {
			saved = received;
		});
		check(
			saved !== undefined && event_take(saved) === expected,
			"queued messages retain independent selected union values",
		);
	}
}
const point = { kind: 1 as const, point: { kind: 1, x: 8 } };
for (const run of [event_inout, inoutEventAsync])
	check(
		event_take((await run(point)).value) === 108 && point.point.x === 8,
		"inout storage preserves const prefixes and independent payloads",
	);
for (const run of [event_out, outEventAsync])
	check(
		event_take((await run()).value) === 17,
		"C initializes const union output buffers",
	);
for (const run of [event_sum, sumEventsAsync])
	check(
		(await run([point, event_make(2, 9)])) === 17,
		"counted arrays construct every active const union member",
	);
for (const run of [promoted_event_make, makePromotedEventAsync]) {
	const value = await run(5);
	check(
		promoted_event_take(value) === 11 && (await takePromotedEventAsync(value)) === 11,
		"promoted anonymous unions share discriminator storage",
	);
}
check(
	promoted_event_take({ kind: 3, id: 5 }) === 5,
	"empty promoted cases still initialize a nonzero discriminator",
);
check(
	tagged_overlap({ kind: 1, payload: 1 }) === 1 &&
		tagged_promoted_overlap({ kind: 1, payload: 1 }) === 1,
	"identical scalar types can share const discriminator storage",
);
check(
	offset_event_take({ kind: 1, point: { prefix: 5, kind: 1, x: 6 } }) === 11,
	"prefix fields and target offsets preserve a later discriminator",
);
check(
	nested_event_take({ kind: 1, point: { kind: 1, value: 9 } }) === 9,
	"nested anonymous prefixes preserve the discriminator representation",
);
check(
	bit_event_take({ kind: 1, point: { kind: 1, value: 12 } }) === 12,
	"shared bit-fields retain their declared width",
);
const before = tagged_calls();
for (const run of [
	() => event_take({ kind: 1, point: { kind: 2, x: 8 } }),
	() => tagged_overlap({ kind: 1, payload: 2 }),
]) {
	let rejected = false;
	try {
		run();
	} catch (error) {
		rejected = error instanceof TypeError;
	}
	check(rejected, "mismatched nested discriminators are rejected");
}
const marker = new Error("field marker");
let caught: unknown;
try {
	event_take({
		kind: 1,
		point: {
			kind: 1,
			get x(): number {
				throw marker;
			},
		},
	});
} catch (error) {
	caught = error;
}
check(
	caught === marker && tagged_calls() === before,
	"failed construction never enters C",
);
for (const run of [event_callback_error, callbackEventErrorAsync]) {
	let thrown: unknown;
	try {
		await run(() => {
			throw marker;
		});
	} catch (error) {
		thrown = error;
	}
	check(thrown === marker, "callback failure initializes one valid zero union member");
}
console.log("const overlap passed");
