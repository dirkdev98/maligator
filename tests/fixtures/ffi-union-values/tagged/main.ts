import {
	anonymous_echo,
	bool_echo,
	default_outer_echo,
	defaulted_echo,
	deep_echo,
	batch_echo,
	envelope_echo,
	multiple_echo,
	nested_echo,
	owner_new,
	owner_read,
	promoted_echo,
	root_echo,
	resource_read,
	resource_visit,
	resource_visit_async,
	signed_echo,
	tagged_array,
	tagged_echo,
	tagged_echo_async,
	tagged_many,
	tagged_out,
	tagged_unknown,
	tagged_update,
	tagged_visit,
	tagged_visit_async,
	wide_echo,
} from "maligator:ffi/tagged";
import type { Resource, TaggedResource } from "maligator:ffi/tagged";

function check(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}
function rejects(call: () => unknown, message: string): void {
	let failed = false;
	try {
		call();
	} catch (error) {
		failed = error instanceof TypeError;
	}
	check(failed, message);
}
const integer = { kind: 11 as const, serial: 1, payload: 42 };
const point = { kind: 12 as const, serial: 2, payload: { x: 3, y: 4 } };
const copiedInteger = tagged_echo(integer);
check(copiedInteger.kind === 11 && copiedInteger.payload === 42, "integer arm");
const copied = tagged_echo(point);
check(
	copied.kind === 12 && copied.payload.x === 3 && copied.payload.y === 4,
	"point arm",
);
check(
	tagged_many([integer, point, { kind: 13, serial: 3 }]) === 45,
	"tagged array input",
);
const array = tagged_array();
check(array !== null && array.length === 3, "tagged array length");
const first = array[0]!;
const last = array[2]!;
check(first.kind === 11 && first.payload === 5, "tagged array output");
check(last.kind === 13 && !("payload" in last), "inactive output storage hidden");
const output = tagged_out().value;
check(output.kind === 11 && output.payload === 42, "tagged output pointer");
check(tagged_update(integer).value.serial === 2, "tagged input output pointer");
let reads = 0;
const order: Array<string> = [];
const source = {
	get kind() {
		reads++;
		order.push("tag");
		return 12 as const;
	},
	get serial() {
		order.push("serial");
		return 4;
	},
	get payload() {
		order.push("payload");
		check(tagged_echo(integer).kind === 11, "getter reentry");
		return { x: 5, y: Array.from({ length: 32 }, (_, i) => ({ i })).length };
	},
};
const fromGetters = tagged_echo(source);
check(
	reads === 1 && order.join(",") === "tag,serial,payload",
	"tag captured before payload getters",
);
check(
	fromGetters.kind === 12 && fromGetters.payload.y === 32,
	"allocating payload getter",
);
const inactive = {
	kind: 13 as const,
	serial: 9,
	get payload() {
		throw new Error("inactive getter");
	},
};
const done = tagged_echo(inactive);
check(done.kind === 13 && !("payload" in done), "inactive input storage skipped");
rejects(
	() =>
		tagged_echo({
			kind: 99,
			get serial() {
				throw new Error("premature serial getter");
			},
		} as never),
	"unknown tag before payload reads",
);
rejects(tagged_unknown, "unknown native tag");
const promoted = {
	kind: 2 as const,
	point: { x: 9, y: 10 },
	get integer() {
		throw new Error("inactive anonymous getter");
	},
};
const anonymous = anonymous_echo(promoted);
check(
	anonymous.kind === 2 && anonymous.point.x === 9 && !("integer" in anonymous),
	"anonymous union promotion",
);
const multiple = multiple_echo({ kind: 1, left_integer: 7, right_real: 2.5 });
check(
	multiple.kind === 1 &&
		multiple.left_integer === 7 &&
		multiple.right_real === 2.5 &&
		!("left_real" in multiple),
	"independent anonymous unions",
);
check(Object.keys(multiple_echo({ kind: 7 })).join(",") === "kind", "no active payload");
const root = root_echo({ kind: 1, point: { kind: 1, x: 8 } });
check(root.kind === 1 && root.point.x === 8, "root union");
rejects(
	() => root_echo({ kind: 1, point: { kind: 2, x: 8 } }),
	"payload discriminator mismatch",
);
const wide = wide_echo({ kind: 18446744073709551615n, payload: 19 });
check(
	wide.kind === 18446744073709551615n && wide.payload === 19,
	"exact wide discriminator",
);
const boolean = bool_echo({ kind: true, payload: 2.5 });
check(
	default_outer_echo({ kind: 1, payload: 7 }).payload === 7,
	"selected arm retains its default union shape",
);
check(boolean.kind === true && boolean.payload === 2.5, "boolean discriminator");
const falseTag = bool_echo({ kind: false, payload: 3 });
check(falseTag.kind === false && falseTag.payload === 3, "false discriminator");
const signed = signed_echo({ kind: -9223372036854775808n, payload: 20 });
check(
	signed.kind === -9223372036854775808n && signed.payload === 20,
	"signed tag minimum",
);
const promotedTag = promoted_echo({ kind: 2, point: { x: 2, y: 3 } });
check(promotedTag.kind === 2 && promotedTag.point.y === 3, "promoted discriminator");
const omitted = {
	kind: 2 as const,
	get payload() {
		throw new Error("default cannot activate payload");
	},
};
check(
	!("payload" in defaulted_echo(omitted)),
	"empty selection overrides union defaults",
);
const nested = nested_echo({ kind: 2, box: { data: { x: 6, y: 7 } } });
check(nested.kind === 2 && nested.box.data.y === 7, "nested union selection");
const deep = deep_echo({ kind: 1, payload: { x: 17, y: 18 } });
check(deep.kind === 1 && deep.payload.y === 18, "successive union boundaries");
const batch = batch_echo({ items: [integer, point] });
check(
	batch.items[1].kind === 12 && batch.items[1].payload.y === 4,
	"tagged fixed array fields",
);
const envelope = envelope_echo({ kind: 1, payload: point });
check(
	envelope.kind === 1 && envelope.payload.kind === 12 && envelope.payload.payload.y === 4,
	"independent nested discriminator",
);
let escaped: Resource | undefined;
function loan(value: TaggedResource): void {
	check(value.kind === 1, "resource discriminator");
	const resource = value.payload[0];
	check(
		resource !== undefined && resource_read(resource) === 42 && resource.value === 19,
		"callback resource loan",
	);
	escaped = resource;
}
resource_visit(loan);
check(escaped !== undefined, "resource callback ran");
rejects(() => resource_read(escaped!), "callback loan expires");
rejects(() => escaped!.value, "callback loan getter expires");
await resource_visit_async(loan);
rejects(() => resource_read(escaped!), "worker callback loan expires");
const visited = tagged_visit(point, (value) => {
	check(value.kind === 12 && value.payload.y === 4, "callback tagged argument");
	return { kind: 11, serial: 8, payload: 27 };
});
check(visited.kind === 11 && visited.payload === 27, "callback tagged result");
const owner = owner_new();
check(owner !== null, "owner allocation");
const guarded = owner_read(owner, {
	kind: 11,
	serial: 4,
	get payload() {
		rejects(() => owner[Symbol.dispose](), "owner pinned during payload getter");
		return 7;
	},
});
check(guarded === 21, "live owner after getter");
owner[Symbol.dispose]();
const asyncValue = await tagged_echo_async(point);
check(asyncValue.kind === 12 && asyncValue.payload.y === 4, "worker tagged result");
const asyncVisited = await tagged_visit_async(point, (value) => {
	check(value.kind === 12 && value.payload.x === 3, "worker callback argument");
	return { kind: 13, serial: 20 };
});
check(
	asyncVisited.kind === 13 && asyncVisited.serial === 20,
	"worker callback tagged result",
);
// oxlint-disable-next-line no-console -- the native runner checks the fixture's completion
console.log("tagged union values passed");
