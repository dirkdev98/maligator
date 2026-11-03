/* oxlint-disable no-console -- Reports observable conversion and ownership behavior. */
import * as c from "maligator:ffi/transactions";
import { createWorkerUrl, Worker } from "maligator:workers";
import { checkArrays } from "./arrays.ts";
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
	check(
		caught instanceof RangeError,
		`preserves the conversion error: ${String(caught)}`,
	);
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
	let reacquired = false;
	try {
		c.tx_acquire();
		reacquired = true;
	} catch (error) {
		check(
			error instanceof TypeError,
			"pending native retirement rejects acquisition with TypeError",
		);
	}
	c.tx_register(null);
	check(
		c.tx_destroyed() === before + 2,
		"last registration release destroys an abandoned manual resource once",
	);
	check(!reacquired, "an abandoned native lease cannot create a second owning wrapper");
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
{
	const before = c.tx_destroyed();
	const nested = c.tx_choice_box();
	const output = c.tx_choice_out().value;
	check(
		nested.marker === 7 &&
			c.tx_choice_sum(nested.choice) === 158 &&
			output.first === output.second &&
			output.empty === null &&
			c.tx_choice_sum(output) === 158,
		"nested and out-parameter selected unions transfer their active fields",
	);
	nested.choice.first![Symbol.dispose]();
	output.first![Symbol.dispose]();
	check(
		c.tx_destroyed() === before + 2,
		"nested and output union resources dispose independently",
	);
}
for (const invoke of [c.tx_choice, c.choiceAsync]) {
	const before = c.tx_destroyed();
	await rangeFailure(() => invoke(1, 0));
	check(
		c.tx_destroyed() === before + 1,
		"selected union failure frees its owned field once",
	);
	const value = await invoke(0, 0);
	check(
		value.result.first === value.other &&
			value.result.second === value.other &&
			value.result.empty === null &&
			c.tx_choice_sum(value.result) === 158,
		"selected union results preserve aliases and lend fields back as inputs",
	);
	value.other![Symbol.dispose]();
	check(
		c.tx_destroyed() === before + 2,
		"selected union success commits one resource lifetime",
	);
	const prior = c.tx_borrow(107)!;
	const borrowedBefore = c.tx_destroyed();
	await rangeFailure(() => invoke(1, 1));
	check(
		c.tx_read(prior) === 107,
		"selected union rollback preserves a prior borrowed alias",
	);
	prior[Symbol.dispose]();
	check(
		c.tx_destroyed() === borrowedBefore,
		"selected union failure does not adopt borrowed ownership",
	);
	c.tx_clear();
}
{
	const value = c.tx_const_choice();
	check(
		value.first === value.second &&
			value.empty === null &&
			c.tx_const_choice_sum(value) === 158,
		"const promoted union members transfer fields and support borrowed inputs",
	);
	value.first![Symbol.dispose]();
}
for (const invoke of [c.tx_choice_release, c.choiceReleaseAsync]) {
	const before = c.tx_destroyed();
	watch(() => {});
	await rangeFailure(() => invoke(1));
	watch(null);
	check(
		c.tx_destroyed() === before + 1,
		"cleanup failure rolls back a selected union field",
	);
	if (failNextCell !== undefined) {
		watch(failNextCell);
		let error: unknown;
		try {
			await invoke(0);
		} catch (caught) {
			error = caught;
		}
		watch(null);
		check(
			error instanceof Error && error.message === "Out of memory",
			"selected union assembly can fail",
		);
		check(
			c.tx_destroyed() === before + 2,
			"assembly failure rolls back a converted union field",
		);
	}
	const acquired: { value: c.TxResource | null } = { value: null };
	const acquiredBefore = c.tx_destroyed();
	watch(() => {
		acquired.value = c.tx_acquire();
	});
	await rangeFailure(() => invoke(1));
	watch(null);
	check(
		acquired.value !== null &&
			c.tx_read(acquired.value) === 61 &&
			c.tx_destroyed() === acquiredBefore,
		"nested acquisition retains a union field when outer delivery fails",
	);
	acquired.value[Symbol.dispose]();
}
{
	let lent: c.TxResource | null = null;
	check(
		c.tx_choice_visit((value) => {
			lent = value.first;
			return c.tx_choice_sum(value);
		}) === 158,
		"callback unions lend selected fields during the invocation",
	);
	let closed = false;
	try {
		c.tx_read(lent!);
	} catch (error) {
		closed = error instanceof TypeError;
	}
	check(closed, "callback union fields expire without taking C ownership");
}
{
	const before = c.tx_destroyed();
	const prior = c.tx_recycled()!;
	const closing = c.destroyResourceAsync(prior);
	const value = c.tx_choice_fresh();
	await closing;
	check(
		value.first !== prior &&
			value.first === value.second &&
			c.tx_read(value.first!) === 101,
		"fresh selected fields start a distinct lifetime at a closing address",
	);
	value.first![Symbol.dispose]();
	check(
		c.tx_destroyed() === before + 2,
		"old and fresh union lifetimes each release once",
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
	worker.port.postMessage("choice");
	await admitted;
	while (c.tx_choice_started() === 0)
		await new Promise((resolve) => {
			setTimeout(resolve, 1);
		});
	await worker.terminate();
	check(
		c.tx_destroyed() === before + 1,
		"native abandonment releases selected union fields once",
	);
}
for (const invoke of [c.tx_special_borrowed, c.specialBorrowedAsync]) {
	const prior = c.tx_base(113)!;
	const before = c.tx_destroyed();
	await rangeFailure(() => invoke(1));
	let refined = false;
	try {
		Reflect.apply(c.tx_special_read, undefined, [prior]);
		refined = true;
	} catch (error) {
		check(error instanceof TypeError, "borrowed view rejection preserves its error type");
	}
	check(
		c.tx_base_read(prior) === 113,
		"failed borrowed refinement preserves its base handle",
	);
	prior[Symbol.dispose]();
	check(
		c.tx_destroyed() === before,
		"failed borrowed refinement leaves C ownership unchanged",
	);
	c.tx_clear();
	check(!refined, "failed borrowed-only delivery does not publish a refined type view");
}
function supportsSpecial(value: c.TxBase): boolean {
	try {
		Reflect.apply(c.tx_special_read, undefined, [value]);
		return true;
	} catch (error) {
		check(error instanceof TypeError, "a rejected pointer view throws TypeError");
		return false;
	}
}
for (const invoke of [c.tx_special_borrowed, c.specialBorrowedAsync]) {
	const prior = c.tx_base(113)!;
	const before = c.tx_destroyed();
	const delivered = await invoke(0);
	check(
		Object.is(delivered.result, prior) && supportsSpecial(prior),
		"successful borrowing publishes a view on the canonical wrapper",
	);
	prior[Symbol.dispose]();
	check(
		c.tx_destroyed() === before,
		"successful borrowing does not acquire a destructor",
	);
	c.tx_clear();
}
for (const invoke of [c.tx_special_borrowed_pair, c.specialBorrowedPairAsync]) {
	const prior = c.tx_base(113)!;
	const before = c.tx_destroyed();
	await rangeFailure(() => invoke(1));
	check(
		!supportsSpecial(prior) && c.tx_base_read(prior) === 113,
		"an owned sibling does not publish a failed borrowed refinement",
	);
	prior[Symbol.dispose]();
	check(
		c.tx_destroyed() === before + 1,
		"mixed delivery releases only the independently owned sibling",
	);
	c.tx_clear();
}
for (const invoke of [c.tx_base_special, c.baseSpecialAsync]) {
	const before = c.tx_destroyed();
	await rangeFailure(() => invoke(1));
	check(
		c.tx_destroyed() === before + 1,
		"a borrowed base inventoried first uses the owned alias destructor on rollback",
	);
	const delivered = await invoke(0);
	check(
		Object.is(delivered.result, delivered.owned) &&
			c.tx_special_read(delivered.owned!) === 131,
		"borrowed base and owning derived outputs share one canonical handle",
	);
	delivered.owned![Symbol.dispose]();
	check(
		c.tx_destroyed() === before + 2,
		"the derived ownership policy commits once after a borrowed base",
	);
}
for (const invoke of [c.tx_special_borrowed_release, c.specialBorrowedReleaseAsync]) {
	for (const refined of [false, true]) {
		const prior = c.tx_base(113)!;
		const before = c.tx_destroyed();
		let alias: c.TxBase | null = null;
		watch(() => {
			alias = refined ? c.tx_special_peek() : c.tx_base_peek();
		});
		await rangeFailure(() => invoke(1, 0));
		watch(null);
		check(
			Object.is(alias, prior) && supportsSpecial(prior) === refined,
			"outer rollback preserves only independently delivered refinements",
		);
		prior[Symbol.dispose]();
		check(c.tx_destroyed() === before, "nested borrowing leaves C ownership unchanged");
		c.tx_clear();
	}
	const before = c.tx_destroyed();
	let alias: c.TxBase | null = null;
	watch(() => {
		alias = c.tx_base_peek();
	});
	await rangeFailure(() => invoke(1, 1));
	watch(null);
	check(
		c.tx_base_read(alias!) === 137 && supportsSpecial(alias!),
		"an independently delivered new canonical wrapper keeps its observed primary type",
	);
	alias![Symbol.dispose]();
	check(
		c.tx_destroyed() === before,
		"failed outer borrowing never frees an independently delivered allocation",
	);
	c.tx_clear();
	watch(() => {});
	await rangeFailure(() => invoke(1, 1));
	watch(null);
	const later = c.tx_base_peek()!;
	check(
		!supportsSpecial(later) && c.tx_base_read(later) === 137,
		"an undelivered borrowed wrapper does not leave a failed primary type registered",
	);
	later[Symbol.dispose]();
	c.tx_clear();
	let leased: c.TxBase | null = null;
	const leasedBefore = c.tx_destroyed();
	watch(() => {
		leased = c.tx_base_peek();
		c.tx_register(() => c.tx_peek()!);
	});
	await rangeFailure(() => invoke(1, 1));
	watch(null);
	const acquired = c.tx_acquire()!;
	check(
		Object.is(acquired, leased) &&
			c.tx_registered_value() === 137 &&
			c.tx_destroyed() === leasedBefore,
		"native leases retain one canonical borrowed resource across outer failure",
	);
	c.tx_register(null);
	acquired[Symbol.dispose]();
	check(
		c.tx_destroyed() === leasedBefore + 1,
		"independent adoption after borrowed rollback destroys once after native release",
	);
}
let echoedLoan: c.TxBase | null = null;
c.tx_base_visit((loan) => {
	echoedLoan = c.tx_base_echo(loan!);
	check(
		Object.is(echoedLoan, loan) && c.tx_base_read(echoedLoan!) === 139,
		"a borrowed echo preserves its active callback loan identity",
	);
});
let expiredLoan = false;
try {
	c.tx_base_read(echoedLoan!);
} catch (error) {
	expiredLoan = error instanceof TypeError;
}
check(expiredLoan, "a successful borrowed echo does not extend its callback loan");
for (const invoke of [c.tx_special_borrowed_out, c.specialBorrowedOutAsync]) {
	const unexposedBefore = c.tx_destroyed();
	await rangeFailure(() => invoke(2));
	const unexposed = c.tx_base_peek()!;
	check(
		c.tx_base_read(unexposed) === 149 && !supportsSpecial(unexposed),
		"a failed borrowed output leaves C storage intact and discards its unpublished wrapper",
	);
	unexposed[Symbol.dispose]();
	check(
		c.tx_destroyed() === unexposedBefore,
		"borrowed output rollback does not assume destruction responsibility",
	);
	c.tx_clear();
	const delivered = await invoke(0);
	check(
		c.tx_special_read(delivered.out!) === 149,
		"a successful borrowed output is usable",
	);
	const deliveredBefore = c.tx_destroyed();
	delivered.out![Symbol.dispose]();
	check(
		c.tx_destroyed() === deliveredBefore,
		"closing a borrowed out handle leaves its allocation with C",
	);
	c.tx_clear();
	const parent = c.tx_parent_new()!;
	const before = c.tx_destroyed();
	let child: c.TxResource | null = null;
	watch(() => {
		c.tx_parent_bind(parent);
		child = parent.child;
	});
	await rangeFailure(() => invoke(1));
	watch(null);
	check(
		c.tx_read(child!) === 149 && supportsSpecial(child!),
		"a successful owner getter keeps the canonical borrowed wrapper across outer rollback",
	);
	check(
		c.tx_destroyed() === before,
		"failed borrowed delivery does not destroy independently owner-bound storage",
	);
	parent[Symbol.dispose]();
	c.tx_clear();
}
for (const invoke of [c.tx_special_borrowed_inout, c.specialBorrowedInoutAsync]) {
	const base = c.tx_base(157)!;
	const before = c.tx_destroyed();
	await rangeFailure(() => invoke(null, 1));
	check(
		!supportsSpecial(base),
		"a failed borrowed inout from null keeps a prior type view private",
	);
	const initialized = await invoke(null, 0);
	const prior = initialized.value!;
	check(
		Object.is(prior, base) && c.tx_special_read(prior) === 157,
		"nullable borrowed inout accepts an empty slot and returns its canonical pointer",
	);
	await rangeFailure(() => invoke(prior, 1));
	check(
		c.tx_special_read(prior) === 157,
		"failed borrowed inout preserves the input handle",
	);
	const delivered = await invoke(prior, 0);
	check(
		Object.is(delivered.value, prior),
		"borrowed inout returns the canonical input wrapper",
	);
	prior[Symbol.dispose]();
	check(
		c.tx_destroyed() === before,
		"borrowed inout never acquires the input destructor",
	);
	c.tx_clear();
}
async function rejectsRetired(action: () => unknown): Promise<void> {
	let caught: unknown;
	try {
		await action();
	} catch (error) {
		caught = error;
	}
	check(
		caught instanceof TypeError,
		"pending native retirement rejects pointer materialization",
	);
}
for (const drop of [() => Promise.resolve(c.tx_native_drop()), c.nativeDropAsync]) {
	const before = c.tx_destroyed();
	watch(() => {
		c.tx_native_keep(() => c.tx_peek()!);
	});
	await rangeFailure(() => c.tx_reentry(1));
	watch(null);
	for (const action of [
		() => c.tx_acquire(),
		() => c.tx_peek(),
		() => c.tx_existing(0),
		() => c.existingAsync(0),
	])
		await rejectsRetired(action);
	check(
		c.tx_destroyed() === before && c.tx_native_value() === 61,
		"rejected aliases preserve the retired allocation for its native lease",
	);
	await drop();
	check(
		c.tx_native_value() === -1,
		"C release clears its retained pointer before later observations",
	);
	check(
		c.tx_destroyed() === before + 1,
		`the final native lease destroys its retired resource exactly once: expected ${before + 1}, got ${c.tx_destroyed()}`,
	);
	const next = c.tx_create(163)!;
	check(
		c.tx_read(next) === 163,
		"completed native retirement permits later ordinary allocations",
	);
	next[Symbol.dispose]();
}
{
	const before = c.tx_destroyed();
	watch(() => {
		c.tx_register(() => c.tx_peek()!);
	});
	await rangeFailure(() => c.tx_reentry(1));
	watch(() => {
		c.tx_native_keep(() => c.tx_peek()!);
	});
	await rangeFailure(() => c.tx_reentry(1));
	watch(null);
	c.tx_register(null);
	check(
		c.tx_destroyed() === before + 1 && c.tx_native_value() === 61,
		"releasing a non-head retirement preserves the other native lease",
	);
	c.tx_native_drop();
	check(
		c.tx_destroyed() === before + 2,
		"independent retirement entries each release once",
	);
}
{
	const before = c.tx_destroyed();
	watch(() => {
		c.tx_native_keep(() => c.tx_peek()!);
	});
	await rangeFailure(() => c.tx_reentry_recycled(1));
	watch(null);
	await rejectsRetired(() => c.tx_recycled());
	c.tx_native_drop();
	const reused = c.tx_recycled()!;
	check(
		c.tx_read(reused) === 67 && c.tx_destroyed() === before + 1,
		"final lease release makes the same native address available for a new lifetime",
	);
	reused[Symbol.dispose]();
	check(
		c.tx_destroyed() === before + 2,
		"reused storage has an independent destruction lifetime",
	);
}
{
	const before = c.tx_destroyed();
	const worker = new Worker(createWorkerUrl("./retired-worker.ts", import.meta.url));
	const retired = new Promise<void>((resolve) => {
		worker.port.onmessage = () => resolve();
	});
	worker.port.start();
	await worker.ready;
	await retired;
	await rejectsRetired(() => c.tx_acquire());
	const admitted = new Promise<void>((resolve) => {
		worker.port.onmessage = () => resolve();
	});
	worker.port.postMessage("wait");
	await admitted;
	while (c.tx_native_started() === 0)
		await new Promise((resolve) => {
			setTimeout(resolve, 1);
		});
	await worker.terminate();
	check(
		c.tx_destroyed() === before,
		"native abandonment after VM teardown leaves an earlier retired lease intact",
	);
	check(
		c.tx_native_value() === 61,
		"retired storage remains usable by C after its VM exits",
	);
	await rejectsRetired(() => c.tx_peek());
	await c.nativeDropAsync();
	check(
		c.tx_destroyed() === before + 1,
		"foreign-thread release cleans retired storage without its original VM",
	);
}
{
	const before = c.tx_pool_destroyed();
	const worker = new Worker(createWorkerUrl("./pool-worker.ts", import.meta.url));
	const retired = new Promise<void>((resolve) => {
		worker.port.onmessage = () => resolve();
	});
	worker.port.start();
	await worker.ready;
	await retired;
	await worker.terminate();
	c.tx_pool_pause();
	const dropped = c.poolDropAsync();
	while (c.tx_pool_released() === 0)
		await new Promise((resolve) => {
			setTimeout(resolve, 1);
		});
	let next: c.TxPool | null = null;
	let caught: unknown;
	try {
		next = c.tx_pool_create();
	} catch (error) {
		caught = error;
	}
	let calls = 0;
	if (next !== null)
		check(
			c.tx_pool_peek() === next,
			"new aliases follow the admitted fresh pool generation",
		);
	if (next !== null)
		c.tx_pool_watch(next, () => {
			calls++;
		});
	c.tx_pool_continue();
	await dropped;
	if (next === null) c.tx_pool_clear();
	check(
		next !== null,
		`a fresh generation can reuse storage while older cleanup finishes: ${String(caught)}`,
	);
	check(c.tx_pool_generation(next) === 2, "fresh pool storage has its own generation");
	c.tx_pool_signal(next);
	check(
		calls === 1,
		"older cleanup preserves the fresh generation's callback registration",
	);
	next[Symbol.dispose]();
	check(
		c.tx_pool_destroyed() === before + 2,
		"overlapping pool generations each destroy once",
	);
}
await checkArrays();
console.log("result transactions passed");
