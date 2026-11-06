import type { BindingPlan, BoundFunction, JsResult, JsValue } from "./binding-plan.ts";

function inputCallsJavaScript(value: JsValue): boolean {
	switch (value.kind) {
		case "undefined":
		case "boolean":
		case "integer":
		case "float":
		case "bigint":
		case "string":
		case "bytes":
		case "handle":
		case "native":
		case "callable":
			return false;
		case "callback":
		case "record":
		case "tagged":
		case "sequence":
		case "array":
			return true;
		case "union":
			return inputCallsJavaScript(value.of);
	}
}

function resultHasCleanup(
	value: JsResult,
	plan: BindingPlan,
	visiting: ReadonlySet<string> = new Set(),
): boolean {
	if ("free" in value && value.free !== undefined) return true;
	switch (value.kind) {
		case "handle":
			return (
				value.ownership.kind === "owned" &&
				plan.handles.get(value.name)?.destroy !== undefined
			);
		case "record": {
			if (visiting.has(value.name)) return true;
			const nested = new Set(visiting).add(value.name);
			return plan.records
				.get(value.name)!
				.fields.some((field) => resultHasCleanup(field.value, plan, nested));
		}
		case "tagged":
			return value.cases.some((entry) => resultHasCleanup(entry.value, plan, visiting));
		case "array":
		case "sequence":
		case "union":
			return resultHasCleanup(value.of, plan, visiting);
		default:
			return false;
	}
}

/** Native reentry facts leave getter effects and C cleanup callbacks independent. */
export function bindingEffects(
	plan: BindingPlan,
	binding: BoundFunction,
): { readonly input: boolean; readonly native: boolean; readonly cleanup: boolean } {
	return {
		input: binding.params.some(({ value }) => inputCallsJavaScript(value)),
		native:
			binding.callsJavaScript !== false &&
			(plan.hasCallbacks ||
				binding.params.some(({ value }) => value.kind === "callback")),
		cleanup:
			plan.hasCallbacks &&
			(binding.closes !== undefined ||
				binding.initializes !== undefined ||
				binding.params.some(({ value }) => value.kind === "callback") ||
				[binding.returns, ...binding.outputs.map((output) => output.value)].some(
					(value) => resultHasCleanup(value, plan),
				)),
	};
}
