import { ordinaryFunctionCreate } from "../abstract-operations/function-objects.ts";
import { newDeclarativeEnvironment } from "../execution-contexts/environment-record.ts";
import {
	getCurrentExecutionContext,
	getCurrentRealm,
} from "../execution-contexts/execution-context.ts";
import { normalCompletion } from "../types-and-values/completion-record.ts";
import type { Evaluator } from "./index.ts";

export const FunctionDeclaration: Evaluator<"FunctionDeclaration"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-functions-and-classes.html#sec-runtime-semantics-instantiateordinaryfunctionexpression
	evaluate(node) {
		const name = node.id?.name ?? "anonymous";

		const outerEnv = getCurrentExecutionContext().lexicalEnvironment!;
		const funcEnv = newDeclarativeEnvironment(outerEnv);
		funcEnv.createImmutableBinding(name, false);

		const privateEnv = null;
		const sourceText = "";
		const closure = ordinaryFunctionCreate(
			getCurrentRealm().intrinsics["%Function.prototype%"]!.asObject(),
			sourceText,
			node.params,
			node.body ?? { body: [] },
			"NON-LEXICAL-THIS",
			funcEnv,
			privateEnv,
		);

		// TODO: MakeConstructor
		funcEnv.initializeBinding(name, closure);

		{
			// TODO: Whacky. Once we implement BlockDeclarationInstantiation in Block, we can skip
			// this.

			const env = getCurrentExecutionContext().lexicalEnvironment!;

			env.setMutableBinding(name, closure, false);
		}

		return normalCompletion(closure);
	},
};
