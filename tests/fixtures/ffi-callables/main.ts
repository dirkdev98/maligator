/* oxlint-disable no-console -- The fixture reports callable ABI behavior. */
import {
	callable_choose,
	callable_choose_async,
	callable_anon,
	callable_from_point,
	callable_double,
	callable_point,
	callable_text,
	callable_apply,
	callable_bytes,
	callable_fixed,
	callable_out,
	callable_factory,
	callable_abi,
	callable_abi_anon,
	callable_table_new,
	callable_table_close,
	callable_table_swap,
	callable_tables_live,
	callable_table_hold_async,
	callable_table_loan,
	CallableState,
	callable_state_init,
} from "maligator:ffi/callables";

function check(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}
function rejects(action: () => void, message: string): void {
	let rejected = false;
	try {
		action();
	} catch (error) {
		rejected = error instanceof TypeError;
	}
	check(rejected, message);
}
const increment = callable_choose(0)!;
const negate = callable_choose(1)!;
check(callable_choose(2) === null, "null target");
check(increment(41) === 42 && negate(5) === -5, "independent targets");
check(
	increment.call(null, 9) === 10 && increment.apply(null, [11]) === 12,
	"call and apply",
);
const bound = increment.bind(null, 13);
check(bound() === 14 && increment.length === 1, "bound target and arity");
check(callable_anon(0)!(5) === 6, "anonymous pointer type");
check(callable_from_point({ x: 1, y: 0 })!(7) === 8, "factory record argument");
check(callable_double()!(1.25) === 2.5, "floating signature");
const added = callable_point()!({ x: 1, y: 2 }, { x: 3, y: 4 });
check(added.x === 4 && added.y === 6, "struct signature");
check(
	callable_text()!(0) === "native text" && callable_text()!(1) === null,
	"string result",
);
check(callable_bytes()!(new Uint8Array([2, 3, 4])) === 9, "hidden byte count");
check(callable_fixed()!(7) === 21, "private macro argument");
const output = callable_out()!(4);
check(output.result === 7 && output.arg2 === 9, "out parameter");
check(callable_factory()!(0)!(8) === 9, "nested function pointer");
check(callable_abi()!(5) === 22, "declared calling convention");
check(callable_abi_anon()!(5) === 22, "anonymous calling convention");
const apply = callable_apply()!;
check(apply(7, (value) => value * 2) === 24, "script callback");
check(apply(5, increment) === 16, "native function as callback");
let thrown = false;
try {
	apply(1, () => {
		throw new Error("callback failure");
	});
} catch (error) {
	thrown = error instanceof Error && error.message === "callback failure";
}
check(thrown, "callback exception");
let rejected = false;
try {
	Reflect.construct(increment, [1]);
} catch (error) {
	rejected = error instanceof TypeError;
}
check(rejected, "constructor rejection");
rejected = false;
try {
	increment("1" as unknown as number);
} catch (error) {
	rejected = error instanceof TypeError;
}
check(rejected, "strict conversion");
for (let index = 0; index < 128; index++) {
	const other = callable_choose(index % 2)!;
	check(other(3) === (index % 2 === 0 ? 4 : -3), "target survives allocation");
}
check(increment(20) === 21 && bound() === 14, "retained targets");
const asynchronous = await callable_choose_async(0);
check(asynchronous!(40) === 41, "worker result");

const table = callable_table_new(0)!;
const savedTransform = table.transform!;
const savedPoint = table.point!;
const savedVisit = table.visit!;
const independent = table.independent!;
check(table.self!(table, 7) === 8, "explicit owner argument");
check(table.abi!(5) === 22 && table.fixed!(7) === 21, "table ABI and macro facts");
const nested = table.factory!(0)!;
const ownedNested = table.owned_factory!(0)!;
check(ownedNested(4) === 5, "inherited owner before close");
callable_table_swap(table, 1);
check(savedTransform(7) === 8 && table.transform!(7) === -7, "pointer snapshots");
check(
	savedTransform.call(null, 2) === 3 && savedTransform.bind(null, 3)() === 4,
	"saved table methods",
);
check(
	savedPoint({
		get x() {
			rejects(() => table[Symbol.dispose](), "owner disposal in getter");
			rejects(() => callable_table_close(table), "owner destruction in getter");
			return 3;
		},
		y: 4,
	}) === 7,
	"owner pinned before conversion",
);
check(
	savedVisit(2, (value) => {
		rejects(() => table[Symbol.dispose](), "owner disposal in callback");
		rejects(() => callable_table_close(table), "owner destruction in callback");
		return value * 3;
	}) === 16,
	"owner pinned through callback",
);
const pending = callable_table_hold_async(table);
rejects(() => savedTransform(1), "worker-owned table");
check((await pending) === -1, "worker table result");
callable_table_close(table);
rejects(() => ownedNested(4), "inherited owner after close");
let readClosed = false;
rejects(
	() =>
		savedPoint({
			get x() {
				readClosed = true;
				return 1;
			},
			y: 2,
		}),
	"closed owner",
);
check(!readClosed, "closed owner rejects before getters");
check(independent(8) === 9 && nested(9) === 10, "library lifetime after table close");

const failing = callable_table_new(0)!;
let conversionFailure = false;
try {
	failing.point!({
		get x(): number {
			throw new Error("conversion failure");
		},
		y: 2,
	});
} catch (error) {
	conversionFailure = error instanceof Error && error.message === "conversion failure";
}
check(conversionFailure, "throwing table argument");
failing[Symbol.dispose]();
const callbackFailure = callable_table_new(0)!;
let callbackFailed = false;
try {
	callbackFailure.visit!(1, () => {
		throw new Error("table callback failure");
	});
} catch (error) {
	callbackFailed = error instanceof Error && error.message === "table callback failure";
}
check(callbackFailed, "throwing table callback");
callbackFailure[Symbol.dispose]();

const empty = callable_table_new(2)!;
check(empty.transform === null, "null table field");
empty[Symbol.dispose]();
let expired: ((value: number) => number) | null = null;
callable_table_loan((loan) => {
	expired = loan!.transform;
	check(expired!(3) === 4, "active loan");
});
rejects(() => expired!(3), "expired table loan");
function retainedTarget(): (value: number) => number {
	const temporary = callable_table_new(0)!;
	return temporary.transform!;
}
function retainedNestedTarget(): (value: number) => number {
	const temporary = callable_table_new(0)!;
	return temporary.owned_factory!(0)!;
}
const retainedTargets = [retainedTarget(), retainedNestedTarget()];
for (let index = 0; index < 128; index++)
	check(callable_choose(0)!(index) === index + 1, "GC allocation");
check(
	retainedTargets[0]!(10) === 11 &&
		retainedTargets[1]!(20) === 21 &&
		callable_tables_live() === retainedTargets.length,
	"captured owners survive GC",
);

const state = CallableState();
callable_state_init(state);
state.data = new Uint8Array([3]);
const stateRun = state.run!;
check(
	stateRun(state, 4, (value) => {
		rejects(() => {
			state.data = new Uint8Array([9]);
		}, "managed owner operation");
		return value * 2;
	}) === 10,
	"managed owner shares argument operation",
);
state.data = new Uint8Array([5]);
check(stateRun(state, 1, (value) => value) === 6, "managed owner operation released");
state[Symbol.dispose]();
rejects(() => stateRun(state, 0, (value) => value), "disposed caller storage");
console.log("native callables passed");
