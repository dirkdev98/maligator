/* oxlint-disable no-console -- The fixture reports observable native behavior. */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import * as c from "maligator:ffi/managed";
import * as z from "maligator:ffi/zlib";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
function refuses(
	action: () => void,
	kind: typeof TypeError | typeof RangeError,
	message: string,
): void {
	let refused = false;
	try {
		action();
	} catch (error) {
		refused = error instanceof kind;
	}
	check(refused, message);
}

setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;
const textState = c.ManagedText();
check(textState.text === null, "zeroed text state is null");
for (const value of ["", "é\0🙂", "é".repeat(300), "\ud800x"]) {
	textState.text = value;
	collectGarbage();
	check(
		textState.text === (value === "\ud800x" ? "\ufffdx" : value),
		"state snapshots decode private UTF-8",
	);
}
textState.text = "";
check(c.managed_text_empty(textState) === 1, "empty state text has a nonnull pointer");
textState.text = null;
check(
	c.managed_text_empty(textState) === 0 && textState.text === null,
	"null clears pointer and count",
);
const originalText = "é\0🙂";
textState.text = originalText;
check(
	c.managed_text_advance(textState, 2) === 5 && textState.text === "\0🙂",
	"C advances a multibyte cursor",
);
c.managed_text_write(textState, 255);
check(
	String(textState.text) === "\ufffd🙂" && originalText === "é\0🙂",
	"C writes affect private text without mutating the JS input",
);
c.managed_text_advance(textState, 5);
check(String(textState.text) === "", "one-past-end counted text remains an empty string");
for (const mode of [1, 2, 3]) {
	textState.text = "range";
	refuses(
		() => c.managed_text_bad(textState, mode),
		RangeError,
		"C must keep text inside its retained range",
	);
	refuses(() => textState.text, RangeError, "getters reject an invalid C cursor");
}
textState.text = "repair";
check(textState.text === "repair", "assignment repairs an invalid cursor");
refuses(
	() => {
		textState.text = new Uint8Array(1) as never;
	},
	TypeError,
	"text fields accept strings",
);
check(textState.text === "repair", "failed conversion preserves the previous range");
const narrowText = c.ManagedTextNarrow();
narrowText.text = "kept";
refuses(
	() => {
		narrowText.text = "é".repeat(128);
	},
	RangeError,
	"UTF-8 length must fit a narrow C count",
);
check(narrowText.text === "kept", "count overflow preserves the previous text");
textState.text = "before";
const textCall = c.managed_text_wait_async(textState);
c.managed_text_wait_started();
try {
	refuses(() => textState.text, TypeError, "text reads wait for C use through a view");
	refuses(
		() => {
			textState.text = "changed";
		},
		TypeError,
		"text writes wait for C use through a view",
	);
	refuses(
		() => textState[Symbol.dispose](),
		TypeError,
		"text ownership lasts through worker use",
	);
	collectGarbage();
} finally {
	c.managed_text_release();
}
await textCall;
check(
	String(textState.text) === "Qefore",
	"worker writes become visible after its operation retires",
);
textState[Symbol.dispose]();
narrowText[Symbol.dispose]();
const state = c.ManagedState();
const inputBuffer = new ArrayBuffer(6);
new Uint8Array(inputBuffer).set([90, 11, 13, 17, 91, 92]);
const outputBuffer = new ArrayBuffer(9);
new Uint8Array(outputBuffer).fill(99);
state.next_in = new DataView(inputBuffer, 1, 3);
state.next_out = new Uint8Array(outputBuffer, 2, 3);
check(
	Number(state.avail_in) === 3 && Number(state.avail_out) === 3,
	"assignments set byte counts",
);
check(c.managed_abi_size() === 1, "fixed ABI sizes come from the C compiler");
const detached = new ArrayBuffer(1);
detached.transfer();
refuses(
	() => {
		state.next_in = detached;
	},
	TypeError,
	"detached buffers are refused",
);
refuses(
	() => {
		// @ts-expect-error Runtime validation also rejects shared backing stores.
		state.next_in = new SharedArrayBuffer(1);
	},
	TypeError,
	"shared buffers are refused",
);
refuses(() => inputBuffer.transfer(), TypeError, "input retention prevents transfer");
refuses(() => outputBuffer.transfer(), TypeError, "output retention prevents transfer");
check(c.managed_alias(state, state) === 3, "one operation can receive two aliases");
check(
	new Uint8Array(outputBuffer).join(",") === "99,99,11,13,17,99,99,99,99",
	"C respects subview guards",
);
check(
	state.next_in!.byteOffset === 4 && state.next_in!.length === 0,
	"getter follows C input cursor",
);
check(
	state.next_out.byteOffset === 5 && Number(state.total) === 3,
	"getter follows C output cursor",
);
state.next_in = null;
state.next_out = null;
check(state.avail_in === 0 && state.next_in === null, "clearing writes null and zero");
check(inputBuffer.transfer().byteLength === 6, "clearing retires input retention");
check(outputBuffer.transfer().byteLength === 9, "clearing retires output retention");
const immutable = (
	new ArrayBuffer(2) as ArrayBuffer & { transferToImmutable(): ArrayBuffer }
).transferToImmutable();
state.next_in = immutable;
refuses(
	() => {
		state.next_out = immutable;
	},
	TypeError,
	"writable ranges refuse immutable buffers",
);
check(state.next_in!.buffer === immutable, "read-only ranges accept immutable buffers");
state.next_in = null;

const narrow = c.ManagedNarrow();
const retained = new ArrayBuffer(3);
narrow.data = retained;
refuses(
	() => {
		narrow.data = new Uint8Array(256);
	},
	RangeError,
	"count width is checked before assignment",
);
check(
	narrow.length === 3 && narrow.data!.buffer === retained,
	"failed replacement preserves prior range",
);
refuses(() => retained.transfer(), TypeError, "failed replacement preserves prior pin");
narrow[Symbol.dispose]();
check(retained.transfer().byteLength === 3, "disposal retires retained pins");

const shared = new ArrayBuffer(4);
state.next_in = shared;
state.next_out = shared;
state.next_in = null;
refuses(() => shared.transfer(), TypeError, "each retained field holds its own pin");
state.next_out = null;
check(shared.transfer().byteLength === 4, "the final field releases the buffer");
const resizable = new ArrayBuffer(3, { maxByteLength: 8 });
state.next_in = resizable;
refuses(() => resizable.resize(4), TypeError, "retention prevents resizing");
state.next_in = null;
resizable.resize(4);
check(resizable.byteLength === 4, "clearing permits resizing");

for (const view of [
	new Int8Array(3),
	new Uint16Array(3),
	new Float32Array(3),
	new Float64Array(3),
	new BigInt64Array(3),
]) {
	state.next_in = view;
	check(
		Number(state.avail_in) === view.byteLength,
		"typed views pass byte counts rather than element counts",
	);
	state.next_in = null;
}
const changing = new ArrayBuffer(16, { maxByteLength: 32 });
const fixedView = new Uint16Array(changing, 4, 3);
const trackingView = new Uint32Array(changing, 4);
changing.resize(8);
refuses(
	() => {
		state.next_in = fixedView;
	},
	TypeError,
	"shrunken fixed views are out of bounds",
);
state.next_in = trackingView;
check(Number(state.avail_in) === 4, "tracking views follow current whole elements");
state.next_in = null;
changing.resize(3);
refuses(
	() => {
		state.next_in = trackingView;
	},
	TypeError,
	"tracking offsets can become out of bounds",
);
changing.resize(4);
state.next_in = trackingView;
check(Number(state.avail_in) === 0, "an empty tracking view at the end remains valid");
state.next_in = null;
changing.resize(16);
state.next_in = fixedView;
check(Number(state.avail_in) === 6, "fixed views regain their extent after growth");
state.next_in = null;
changing.transfer();
refuses(
	() => {
		state.next_in = fixedView;
	},
	TypeError,
	"detached typed views are refused",
);
refuses(
	() => {
		state.next_in = new Uint8Array(new SharedArrayBuffer(8));
	},
	TypeError,
	"shared typed views are refused",
);

for (const mode of [1, 2, 3]) {
	state.next_in = new Uint8Array([1, 2, 3]);
	refuses(
		() => c.managed_bad(state, mode),
		RangeError,
		"C-produced ranges are checked on return",
	);
	refuses(
		() => {
			void state.next_in;
		},
		RangeError,
		"invalid C ranges never produce a view",
	);
	refuses(
		() => c.managed_copy(state),
		RangeError,
		"invalid C ranges are refused before another C call",
	);
	refuses(
		() => c.managed_many([state]),
		RangeError,
		"arrays cannot bypass invalid state ranges",
	);
	refuses(
		() => c.managed_indirect(state),
		RangeError,
		"inout handles cannot bypass invalid state ranges",
	);
	state.next_in = null;
}
state.next_in = new Uint8Array([1, 2, 3]);
c.managed_bad(state, 4);
check(state.next_in.length === 0, "one-past-end with zero bytes is valid");
c.managed_bad(state, 5);
check(state.next_in === null, "C can clear the remaining range");
state.next_in = null;
const signed = c.ManagedSigned();
signed.data = new Uint8Array([1]);
refuses(() => c.managed_negative(signed), RangeError, "negative C counts are refused");
signed[Symbol.dispose]();

state.next_in = new Uint8Array([19]);
state.next_out = new Uint8Array(1);
c.managed_visit(state, () => {
	refuses(
		() => {
			state.next_in = null;
		},
		TypeError,
		"callbacks cannot replace active state fields",
	);
	refuses(
		() => {
			void state.avail_in;
		},
		TypeError,
		"callbacks cannot inspect active state",
	);
	refuses(
		() => c.managed_copy(state),
		TypeError,
		"callbacks cannot reenter active state",
	);
	refuses(
		() => c.managed_base_copy(state),
		TypeError,
		"base views cannot bypass managed state checks",
	);
	refuses(
		() => state[Symbol.dispose](),
		TypeError,
		"callbacks cannot dispose active state",
	);
});

state.next_in = new Uint8Array([23, 29]);
const asyncOutput = new Uint8Array(2);
state.next_out = asyncOutput;
const pending = c.managed_copy_async(state);
refuses(
	() => {
		void state.next_in;
	},
	TypeError,
	"worker use blocks field reads",
);
refuses(
	() => {
		state.next_out = null;
	},
	TypeError,
	"worker use blocks field writes",
);
refuses(
	() => c.managed_base_copy(state),
	TypeError,
	"worker use blocks C calls through views",
);
refuses(() => c.managed_many([state]), TypeError, "arrays cannot bypass worker use");
refuses(
	() => c.managed_indirect(state),
	TypeError,
	"inout handles cannot bypass worker use",
);
await c.managed_many_async([state]).then(
	() => {
		throw new Error("an overlapping array operation succeeded");
	},
	(error: unknown) =>
		check(error instanceof TypeError, "async arrays reject overlapping operations"),
);
check(
	(await pending) === 2 && asyncOutput.join(",") === "23,29",
	"worker completion reconciles fields",
);
state.next_in = new Uint8Array([47, 53]);
state.next_out = new Uint8Array(2);
check(
	(await c.managed_many_async([state, state])) === 2,
	"async arrays share pins for repeated handles",
);
const pinnedMany = Array.from({ length: 12 }, () => state);
state.next_in = new Uint8Array([61, 67]);
state.next_out = new Uint8Array(2);
check(c.managed_many(pinnedMany) === 2, "arrays beyond the inline pins reach C");
state.next_in = new Uint8Array([71, 73]);
state.next_out = new Uint8Array(2);
check(
	(await c.managed_many_async(pinnedMany)) === 2,
	"async arrays beyond the inline pins reach C",
);
state.next_in = new Uint8Array([59]);
state.next_out = new Uint8Array(1);
const indirect = await c.managed_indirect_async(state);
check(
	indirect.result === 1 && indirect.state === state,
	"inout handle arguments retain canonical identity",
);
state[Symbol.dispose]();

let borrowedRejected: Promise<void> | undefined;
c.managed_lend((loan) => {
	check(
		loan !== null && c.managed_copy(loan) === 0,
		"borrowed state is valid during its callback",
	);
	borrowedRejected = c.managed_many_async([loan]).then(
		() => {
			throw new Error("a worker received callback-owned state");
		},
		(error: unknown) =>
			check(error instanceof TypeError, "async arrays refuse callback-owned state"),
	);
});
await borrowedRejected!;

const resource = c.managed_resource_new(61);
check(
	c.managed_packet({ resources: [resource] }, () => {
		refuses(
			() => resource[Symbol.dispose](),
			TypeError,
			"nested record resources remain pinned through callbacks",
		);
	}) === 61,
	"nested record resources remain readable by C",
);
resource[Symbol.dispose]();
let copied: Promise<number> | undefined;
await new Promise<void>((resolve) => {
	setTimeout(() => {
		copied = c.managed_packet_async({ resources: [c.managed_resource_new(67)] });
		resolve();
	}, 0);
});
collectGarbage();
check(
	(await copied!) === 67,
	"async records trace resources after the input object disappears",
);

let remaining: ReturnType<typeof c.managed_remaining_async> | undefined;
await new Promise<void>((resolve) => {
	setTimeout(() => {
		const owner = c.ManagedState();
		owner.next_in = new Uint8Array([71, 73]);
		remaining = c.managed_remaining_async(owner);
		resolve();
	}, 0);
});
collectGarbage();
const remainingBytes = await remaining!;
check(
	remainingBytes !== null && remainingBytes.join(",") === "71,73",
	"async result copies retain aliased input bytes through allocation",
);

const live = c.ManagedState();
await new Promise<void>((resolve) => {
	setTimeout(() => {
		live.next_in = new Uint8Array([31, 37]);
		resolve();
	}, 0);
});
collectGarbage();
live.next_out = new Uint8Array(2);
check(
	c.managed_copy(live) === 2 && live.next_out.length === 0,
	"the state traces buffers after their views disappear",
);
live[Symbol.dispose]();

const surviving = new ArrayBuffer(2);
await new Promise<void>((resolve) => {
	setTimeout(() => {
		const owner = c.ManagedState();
		owner.next_in = surviving;
		resolve();
	}, 0);
});
collectGarbage();
check(
	surviving.transfer().byteLength === 2,
	"collecting an owner retires a surviving buffer pin",
);

for (const [ownerFirst, size] of [
	[true, 3],
	[false, 3],
	[true, 0],
] as const) {
	let weak: WeakRef<c.ManagedState> | undefined;
	await new Promise<void>((resolve) => {
		setTimeout(() => {
			const first = ownerFirst ? c.ManagedState() : undefined;
			const buffer = new ArrayBuffer(size) as ArrayBuffer & { owner?: c.ManagedState };
			const owner = first ?? c.ManagedState();
			owner.next_in = buffer;
			buffer.owner = owner;
			weak = new WeakRef(owner);
			resolve();
		}, 0);
	});
	// A new WeakRef keeps its target alive through the job that created it.
	await new Promise<void>((resolve) => {
		setTimeout(resolve, 0);
	});
	collectGarbage();
	check(
		weak!.deref() === undefined,
		"retained-buffer cycles collect in either allocation order",
	);
}

function transform(input: Uint8Array, compress: boolean): Uint8Array {
	const stream = z.z_stream();
	let initialized = false;
	try {
		const started = compress
			? z.deflateInit_(stream, z.Z_DEFAULT_COMPRESSION)
			: z.inflateInit_(stream);
		check(
			started === z.Z_OK,
			"real zlib initializes with the header's version and struct size",
		);
		initialized = true;
		stream.next_in = input;
		const bytes: Array<number> = [];
		for (let iteration = 0; iteration < 1000; iteration++) {
			const output = new Uint8Array(compress ? 11 : 9);
			stream.next_out = output;
			const status = compress
				? z.deflate(stream, z.Z_FINISH)
				: z.inflate(stream, z.Z_NO_FLUSH);
			check(status === z.Z_OK || status === z.Z_STREAM_END, "real zlib streaming status");
			const produced = output.length - stream.avail_out;
			check(
				stream.next_out.buffer === output.buffer &&
					stream.next_out.length === stream.avail_out,
				"remaining output aliases the retained buffer",
			);
			for (let index = 0; index < produced; index++) bytes.push(output[index]!);
			if (status === z.Z_STREAM_END) return Uint8Array.from(bytes);
		}
		throw new Error("zlib did not finish");
	} finally {
		if (initialized)
			check(
				(compress ? z.deflateEnd(stream) : z.inflateEnd(stream)) === z.Z_OK,
				"real zlib cleanup",
			);
		stream[Symbol.dispose]();
	}
}
const original = Uint8Array.from({ length: 193 }, (_, index) => (index * 31 + 7) & 255);
const decoded = transform(transform(original, true), false);
check(
	decoded.join(",") === original.join(","),
	"real zlib streaming round trip spans output refills",
);
console.log("managed state passed");
