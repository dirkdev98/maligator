# RegExp

## Context

We've reached the point where avoiding `RegExp` isn't viable anymore. A meaningful slice of
test262 needs it, and so does almost any real JavaScript. So we have to deal with it.

Here's the uncomfortable part: regular expressions are one of the handful of spec areas
(alongside Temporal and Intl) that essentially nobody builds from scratch anymore. The
landscape is telling. V8 and SpiderMonkey both run Irregexp. JavaScriptCore has YARR. Boa
leans on the `regress` crate. QuickJS ships Bellard's `libregexp`, which is small,
ES-compliant C and explicitly built to be embedded. Only Porffor hand-rolls one, and it's
deliberately limited.

So the boring, sensible engineering answer is: vendor `libregexp`. It's C, it's MIT, it's
spec-compliant up to a recent edition, and it would drop almost cleanly into our UTF-16
string storage. If shipping features fast were the only goal, that's what we'd do.

But that's not really what this project is for. The goals haven't changed:

- I want to learn JS more.
- I want to learn more about compiler development.

And here's the thing that makes regex special: a regex engine _is_ a compiler and a VM. A
pattern is parsed into an AST, lowered to bytecode, and executed on a backtracking virtual
machine with its own stack and registers. It is a miniature of the exact thing we are
already building. Picking "vendor it" would skip the single most on-theme sub-project we
could possibly take on.

So we build our own.

## Decision

We build our own ECMAScript RegExp engine, in the runtime, in C, structured the same way
the main engine is: **parse → compile to bytecode → execute on a backtracking VM.** These
are the goals that shape it.

**It mirrors the main engine, on purpose.** Same shape, smaller scale. If we understand our
own bytecode VM, we understand this one.

**Backtracking, not finite automata.** JavaScript semantics — backreferences, capture
groups, lookbehind — cannot be expressed by the linear-time NFA approach that RE2 and the
Rust `regex` crate use. We borrow the bytecode instruction-set vocabulary (`split`, `jmp`,
`save`, `char`, `match`) from that world, but we run it as a backtracker.

**The spec's matching algorithm is our oracle.** ECMAScript defines matching in
continuation-passing style. When behaviour is ambiguous — capture visibility on backtrack,
greedy-vs-lazy ordering — we implement to the CPS definition literally rather than guessing.

**The VM never recurses on the C stack.** All backtracking state lives on an explicit,
bounded, heap-allocated stack. Pathological patterns must fail gracefully, not crash the
process. We decide this up front because retrofitting it is painful — the same reasoning
applies to building the matcher to run in either direction from day one, since lookbehind
matches backwards.

**Two layers, and the bigger one isn't the engine.** Layer 1 is the matcher we're excited
about. Layer 2 is the `RegExp` object, `exec`, the `Symbol.*` methods, and the
`String.prototype` integration — and that is where most of the spec volume and most of the
test262 pass rate actually live. Worth naming honestly so we don't fool ourselves that the
fun part is the whole job.

**Our strings already fit.** `MalString` is UTF-16 code units, which is exactly the
matcher's input model. No transcoding, and match offsets come back as JS string indices
directly.

**Our algorithms, canonical data.** Case folding and `\p{}` property tables come from the
Unicode Character Database, via a generator we write. We own the engine; we don't reinvent
Unicode itself. Even ICU is just generated from the UCD.

On scope — what "compliant enough" means for us:

**The modern, non-legacy core.** No Annex B. No lenient legacy grammar, no `RegExp.$1`
statics, no `RegExp.prototype.compile`. We target the strict grammar, and test262's
`annexB` bucket is out of scope by choice.

**Both strict modes, though.** Dropping Annex B is not the same as always behaving as if
`u` is set. Unflagged patterns still match on UTF-16 code units with their own
canonicalization; `u`/`v` patterns match on code points. We keep that duality — it's
semantics, not legacy.

**Start at the core, grow outward.** Literals, quantifiers, groups, classes,
backreferences, and lookaround under both modes are the foundation; `\p{}`, named groups,
and the `d` indices flag build on it. The `v` (unicodeSets) flag and pattern modifiers are
the frontier — desirable, deferred, and not gating the milestone.

## Consequences

It's real work, but of a familiar shape. The matcher itself is bounded and, frankly, the
fun part. The two things that actually dominate the calendar are the **Unicode data
generator** (case folding alone has two distinct canonicalization paths, and `\p{}` is a
lot of tables) and the **Layer 2 spec grind**. Better to name them now than be surprised
later.

We own and can debug every part of it, which is consistent with the rest of the project. No
vendored C, no Rust FFI, no ICU to link. The tree stays clean and the single-binary story
stays simple.

We will not match Irregexp's performance, and we are not trying to. Correctness, ownership,
and learning over raw speed — the same stance we took when we decided skipping a JIT was
fine and leaning on V8's optimizers was "cheating."

We take on a maintenance burden: we pin a Unicode version and regenerate our tables when we
choose to bump it. And we make sure the test262 runner filters out `annexB`-tagged tests, so
a deliberate scope choice doesn't read as a wall of failures.

A whole compiler-and-VM in miniature, living inside the runtime. Of all the spec corners we
could have outsourced, this is the one most worth building ourselves.
