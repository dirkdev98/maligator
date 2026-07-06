# Maligator

A lean AOT-compiled JS engine — a JS-to-C compiler and runtime.

**Goals:** performant; small binary size (opt-in features).

## Getting started

```shell
npm install

# Local development script when working on the compiler.
node ./src/index.ts

# Tests (Vitest: `unit` = pure-TS/fast, `native` = builds + runs isolate binaries)
npm test run          # everything, once
npm run test:unit     # fast lane only (watch loop)
npm run test:native   # native feature-acceptance + test262 regression manifest

# ESLint + formatting
npm run lint
npm run format

# Benchmarks (binary size / language-vs-V8 / gc / http; --update records a baseline)
npm run bench

# Test262 (full suite — expensive)
npm run test262
# Curated common-case regression subset
npm run test262:regressions
```

## Background

We started with an ECMA 262 compliant engine in `src/engine`. It is a naive one-to-one
implementation of the spec. Most basic things work for now, but various parts are not
implemented. Things like classes, template literals, generators, async functions and a
whole slew of intrinsics are skipped.

With this implementation I learned a lot about the inner workings of ECMAScript, spec
reading and the ungodly amount of work it is to write a compliant engine. But I also took
some things for granted, like the internal string and number representations of V8 and
garbage collection by V8.

Note that this implementation was removed after [d81418d](https://github.com/dirkdev98/maligator/tree/d81418d79d41f4e964acf33d22693a97367e3c9d).

Now we want to upgrade to a more efficient (hopefully) and interesting approach. An
ahead-of-time compiler to C.

## Structure

- `docs/decisions`: Decision documents for direction changes.
- `runtime`: Our C runtime library
- `src/compiler`: The AOT-compiler source code.

## Useful links

- [The Standard](https://tc39.es/ecma262/multipage)
