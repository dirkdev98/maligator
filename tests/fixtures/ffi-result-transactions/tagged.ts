import * as c from "maligator:ffi/transactions";
import { createWorkerUrl, Worker } from "maligator:workers";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
async function failure(
	action: () => unknown,
	type: typeof RangeError | typeof TypeError,
): Promise<void> {
	let caught: unknown;
	try {
		await action();
	} catch (error) {
		caught = error;
	}
	check(caught instanceof type, `tagged conversion error: ${String(caught)}`);
}
function resource(value: c.TxTagged): c.TxResource | null {
	if (value.kind === 1) return value.payload.first;
	if (value.kind === 2) return value.payload.second;
	return null;
}
export async function checkTagged(): Promise<void> {
	for (const invoke of [c.tx_tagged, c.taggedAsync]) {
		for (const kind of [1, 2]) {
			const destroyed = c.tx_destroyed(),
				special = c.tx_special_destroyed();
			await failure(() => invoke(kind, 1, 0), RangeError);
			check(
				c.tx_destroyed() === destroyed + 1 &&
					c.tx_special_destroyed() === special + (kind === 2 ? 1 : 0),
				"failed tagged conversion releases only its active owned payload",
			);
			const value = await invoke(kind, 0, 0);
			check(
				resource(value.result) === value.alias &&
					c.tx_tagged_sum(value.result) === (kind === 1 ? 482 : 241),
				"tagged results retain active resource aliases and input usability",
			);
			value.alias![Symbol.dispose]();
			check(
				c.tx_destroyed() === destroyed + 2 &&
					c.tx_special_destroyed() === special + (kind === 2 ? 2 : 0),
				"tagged results commit the selected ownership policy",
			);
			const prior = c.tx_borrow(263)!;
			const before = c.tx_destroyed();
			await failure(() => invoke(kind, 1, 1), RangeError);
			check(
				c.tx_destroyed() === before && c.tx_read(prior) === 263,
				"failed tagged adoption preserves a prior alias",
			);
			prior[Symbol.dispose]();
			check(
				c.tx_destroyed() === before,
				"failed tagged adoption preserves borrowed ownership",
			);
			c.tx_clear();
		}
		const before = c.tx_destroyed();
		const numeric = await invoke(3, 0, 0),
			empty = await invoke(4, 0, 0);
		check(
			numeric.result.kind === 3 &&
				numeric.result.payload === 1 &&
				empty.result.kind === 4 &&
				!("payload" in empty.result) &&
				c.tx_destroyed() === before,
			"numeric and empty variants leave poisoned inactive pointers unread",
		);
		await failure(() => invoke(77, 0, 0), TypeError);
		check(
			c.tx_destroyed() === before + 1,
			"unknown tags reject without reading inactive storage and release known companion resources",
		);
	}
	for (const invoke of [c.tx_tagged_grid, c.taggedGridAsync]) {
		const destroyed = c.tx_destroyed(),
			special = c.tx_special_destroyed();
		await failure(() => invoke(1), RangeError);
		await failure(() => invoke(2), TypeError);
		check(
			c.tx_destroyed() === destroyed + 4 && c.tx_special_destroyed() === special + 2,
			"mixed tagged array rollback follows row-order ownership",
		);
		const value = await invoke(0);
		check(
			resource(value.result.values[0]) === value.alias &&
				resource(value.result.values[2]) === value.alias &&
				c.tx_tagged_grid_sum(value.result) === 734,
			"mixed tagged arrays preserve aliases across active variants",
		);
		const last = value.result.values[2];
		check(last.kind === 1, "last tagged row selects resource fields");
		value.alias![Symbol.dispose]();
		last.payload.second![Symbol.dispose]();
		check(
			c.tx_destroyed() === destroyed + 6 && c.tx_special_destroyed() === special + 3,
			"mixed tagged array ownership commits once per resource",
		);
	}
	for (const make of [c.tx_tagged_table, c.taggedTableAsync]) {
		const freed = c.tx_tables_freed(),
			special = c.tx_special_destroyed();
		const rows = await make();
		check(
			rows?.length === 3 &&
				resource(rows[0]!) === resource(rows[2]!) &&
				rows[2]!.kind === 1 &&
				c.tx_tables_freed() === freed + 1,
			"counted tagged tables retain active payloads after outer release",
		);
		const last = rows[2]!;
		check(last.kind === 1, "last counted row selects resource fields");
		resource(rows[0]!)![Symbol.dispose]();
		last.payload.second![Symbol.dispose]();
		check(
			c.tx_special_destroyed() === special + 1,
			"counted tagged aliases preserve first ownership policy",
		);
	}
	for (const make of [c.tx_const_tagged, c.constTaggedAsync]) {
		const value = await make();
		check(
			value.kind === 1 &&
				value.payload.first === value.payload.second &&
				c.tx_read(value.payload.first!) === 79,
			"const discriminator snapshots join resource transactions",
		);
		value.payload.first![Symbol.dispose]();
	}
	{
		const value = c.tx_tagged_out().value;
		check(
			value.kind === 1 && c.tx_read(value.payload.first!) === 79,
			"tagged out parameters transfer active ownership",
		);
		value.payload.first![Symbol.dispose]();
		const promoted = c.tx_promoted_tagged();
		check(
			promoted.kind === 1 && c.tx_read(promoted.payload.first!) === 257,
			"tagged payloads preserve promoted owned-field facts",
		);
		promoted.payload.first![Symbol.dispose]();
	}
	for (const make of [c.tx_tagged_fresh, c.taggedFreshAsync]) {
		const destroyed = c.tx_destroyed(),
			special = c.tx_special_destroyed();
		const prior = c.tx_recycled()!;
		let closing: Promise<void> | undefined;
		const value = await make(() => {
			closing = c.destroyResourceAsync(prior);
		});
		await closing;
		check(
			value.value.kind === 1 &&
				value.result !== prior &&
				value.result === value.value.payload.owned &&
				value.result === value.value.payload.fresh &&
				value.result![Symbol.toStringTag] === "TxBase",
			"active tagged freshness preserves first canonical metadata",
		);
		value.value.payload.owned![Symbol.dispose]();
		check(
			c.tx_destroyed() === destroyed + 2 && c.tx_special_destroyed() === special + 1,
			"tagged freshness preserves the first owning destructor",
		);
	}
	{
		const destroyed = c.tx_destroyed(),
			special = c.tx_special_destroyed();
		const prior = c.tx_recycled()!;
		let closing: Promise<void> | undefined;
		await failure(
			() =>
				c.tx_inactive_fresh(() => {
					closing = c.destroyResourceAsync(prior);
				}),
			TypeError,
		);
		await closing;
		check(
			c.tx_destroyed() === destroyed + 1 && c.tx_special_destroyed() === special,
			"inactive fresh payloads cannot renew an earlier closing alias",
		);
	}
	{
		const before = c.tx_destroyed();
		let loan: c.TxTaggedGrid | undefined;
		check(
			c.tx_tagged_visit((value) => {
				loan = value;
				return c.tx_tagged_grid_sum(value);
			}) === 734,
			"tagged callback loans remain usable throughout the invocation",
		);
		await failure(() => c.tx_tagged_grid_sum(loan!), TypeError);
		check(
			c.tx_destroyed() === before + 2,
			"tagged callback loans expire without adopting C ownership",
		);
	}
	const failNextCell = (
		globalThis as typeof globalThis & { __mal_fail_next_cell_allocation?: () => void }
	).__mal_fail_next_cell_allocation;
	if (failNextCell !== undefined) {
		const destroyed = c.tx_destroyed(),
			special = c.tx_special_destroyed();
		let failed = false;
		try {
			Reflect.apply(c.tx_tagged_arm, undefined, [failNextCell]);
		} catch (error) {
			failed = error instanceof Error;
		}
		check(
			failed &&
				c.tx_destroyed() === destroyed + 2 &&
				c.tx_special_destroyed() === special + 1,
			"tagged allocation failure releases active unconverted payloads in row order",
		);
	}

	for (const mode of ["tagged", "constTagged"]) {
		const destroyed = c.tx_destroyed(),
			special = c.tx_special_destroyed(),
			started = c.tx_tagged_started();
		const worker = new Worker(createWorkerUrl("./record-worker.ts", import.meta.url));
		const admitted = new Promise<void>((resolve) => {
			worker.port.onmessage = () => resolve();
		});
		worker.port.start();
		await worker.ready;
		worker.port.postMessage(mode);
		await admitted;
		while (c.tx_tagged_started() === started)
			await new Promise((resolve) => {
				setTimeout(resolve, 1);
			});
		await worker.terminate();
		check(
			c.tx_destroyed() === destroyed + (mode === "tagged" ? 2 : 1) &&
				c.tx_special_destroyed() === special + (mode === "tagged" ? 1 : 0),
			"abandoned tagged results release only active payloads with row-order ownership",
		);
	}
}
