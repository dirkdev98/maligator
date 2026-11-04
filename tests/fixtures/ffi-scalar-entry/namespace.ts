import * as c from "maligator:ffi/scalar";
import { scalar_i32 } from "maligator:ffi/scalar";
import { early } from "./namespace-cycle-a.ts";
import { scalar as forwarded } from "./namespace-forward.ts";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}

export function checkNamespaceCalls(): void {
	check(early === 21, "cyclic module initialization reaches the namespace export");
	const before = c.scalar_calls();
	check(c.scalar_i32(7) === 7, "namespace dot call");
	check(c["scalar_i32"](8) === 8, "namespace literal key");
	check(c?.scalar_i32(9) === 9, "optional namespace access");
	check(c.scalar_i32?.(10) === 10, "optional namespace call");
	const extracted = c.scalar_i32;
	check(extracted === scalar_i32 && extracted(11) === 11, "extracted function identity");
	check(forwarded.scalar_i32(12) === 12, "reexported namespace binding");
	check(c.scalar_calls() === before + 6n, "namespace calls enter C exactly once");

	const order: Array<string> = [];
	const key = {
		[Symbol.toPrimitive]() {
			order.push("key");
			return "scalar_i32";
		},
	};
	const argument = {
		get value() {
			order.push("argument");
			return 13;
		},
		get extra() {
			order.push("extra");
			return 14;
		},
	};
	const dynamic = c[key as unknown as "scalar_i32"];
	// @ts-expect-error JavaScript evaluates surplus arguments before the call ignores them.
	check(dynamic(argument.value, argument.extra) === 13, "dynamic namespace key");
	check(order.join(",") === "key,argument,extra", "lookup precedes argument effects");
	order.length = 0;
	check(
		// @ts-expect-error JavaScript evaluates surplus arguments before the call ignores them.
		c.scalar_i32(argument.value, argument.extra) === 13,
		"static namespace call accepts extra evaluated arguments",
	);
	check(
		order.join(",") === "argument,extra",
		"static namespace call keeps argument effects",
	);

	let ordinary: { scalar_i32(value: number): number } = c;
	check(ordinary.scalar_i32(1) === 1, "namespace alias reaches C");
	ordinary = { scalar_i32: (value: number) => value + 200 };
	check(ordinary.scalar_i32(1) === 201, "mutable alias remains dynamic");
	const proxy = new Proxy(c, {
		get(target, name, receiver): unknown {
			if (name === "scalar_i32") return (value: number) => value + 300;
			return Reflect.get(target, name, receiver);
		},
	});
	check(proxy.scalar_i32(1) === 301, "proxy lookup remains observable");
	check(!Reflect.set(c, "scalar_i32", () => 999), "namespace export resists replacement");
	check(
		!Reflect.defineProperty(c, "scalar_i32", { value: () => 999 }),
		"namespace descriptor resists replacement",
	);
	check(c.scalar_i32(15) === 15, "immutable export still reaches C");
}
