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

/**
 * The exports whose `reachableBindingPlan` has callbacks, from one pass over the plan:
 * named shapes, handle types and callable signatures that reach a callback parameter
 * are found backwards from those parameters, instead of walking a closure per export.
 */
export function callbackExports(plan: BindingPlan): ReadonlySet<string> {
	// Edges between named nodes: `h:` handle types, `c:` callable signatures, `r:`
	// records, `u:` unions and `t:` tagged shapes, each built when first named.
	const edges = new Map<string, Set<string>>();
	const sources = new Set<string>();
	const node = (name: string, build: (into: Set<string>) => boolean): string => {
		if (!edges.has(name)) {
			const into = new Set<string>();
			edges.set(name, into);
			if (build(into)) sources.add(name);
		}
		return name;
	};
	const handleNode = (name: string): string => {
		const handle = plan.handles.get(name)!;
		return node(`h:${name}`, (into) => {
			for (const view of handle.views) into.add(handleNode(view));
			if (handle.views.length > 0) into.add(handleNode(handle.family));
			for (const field of handle.fields) references(field.value, into);
			return false;
		});
	};
	/** Add the nodes `value` names to `into`; true when `value` is itself a callback. */
	const references = (value: JsValue, into: Set<string>): boolean => {
		switch (value.kind) {
			case "handle":
				into.add(handleNode(value.name));
				return false;
			case "callable":
				into.add(node(`c:${value.name}`, (next) => signature(value.signature, next)));
				if (value.owner !== undefined) into.add(handleNode(value.owner));
				return false;
			case "record": {
				const record = plan.records.get(value.name)!;
				into.add(
					node(`r:${value.name}`, (next) => {
						for (const field of record.fields) references(field.value, next);
						return false;
					}),
				);
				return false;
			}
			case "union":
				into.add(node(`u:${value.name}`, (next) => references(value.of, next)));
				return false;
			case "tagged":
				into.add(
					node(`t:${value.name}`, (next) => {
						for (const entry of value.cases) references(entry.value, next);
						return false;
					}),
				);
				return false;
			case "array":
			case "sequence":
				return references(value.of, into);
			case "callback":
				for (const param of value.params)
					if (typeof param === "object") references(param, into);
				references(value.returns, into);
				return true;
			default:
				return false;
		}
	};
	const signature = (binding: BoundFunction, into: Set<string>): boolean => {
		let registers = false;
		for (const param of binding.params)
			registers = references(param.value, into) || registers;
		for (const output of binding.outputs) references(output.value, into);
		references(binding.returns, into);
		return registers;
	};
	// What each export names, and the exports that take a callback themselves.
	const named = new Map<string, Set<string>>();
	const registering = new Set<string>();
	const root = (name: string, visit: (into: Set<string>) => boolean): void => {
		const into = new Set<string>();
		if (visit(into)) registering.add(name);
		named.set(name, into);
	};
	for (const binding of plan.functions)
		root(binding.name, (into) => signature(binding, into));
	for (const constant of plan.constants)
		root(constant.name, (into) => references(constant.value, into));
	for (const handle of plan.handles.values())
		if (handle.allocator !== undefined)
			root(handle.allocator, (into) => {
				into.add(handleNode(handle.name));
				return false;
			});

	const reverse = new Map<string, Array<string>>();
	for (const [from, targets] of edges)
		for (const target of targets) {
			const predecessors = reverse.get(target);
			if (predecessors === undefined) reverse.set(target, [from]);
			else predecessors.push(from);
		}
	const reaching = new Set(sources);
	const queue = [...sources];
	for (let index = 0; index < queue.length; index++)
		for (const predecessor of reverse.get(queue[index]!) ?? [])
			if (!reaching.has(predecessor)) {
				reaching.add(predecessor);
				queue.push(predecessor);
			}
	const reaches = (name: string): boolean =>
		registering.has(name) || [...named.get(name)!].some((target) => reaching.has(target));

	const exports = new Set<string>();
	for (const binding of plan.functions)
		if (reaches(binding.name)) {
			exports.add(binding.name);
			if (binding.async !== undefined) exports.add(binding.async);
		}
	for (const dispatch of plan.dispatchers)
		if (dispatch.cases.some((binding) => reaches(binding.name)))
			exports.add(dispatch.name);
	for (const constant of plan.constants)
		if (reaches(constant.name)) exports.add(constant.name);
	for (const handle of plan.handles.values())
		if (handle.allocator !== undefined && reaches(handle.allocator))
			exports.add(handle.allocator);
	return exports;
}
