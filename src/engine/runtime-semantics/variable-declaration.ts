import {
	getCurrentExecutionContext,
	resolveBinding,
} from "../execution-contexts/execution-context.ts";
import { normalCompletion } from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import { getValue } from "../types-and-values/reference-record.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const VariableDeclaration: Evaluator<"VariableDeclaration"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-let-and-const-declarations-runtime-semantics-evaluation
	evaluate(node) {
		const kind = node.kind;

		for (const declaration of node.declarations) {
			if (kind === "let" || kind === "const" || kind === "var") {
				if (declaration.id.type === "Identifier") {
					{
						// TODO: Whacky. Once we implement BlockDeclarationInstantiation in Block, we can skip
						// this.

						const env = getCurrentExecutionContext().lexicalEnvironment!;

						if (
							kind === "let" ||
							(kind === "var" && !env.hasBinding(declaration.id.name))
						) {
							env.createMutableBinding(declaration.id.name, true);
						} else if (kind === "const") {
							env.createMutableBinding(declaration.id.name, false);
						}
					}

					const lhs = resolveBinding(EngineValue.string(declaration.id.name));

					if (!declaration.init) {
						lhs.initializeReferencedBinding(EngineValue.undefined());
					} else {
						// TODO: Anonymous function definition.

						const rhs = evaluate(declaration.init);
						if (rhs.type === "throw") {
							return rhs;
						}
						lhs.initializeReferencedBinding(getValue(rhs.value));
					}
				} else {
					throw new Error("Destructuring is not yet implemented.");
				}
			}
		}

		return normalCompletion(undefined);
	},
};
