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
} from "maligator:ffi/callables";

function check(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
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
console.log("native callables passed");
