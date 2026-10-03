# Numeric call results and truncating integer arithmetic

- Status: accepted
- Scope: Core normal-result facts, scalar selection and native numeric fusion

Known Math calls may produce scalar results while retaining their coercing inputs,
exceptions, argument evaluation and safepoints. Math.imul and Math.clz32 establish
an exact int32 result on normal completion. Constructor calls do not establish
that fact. The existing primordial identity proof owns builtin recognition;
mutable property lookups retain ordinary calls.

Core can select a truncating integer pair when an addition or subtraction has
exact int32 inputs and its result has one observation: a signed bitwise operation
with an exact int32 external operand. Both instructions must be in the same block.
Aliases, control-flow arguments and exception-handler observations participate in
the use check. Fractional operands, arbitrary multiplication, unsigned shifts and
escaping untruncated intermediates retain ordinary Number arithmetic.

An int32 sum or difference is an exact Number within the signed 33-bit range.
Its signed bitwise consumer observes only the low 32 bits. Native emission uses
unsigned addition or subtraction and the runtime's defined signed-bit conversion,
avoiding signed C overflow. A dedicated temporary is computed at the original
arithmetic instruction; the consumer never reevaluates operands after intervening
calls or register reuse.

The `binary-pairs-truncating-i32` certificate and `int32-operands` guard travel
through allocation and compiler-artifact serialization. Emission guards operands
whose physical representations do not already establish int32. It retains the
original Number intermediate and ordinary operations for failed guards, including
restored artifacts. The compiler-artifact identity changes; the runtime wire
format and interpreted arithmetic stay unchanged.

This transformation leaves loop entry values and tests intact. A loop with an
unknown seed still preserves that seed on zero iterations and performs coercion
only when the original body executes. Specializing the remaining boxed recurrence
would require a separate control-flow proof.
