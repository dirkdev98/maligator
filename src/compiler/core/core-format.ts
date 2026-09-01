import type {
	CoreEdge,
	CoreFunctionId,
	CoreTerminatorPayload,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

function formatValue(value: CoreValueId): string {
	return `%${value}`;
}

function formatEdge(edge: CoreEdge): string {
	return `b${edge.block}(${edge.arguments.map(formatValue).join(", ")})`;
}

function formatTerminator(payload: CoreTerminatorPayload): string {
	switch (payload.kind) {
		case "jump":
			return `jump ${formatEdge(payload.edge)}`;
		case "branch":
			return `branch ${formatValue(payload.condition)}, ${formatEdge(payload.consequent)}, ${formatEdge(payload.alternate)}`;
		case "guard":
			return `guard ${formatValue(payload.condition)} proves !${payload.fact}, ${formatEdge(payload.success)}, ${formatEdge(payload.fallback)}`;
		case "switch":
			return `switch ${formatValue(payload.discriminant)}, ${payload.cases
				.map(({ value, edge }) => `${JSON.stringify(value)}: ${formatEdge(edge)}`)
				.join(", ")}, default: ${formatEdge(payload.default)}`;
		case "return":
			return `return ${formatValue(payload.value)}`;
		case "throw":
			return `throw ${formatValue(payload.value)}`;
		case "unreachable":
			return "unreachable";
	}
}

function formatFunction(fn: CoreFunctionStore): string {
	const signature = fn.parameters.map(formatValue).join(", ");
	const lines = [`core function ${fn.id}(${signature}) {`];
	for (const block of fn.blockIds()) {
		const parameters = fn
			.blockParameters(block)
			.map(
				(parameter) =>
					`${formatValue(parameter.value)}: ${parameter.representation}${parameter.role === "exception" ? " exception" : ""}`,
			)
			.join(", ");
		const handler = fn.blockHandler(block);
		const formattedHandler =
			handler === undefined
				? ""
				: ` handler b${handler.block}(${handler.arguments.map(formatValue).join(", ")})`;
		lines.push(`  b${block}(${parameters})${formattedHandler}:`);
		for (const instruction of fn.instructionIds(block)) {
			if (fn.instructionKind(instruction) !== "operation") {
				lines.push(
					`    @${instruction} ${formatTerminator(fn.terminatorPayload(instruction))}`,
				);
				continue;
			}
			const outputs = fn.instructionResults(instruction).map(formatValue).join(", ");
			const assignment = outputs.length === 0 ? "" : `${outputs} = `;
			const inputs = fn.instructionOperands(instruction).map(formatValue).join(", ");
			const attributes = fn.instructionAttributes(instruction);
			const formattedAttributes =
				Object.keys(attributes).length === 0 ? "" : ` ${JSON.stringify(attributes)}`;
			lines.push(
				`    @${instruction} ${assignment}${fn.instructionOpcodeName(instruction)}(${inputs})${formattedAttributes}`,
			);
		}
	}
	lines.push("}");
	return lines.join("\n");
}

export function formatCoreFunction(
	program: CoreProgram,
	functionId: CoreFunctionId,
): string {
	return formatFunction(program.function(functionId));
}

export function formatCoreProgram(program: CoreProgram): string {
	return [...program.functionIds()]
		.map((functionId) => formatCoreFunction(program, functionId))
		.join("\n");
}
