import type {
	BindingPlan,
	BoundFunction,
	HandleType,
	JsValue,
	MappedConstant,
	NativeType,
} from "./binding-plan.ts";

/**
 * The part of `plan` a program reaches from the exports it reads: those exports, the
 * handle and native types their values can carry, the fields, views and destructors
 * those types' descriptors refer to, and the callable signatures behind function
 * pointer values. An async twin stays only when the program reads it.
 *
 * `hasCallbacks` describes only this library's reachable bindings; a build combines it
 * across libraries, since a shared C dependency can call a callback registered
 * through another library. Family-level facts, such as the view fields every
 * prototype in a family installs, then cover only reachable members: no reachable
 * binding can refine a wrapper into an unread member, so its accessors could only
 * throw. Records, unions and tagged shapes stay complete: the generator emits helpers
 * only for shapes a reachable value needs.
 */
export function reachableBindingPlan(
	plan: BindingPlan,
	exports: ReadonlySet<string>,
): BindingPlan {
	const handles = new Map<string, HandleType>();
	const natives = new Map<string, NativeType>();
	const records = new Set<string>();
	const unions = new Set<string>();
	const tagged = new Set<string>();
	const callables = new Set<string>();
	let hasCallbacks = false;

	const visitSignature = (binding: BoundFunction): void => {
		for (const param of binding.params) {
			if (param.value.kind === "callback") hasCallbacks = true;
			visit(param.value);
		}
		for (const output of binding.outputs) visit(output.value);
		visit(binding.returns);
	};
	const visitHandle = (name: string): void => {
		if (handles.has(name)) return;
		const handle = plan.handles.get(name);
		if (handle === undefined) throw new Error(`binding plan has no handle '${name}'`);
		handles.set(name, handle);
		// The descriptor points at every view and, for a view family, its registry key.
		for (const view of handle.views) visitHandle(view);
		if (handle.views.length > 0) visitHandle(handle.family);
		for (const field of handle.fields) visit(field.value);
	};
	const visit = (value: JsValue): void => {
		switch (value.kind) {
			case "native":
				if (!natives.has(value.name))
					natives.set(value.name, plan.natives.get(value.name)!);
				return;
			case "handle":
				visitHandle(value.name);
				return;
			case "callable":
				if (callables.has(value.name)) return;
				callables.add(value.name);
				if (value.owner !== undefined) visitHandle(value.owner);
				visitSignature(value.signature);
				return;
			case "callback":
				for (const param of value.params) if (typeof param === "object") visit(param);
				visit(value.returns);
				return;
			case "record":
				if (records.has(value.name)) return;
				records.add(value.name);
				for (const field of plan.records.get(value.name)!.fields) visit(field.value);
				return;
			case "union":
				if (unions.has(value.name)) return;
				unions.add(value.name);
				visit(value.of);
				return;
			case "tagged":
				if (tagged.has(value.name)) return;
				tagged.add(value.name);
				for (const entry of value.cases) visit(entry.value);
				return;
			case "array":
			case "sequence":
				visit(value.of);
				return;
			default:
				return;
		}
	};

	const dispatchers = plan.dispatchers.filter((dispatch) => exports.has(dispatch.name));
	const cases = new Set(
		dispatchers.flatMap((dispatch) => dispatch.cases.map((binding) => binding.name)),
	);
	const functions: Array<BoundFunction> = [];
	for (const binding of plan.functions) {
		const async = binding.async !== undefined && exports.has(binding.async);
		if (!async && !exports.has(binding.name) && !cases.has(binding.name)) continue;
		visitSignature(binding);
		if (async || binding.async === undefined) functions.push(binding);
		else {
			const { async: _unread, ...sync } = binding;
			functions.push(sync);
		}
	}
	const constants: Array<MappedConstant> = [];
	for (const constant of plan.constants) {
		if (!exports.has(constant.name)) continue;
		visit(constant.value);
		constants.push(constant);
	}
	for (const name of exports) {
		if (plan.natives.has(name)) visit({ kind: "native", name });
	}
	for (const handle of plan.handles.values())
		if (handle.allocator !== undefined && exports.has(handle.allocator))
			visitHandle(handle.name);

	return {
		...plan,
		functions,
		dispatchers,
		hasCallbacks,
		// Plan order keeps the generated source deterministic.
		natives: new Map([...plan.natives].filter(([name]) => natives.has(name))),
		handles: new Map([...plan.handles].filter(([name]) => handles.has(name))),
		constants,
	};
}
