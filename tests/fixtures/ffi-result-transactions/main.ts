/* oxlint-disable no-console -- Reports observable conversion and ownership behavior. */
import * as c from "maligator:ffi/transactions";
import { createWorkerUrl, Worker } from "maligator:workers";
function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}

function watch(callback: (() => void) | null): void {
	c.tx_watch(
		callback === null
			? null
			: (bad) => {
					callback();
					if (bad !== 0) throw new RangeError("result release failure");
				},
	);
}

async function rangeFailure(action: () => unknown): Promise<void> {
	let caught: unknown;
	try {
		await action();
	} catch (error) {
		caught = error;
	}
	check(caught instanceof RangeError, "preserves the conversion error");
}
for (const invoke of [c.tx_pair, c.pairAsync]) {
	for (const distinct of [0, 1]) {
		const before = c.tx_destroyed();
		await rangeFailure(() => invoke(1, distinct));
		check(
			c.tx_destroyed() === before + 1 + distinct,
			"failed new outputs release each resource once",
		);
		const result = await invoke(0, distinct);
		check(
			result.message === "x" && c.tx_read(result.result!) === 17,
			"successful outputs remain usable",
		);
		check(
			(result.result === result.other) === (distinct === 0),
			"output identity follows native aliasing",
		);
		result.result![Symbol.dispose]();
		if (distinct !== 0) result.other![Symbol.dispose]();
		check(
			c.tx_destroyed() === before + 2 * (1 + distinct),
			"successful outputs retain ordinary disposal",
		);
	}
}
for (const invoke of [c.tx_existing, c.existingAsync]) {
	for (const borrowed of [false, true]) {
		const prior = borrowed ? c.tx_borrow(31) : c.tx_create(31);
		const before = c.tx_destroyed();
		await rangeFailure(() => invoke(1));
		check(
			c.tx_destroyed() === before && c.tx_read(prior!) === 31,
			"failed output preserves a prior alias",
		);
		prior![Symbol.dispose]();
		check(
			c.tx_destroyed() === before + (borrowed ? 0 : 1),
			"failed output preserves prior ownership",
		);
		c.tx_clear();
	}
	const prior = c.tx_borrow(37);
	const before = c.tx_destroyed();
	const result = await invoke(0);
	check(
		result.result === prior && result.other === prior,
		"successful adoption keeps canonical identity",
	);
	result.result![Symbol.dispose]();
	check(c.tx_destroyed() === before + 1, "successful conversion commits ownership");
}
for (const invoke of [c.tx_borrowed_result, c.borrowedResultAsync]) {
	const before = c.tx_destroyed();
	await rangeFailure(() => invoke(1));
	check(
		c.tx_destroyed() === before + 1,
		"an earlier borrowed output joins the owned claim",
	);
	const result = await invoke(0);
	check(
		result.result === result.owned && c.tx_read(result.owned!) === 23,
		"borrowed and owned outputs share the committed wrapper",
	);
	result.owned![Symbol.dispose]();
	check(c.tx_destroyed() === before + 2, "borrowed-first output ownership commits once");
}
const failNextCell = (
	globalThis as typeof globalThis & { __mal_fail_next_cell_allocation?: () => void }
).__mal_fail_next_cell_allocation;
if (failNextCell !== undefined) {
	const prior = c.tx_borrow(41);
	const before = c.tx_destroyed();
	let caught: unknown;
	try {
		Reflect.apply(c.tx_arm, undefined, [failNextCell]);
	} catch (error) {
		caught = error;
	}
	check(
		caught instanceof Error && caught.message === "Out of memory",
		"later handle allocation failure remains observable",
	);
	check(
		c.tx_read(prior!) === 41 && c.tx_destroyed() === before + 1,
		"later allocation failure releases only the newly returned resource",
	);
	prior![Symbol.dispose]();
	check(
		c.tx_destroyed() === before + 1,
		"later allocation failure leaves borrowed ownership unchanged",
	);
	c.tx_clear();
}
for (const invoke of [c.tx_existing, c.existingAsync]) {
	const prior = c.tx_base(53);
	const before = c.tx_destroyed();
	await rangeFailure(() => invoke(1));
	check(c.tx_base_read(prior!) === 53, "failed conversion preserves the original view");
	let caught: unknown;
	try {
		Reflect.apply(c.tx_read, undefined, [prior]);
	} catch (error) {
		caught = error;
	}
	check(
		caught instanceof TypeError,
		"failed conversion does not publish an additional type view",
	);
	const result = await invoke(0);
	check(
		result.result === prior && Reflect.apply(c.tx_read, undefined, [prior]) === 53,
		"successful conversion publishes its additional view",
	);
	result.result![Symbol.dispose]();
	check(
		c.tx_destroyed() === before + 1,
		"successful view adoption acquires ownership once",
	);
}
for (const invoke of [c.tx_invalid, c.invalidAsync]) {
	const state = c.TxManaged();
	state.data = new Uint8Array(4);
	const before = c.tx_destroyed();
	await rangeFailure(() => invoke(state));
	check(
		c.tx_destroyed() === before + 1,
		"final managed input validation rolls back resource output",
	);
	state[Symbol.dispose]();
}
for (const invoke of [
	c.tx_reentry,
	c.reentryAsync,
	c.tx_reentry_before,
	c.reentryBeforeAsync,
]) {
	const before = c.tx_destroyed();
	let escaped: ReturnType<typeof c.tx_peek> = null;
	watch(() => {
		escaped = c.tx_peek();
	});
	await rangeFailure(() => invoke(1));
	watch(null);
	check(
		c.tx_destroyed() === before + 1,
		"reentrant borrowed exposure does not leak a failed result",
	);
	let caught: unknown;
	try {
		c.tx_read(escaped!);
	} catch (error) {
		caught = error;
	}
	check(
		caught instanceof TypeError,
		"rollback closes an alias exposed by a result releaser",
	);
	watch(() => {
		c.tx_register(() => c.tx_peek()!);
	});
	await rangeFailure(() => invoke(1));
	watch(null);
	check(
		c.tx_registered_value() === 61 && c.tx_destroyed() === before + 1,
		"native registration keeps an abandoned result alive",
	);
	c.tx_register(null);
	check(
		c.tx_destroyed() === before + 2,
		"last registration release destroys an abandoned manual resource once",
	);
	let acquired: ReturnType<typeof c.tx_acquire> = null;
	watch(() => {
		acquired = c.tx_acquire();
	});
	await rangeFailure(() => invoke(1));
	watch(null);
	check(
		c.tx_read(acquired!) === 61 && c.tx_destroyed() === before + 2,
		"an independent nested ownership commit survives outer rollback",
	);
	acquired![Symbol.dispose]();
	check(c.tx_destroyed() === before + 3, "independent ownership disposes once");
}
for (const invoke of [
	c.tx_reentry,
	c.reentryAsync,
	c.tx_reentry_before,
	c.reentryBeforeAsync,
]) {
	const before = c.tx_destroyed();
	const parent = c.tx_parent_new()!;
	let guarded = 0,
		expectedGuarded = 0;
	let worker: Promise<unknown> = Promise.resolve(null);
	const reads = c.tx_read_entries(),
		inputs = c.tx_input_entries();
	watch(() => {
		c.tx_parent_bind(parent);
		const actions = [
			() => parent.child,
			() => parent.library,
			() => c.tx_peek()![Symbol.dispose](),
			() => c.tx_destroy(c.tx_peek()!),
			() => c.tx_input(c.tx_peek()!, () => {}),
		];
		expectedGuarded = actions.length;
		for (const action of actions) {
			try {
				action();
			} catch (error) {
				if (error instanceof TypeError) guarded++;
				else throw error;
			}
		}
		worker = c.readAsync(c.tx_peek()!).then(
			() => null,
			(error: unknown) => error,
		);
	});
	await rangeFailure(() => invoke(1));
	watch(null);
	check(
		guarded === expectedGuarded && (await worker) instanceof TypeError,
		"provisional resources reject close and escaping input admission",
	);
	check(
		c.tx_read_entries() === reads &&
			c.tx_input_entries() === inputs &&
			c.tx_destroyed() === before + 1,
		"rejected admissions never reach C and preserve one rollback release",
	);
	let closed = false;
	watch(() => {
		const owner = c.tx_acquire()!;
		owner[Symbol.dispose]();
		closed = true;
	});
	let caught: unknown;
	try {
		await invoke(0);
	} catch (error) {
		caught = error;
	}
	watch(null);
	check(
		closed && caught instanceof TypeError && c.tx_destroyed() === before + 2,
		"outer delivery rejects a resource released by an independent owner",
	);
	const result = await invoke(0);
	const resource = "out" in result ? result.out : result.result;
	check(
		("text" in result ? result.text : result.result) === "x" &&
			c.tx_read(resource!) === 61,
		"successful reentrant output conversion remains usable",
	);
	resource![Symbol.dispose]();
	parent[Symbol.dispose]();
}
for (const invoke of [c.tx_reentry_before, c.reentryBeforeAsync]) {
	const before = c.tx_destroyed();
	const marker = new Error("result release marker");
	let alias: ReturnType<typeof c.tx_peek> = null;
	watch(() => {
		alias = c.tx_peek();
		throw marker;
	});
	let caught: unknown;
	try {
		await invoke(0);
	} catch (error) {
		caught = error;
	}
	watch(null);
	check(
		caught === marker && c.tx_destroyed() === before + 1,
		"rollback preserves an exception from a result releaser",
	);
	let closed = false;
	try {
		c.tx_read(alias!);
	} catch (error) {
		closed = error instanceof TypeError;
	}
	check(closed, "an alias exposed before the first owned conversion closes on failure");
}
for (const invoke of [c.tx_reentry_existing, c.reentryExistingAsync]) {
	const prior = c.tx_base(71)!;
	const before = c.tx_destroyed();
	watch(() => {
		c.tx_peek();
	});
	await rangeFailure(() => invoke(1));
	watch(null);
	check(
		Reflect.apply(c.tx_read, undefined, [prior]) === 71,
		"rollback preserves an independent borrowed view acquisition",
	);
	prior[Symbol.dispose]();
	check(c.tx_destroyed() === before, "independent borrowing leaves ownership unchanged");
	c.tx_clear();
}
for (const invoke of [c.tx_reentry, c.reentryAsync]) {
	let depth = 0;
	let acquired: ReturnType<typeof c.tx_acquire> = null;
	const before = c.tx_destroyed();
	watch(() => {
		if (depth++ === 0) acquired = c.tx_reentry_existing(0).result;
		else acquired = c.tx_acquire();
	});
	await rangeFailure(() => invoke(1));
	watch(null);
	check(
		c.tx_read(acquired!) === 61 && c.tx_destroyed() === before,
		"nested ownership commits transfer every ancestor claim",
	);
	acquired![Symbol.dispose]();
}
for (const invoke of [c.tx_reentry_recycled, c.reentryRecycledAsync]) {
	let replacement: ReturnType<typeof c.tx_recycled> = null;
	const before = c.tx_destroyed();
	watch(() => {
		c.tx_acquire()![Symbol.dispose]();
		replacement = c.tx_recycled();
	});
	let caught: unknown;
	try {
		await invoke(0);
	} catch (error) {
		caught = error;
	}
	watch(null);
	check(
		caught instanceof TypeError &&
			c.tx_read(replacement!) === 67 &&
			c.tx_destroyed() === before + 1,
		"stale delivery preserves an independently owned replacement at the same address",
	);
	replacement![Symbol.dispose]();
	check(
		c.tx_destroyed() === before + 2,
		"replacement storage has its own destruction lifetime",
	);
}
for (const invoke of [c.tx_reentry, c.reentryAsync]) {
	const before = c.tx_destroyed();
	watch(() => {
		c.tx_register(() => c.tx_peek()!);
		c.tx_register(null);
	});
	await rangeFailure(() => invoke(1));
	watch(null);
	check(
		c.tx_destroyed() === before + 1,
		"lease release during conversion leaves rollback ownership intact",
	);
	let owner: ReturnType<typeof c.tx_acquire> = null;
	let worker = Promise.resolve(-1);
	watch(() => {
		owner = c.tx_acquire();
		worker = c.readAsync(owner!);
	});
	await rangeFailure(() => invoke(1));
	watch(null);
	check(
		(await worker) === 61 && c.tx_destroyed() === before + 1,
		"an independent owner admits worker use before outer rollback",
	);
	owner![Symbol.dispose]();
	check(
		c.tx_destroyed() === before + 2,
		"worker completion preserves independent ownership",
	);
}
for (const invoke of [c.tx_reentry_before, c.reentryBeforeAsync]) {
	for (const borrowedView of [false, true]) {
		let depth = 0,
			failed = false;
		watch(() => {
			if (depth++ === 0) {
				try {
					c.tx_special_existing(1);
				} catch (error) {
					failed = error instanceof RangeError;
				}
			} else if (borrowedView) c.tx_special_peek();
		});
		const result = await invoke(0);
		watch(null);
		check(
			failed && c.tx_read(result.out!) === 61,
			"a failed nested refinement preserves the originating resource",
		);
		let accepted = false;
		try {
			accepted = Reflect.apply(c.tx_special_read, undefined, [result.out]) === 61;
		} catch (error) {
			check(error instanceof TypeError, "invalid refinement rejects by type");
		}
		check(
			accepted === borrowedView,
			"only successful independent view evidence survives nested conversion failure",
		);
		result.out![Symbol.dispose]();
	}
}
function disposeRecord(value: c.TxRecord): void {
	for (const resource of new Set([
		value.nested.first,
		value.nested.second,
		value.nested.empty,
		value.third,
	]))
		resource?.[Symbol.dispose]();
}
{
	const before = c.tx_destroyed();
	const fields = c.tx_fields();
	check(
		fields.first === fields.second &&
			fields.empty === null &&
			c.tx_read(fields.first!) === 79,
		"direct record delivery preserves resource identity and null fields",
	);
	fields.first![Symbol.dispose]();
	check(c.tx_destroyed() === before + 1, "direct record field owns its resource");
}
for (const invoke of [c.tx_record, c.recordAsync]) {
	const before = c.tx_destroyed();
	await rangeFailure(() => invoke(1));
	check(
		c.tx_destroyed() === before + 2,
		"late failure releases distinct nested record resources once",
	);
	const value = await invoke(0);
	check(
		value.result.nested.first === value.result.nested.second &&
			value.result.nested.empty === null,
		"nested record aliases preserve canonical identity",
	);
	check(
		c.tx_record_sum(value.result) === 147,
		"record inputs borrow their resource fields",
	);
	disposeRecord(value.result);
	check(
		c.tx_destroyed() === before + 4,
		"successful nested record transfers each owned field",
	);
}
for (const invoke of [c.tx_record_existing, c.recordExistingAsync]) {
	const prior = c.tx_borrow(89)!;
	const before = c.tx_destroyed();
	await rangeFailure(() => invoke(1));
	check(
		c.tx_destroyed() === before + 1 && c.tx_read(prior) === 89,
		"failed record transfer preserves the prior borrowed alias",
	);
	prior[Symbol.dispose]();
	check(
		c.tx_destroyed() === before + 1,
		"failed field conversion preserves borrowed ownership",
	);
	c.tx_clear();
	const borrowed = c.tx_borrow(97)!;
	const result = await invoke(0);
	check(
		result.result.nested.first === borrowed && result.other === borrowed,
		"record fields and direct outputs share a committed owner",
	);
	disposeRecord(result.result);
	check(
		c.tx_destroyed() === before + 4,
		"successful fields commit prior ownership exactly once",
	);
}
for (const invoke of [c.tx_record_release, c.recordReleaseAsync]) {
	if (failNextCell !== undefined) {
		const before = c.tx_destroyed();
		watch(failNextCell);
		let error: unknown;
		try {
			await Reflect.apply(invoke, undefined, [0]);
		} catch (caught) {
			error = caught;
		}
		watch(null);
		check(
			error instanceof Error && error.message === "Out of memory",
			`final result assembly failure remains observable: ${String(error)}`,
		);
		check(
			c.tx_destroyed() === before + 2,
			"assembly failure rolls back already converted record fields",
		);
	}
	const before = c.tx_destroyed();
	const exposed: { current: c.TxResource | null } = { current: null };
	watch(() => {
		exposed.current = c.tx_peek();
		c.tx_acquire();
	});
	await rangeFailure(() => invoke(1));
	watch(null);
	check(
		exposed.current !== null &&
			c.tx_read(exposed.current) === 71 &&
			c.tx_destroyed() === before + 1,
		"nested acquisition survives failure of its enclosing record result",
	);
	exposed.current[Symbol.dispose]();
	check(
		c.tx_destroyed() === before + 2,
		"independently acquired field retains its disposal policy",
	);
}
{
	const before = c.tx_destroyed();
	let lent: c.TxResource | null = null;
	check(
		c.tx_record_visit((value) => {
			lent = value.nested.first;
			return c.tx_record_sum(value);
		}) === 147,
		"callback records lend fields while their invocation is active",
	);
	let closed = false;
	try {
		c.tx_read(lent!);
	} catch (error) {
		closed = error instanceof TypeError;
	}
	check(
		closed && c.tx_destroyed() === before + 2,
		"callback record loans expire without adopting C ownership",
	);
}
{
	const before = c.tx_destroyed();
	const prior = c.tx_recycled()!;
	const closing = c.destroyResourceAsync(prior);
	const value = c.tx_fields_fresh();
	await closing;
	check(
		value.first !== prior &&
			value.first === value.second &&
			c.tx_read(value.first!) === 101,
		"fresh record fields retain a new lifetime at a closing address",
	);
	value.first![Symbol.dispose]();
	check(
		c.tx_destroyed() === before + 2,
		"old and fresh record lifetimes each release once",
	);
}
{
	const before = c.tx_destroyed();
	const worker = new Worker(createWorkerUrl("./record-worker.ts", import.meta.url));
	const admitted = new Promise<void>((resolve) => {
		worker.port.onmessage = () => resolve();
	});
	worker.port.start();
	await worker.ready;
	worker.port.postMessage(null);
	await admitted;
	while (c.tx_record_started() === 0)
		await new Promise((resolve) => {
			setTimeout(resolve, 1);
		});
	await worker.terminate();
	check(
		c.tx_destroyed() === before + 2,
		"abandoned async records release every distinct raw field",
	);
}
console.log("result transactions passed");
