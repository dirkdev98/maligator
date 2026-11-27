import type { RuleTester } from "oxlint/plugins-dev";

// Oxlint 1.93 exports its rule and AST types only through `RuleTester`'s signature.
export type Rule = Parameters<RuleTester["run"]>[1];
export type Context = Parameters<NonNullable<Rule["create"]>>[0];
type Visitor = ReturnType<NonNullable<Rule["create"]>>;
/** The AST node a visitor key receives, such as `AstNode<"MemberExpression">`. */
export type AstNode<Type extends string> = Parameters<NonNullable<Visitor[Type]>>[0];
export type AnyNode = AstNode<"Program">["body"][number]["parent"];
