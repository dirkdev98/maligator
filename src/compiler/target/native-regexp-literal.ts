import {
	nativeVirtualValueFlow,
	validateNativeVirtualValue,
} from "./native-virtual-value.ts";
import type { NativeVirtualValueBody } from "./native-virtual-value.ts";
import {
	decodeVmValueOperand,
	vmExceptionHandlerTargets,
	vmInstructionReadRegisters,
} from "./runtime-image.ts";
import type { BytecodeFunction, BytecodeInstruction } from "./runtime-image.ts";

/**
 * A RegExp construction whose object reaches nothing but one `test` call, or one
 * `exec` call whose result is only compared with null. Native code binds the VM's
 * template matcher at the producer instead of allocating the object, and runs the
 * call against it; the runtime binding falls back to the ordinary construction for
 * anything but %RegExp% over a string pair.
 */
export interface NativeRegExpLiteralSite {
	/** A `CALL_KNOWN` RegExp construction or a `CONSTRUCT`. */
	readonly producerIp: number;
	readonly method: "test" | "exec";
	/** The method load a `CALL` consumer takes its callee from. */
	readonly propertyIp?: number;
	readonly callIp: number;
}

export interface NativeRegExpLiteralAction {
	readonly site: NativeRegExpLiteralSite;
	readonly role: "producer" | "property" | "call";
}

class Rejected extends Error {}

function reject(): never {
	throw new Rejected();
}

function register(operand: number): number | undefined {
	const decoded = decodeVmValueOperand(operand);
	return decoded.kind === "register" ? decoded.register : undefined;
}

function successors(
	instructions: ReadonlyArray<BytecodeInstruction>,
	ip: number,
	body: NativeVirtualValueBody,
	handlers: ReadonlyArray<number | undefined>,
): Array<number> {
	const next: Array<number> = [];
	const handler = handlers[ip];
	if (handler !== undefined) next.push(handler);
	const branch = body.projection?.branches.get(ip);
	if (branch !== undefined) return [...next, branch];
	const instruction = instructions[ip]!;
	if (instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF")
		next.push(instruction.targetIp);
	if (
		instruction.opcode !== "JUMP" &&
		instruction.opcode !== "RETURN" &&
		instruction.opcode !== "THROW" &&
		instruction.opcode !== "LOAD_UNDECLARED"
	)
		next.push(ip + 1);
	return next;
}

/** Whether control reaches `to` only straight from `from`, whose normal flow leads only there. */
function adjacent(
	instructions: ReadonlyArray<BytecodeInstruction>,
	from: number,
	to: number,
	body: NativeVirtualValueBody,
	handlers: ReadonlyArray<number | undefined>,
): boolean {
	const normal = successors(instructions, from, body, handlers).filter(
		(ip) => ip !== handlers[from],
	);
	if (normal.length !== 1 || normal[0] !== to || handlers.includes(to)) return false;
	for (let ip = 0; ip < instructions.length; ip++) {
		if (ip === from || body.projection?.unreachable.has(ip)) continue;
		if (successors(instructions, ip, body, handlers).includes(to)) return false;
	}
	return true;
}

/** Whether `to` is reachable from `from` without passing `avoid`. */
function reachableAvoiding(
	instructions: ReadonlyArray<BytecodeInstruction>,
	from: number,
	to: number,
	avoid: number,
	body: NativeVirtualValueBody,
	handlers: ReadonlyArray<number | undefined>,
): boolean {
	const seen = new Set([from]);
	const pending = [from];
	while (pending.length > 0) {
		for (const next of successors(instructions, pending.pop()!, body, handlers)) {
			if (next === to) return true;
			if (
				next === avoid ||
				next < 0 ||
				next >= instructions.length ||
				body.projection?.unreachable.has(next) ||
				seen.has(next)
			)
				continue;
			seen.add(next);
			pending.push(next);
		}
	}
	return false;
}

function constructionResult(instruction: BytecodeInstruction): number | undefined {
	if (
		instruction.opcode === "CALL_KNOWN" &&
		instruction.operation === "RegExp" &&
		instruction.construct === true &&
		instruction.argumentMode === undefined &&
		instruction.arguments.length === 2
	)
		return instruction.dst;
	if (
		instruction.opcode === "CONSTRUCT" &&
		instruction.exactFunctionIndex === undefined &&
		instruction.arguments.length === 2
	)
		return instruction.dst;
	return undefined;
}

/**
 * Plans every literal site of `fn`. `claimed` holds instructions that other native
 * plans render, and `nullTestedExecCalls` the `exec` calls whose results Core proved
 * are only compared with null; a site takes over the projection of such a call.
 */
export function nativeRegExpLiteralActions(
	fn: BytecodeFunction,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
	body: NativeVirtualValueBody,
	claimed: ReadonlySet<number>,
	nullTestedExecCalls: ReadonlySet<number>,
): ReadonlyMap<number, NativeRegExpLiteralAction> {
	const actions = new Map<number, NativeRegExpLiteralAction>();
	// A suspension would not carry the bound matcher across a resume.
	if (fn.isGenerator || fn.isAsync) return actions;
	const instructions = fn.instructions;
	const handlers = vmExceptionHandlerTargets(instructions.length, fn.handlers);
	const methodName = (instruction: BytecodeInstruction): string | undefined =>
		instruction.opcode === "LOAD_PROPERTY_STATIC"
			? String.fromCharCode(...(stringConstants[instruction.stringIndex] ?? []))
			: undefined;
	const admitsArguments = (
		method: "test" | "exec",
		callIp: number,
		argumentCount: number,
	): boolean =>
		method === "test"
			? argumentCount <= 1
			: argumentCount === 1 && nullTestedExecCalls.has(callIp);

	// Flows run only from constructions that some test or exec could receive.
	const receivers = new Set<number>();
	for (const instruction of instructions) {
		const method = methodName(instruction);
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" &&
			(method === "test" || method === "exec")
		)
			receivers.add(instruction.object);
		else if (
			instruction.opcode === "CALL_KNOWN" &&
			(instruction.operation === "RegExp.prototype.test" ||
				instruction.operation === "RegExp.prototype.exec")
		) {
			const receiver = register(instruction.thisValue);
			if (receiver !== undefined) receivers.add(receiver);
		}
	}
	if (receivers.size === 0) return actions;

	for (const [producerIp, producer] of instructions.entries()) {
		const result = constructionResult(producer);
		if (
			result === undefined ||
			claimed.has(producerIp) ||
			body.projection?.unreachable.has(producerIp) ||
			!receivers.has(result)
		)
			continue;
		const flow = nativeVirtualValueFlow(
			instructions,
			producerIp,
			result,
			new Set(),
			handlers,
			body,
		);
		const readers: Array<number> = [];
		for (const [ip, aliases] of flow) {
			if (ip === producerIp) continue;
			const instruction = instructions[ip]!;
			if (instruction.opcode === "MOVE" || instruction.opcode === "THROW_IF_TDZ")
				continue;
			const reads = body.reads[ip] ?? vmInstructionReadRegisters(instruction);
			if (reads.some((value) => aliases.may.has(value))) readers.push(ip);
		}
		readers.sort((left, right) => left - right);
		let site: NativeRegExpLiteralSite | undefined;
		try {
			if (readers.length === 1) {
				const callIp = readers[0]!;
				const call = instructions[callIp]!;
				const receiver =
					call.opcode === "CALL_KNOWN" ? register(call.thisValue) : undefined;
				const method =
					call.opcode === "CALL_KNOWN" && call.operation === "RegExp.prototype.test"
						? "test"
						: call.opcode === "CALL_KNOWN" && call.operation === "RegExp.prototype.exec"
							? "exec"
							: undefined;
				if (
					call.opcode !== "CALL_KNOWN" ||
					method === undefined ||
					receiver === undefined ||
					call.construct === true ||
					call.argumentMode !== undefined ||
					!admitsArguments(method, callIp, call.arguments.length)
				)
					reject();
				validateNativeVirtualValue(
					instructions,
					producerIp,
					result,
					new Map([[callIp, [receiver]]]),
					reject,
					undefined,
					false,
					new Set(),
					handlers,
					body,
				);
				site = { producerIp, method, callIp };
			} else if (readers.length === 2) {
				const [propertyIp, callIp] = readers as [number, number];
				const property = instructions[propertyIp]!;
				const call = instructions[callIp]!;
				const method = methodName(property);
				if (
					property.opcode !== "LOAD_PROPERTY_STATIC" ||
					call.opcode !== "CALL" ||
					(method !== "test" && method !== "exec") ||
					register(call.thisValue) !== property.object ||
					register(call.callee) !== property.dst ||
					property.dst === property.object ||
					!admitsArguments(method, callIp, call.arguments.length)
				)
					reject();
				validateNativeVirtualValue(
					instructions,
					producerIp,
					result,
					new Map([
						[propertyIp, [property.object]],
						[callIp, [property.object]],
					]),
					reject,
					undefined,
					false,
					new Set(),
					handlers,
					body,
				);
				validateNativeVirtualValue(
					instructions,
					propertyIp,
					property.dst,
					new Map([[callIp, [property.dst]]]),
					reject,
					undefined,
					false,
					new Set(),
					handlers,
					body,
				);
				// The producer binds the site only while the load would find the realm's
				// own method, so nothing between them may run code. A new construction
				// between the load and the call would rebind the site under another load.
				if (
					!adjacent(instructions, producerIp, propertyIp, body, handlers) ||
					reachableAvoiding(instructions, producerIp, callIp, propertyIp, body, handlers)
				)
					reject();
				site = { producerIp, method, propertyIp, callIp };
			}
		} catch (error) {
			if (!(error instanceof Rejected)) throw error;
		}
		if (site === undefined) continue;
		const ips = [site.producerIp, site.propertyIp, site.callIp].filter(
			(ip): ip is number => ip !== undefined,
		);
		if (ips.some((ip) => actions.has(ip) || claimed.has(ip))) continue;
		actions.set(site.producerIp, { site, role: "producer" });
		if (site.propertyIp !== undefined)
			actions.set(site.propertyIp, { site, role: "property" });
		actions.set(site.callIp, { site, role: "call" });
	}
	return actions;
}
