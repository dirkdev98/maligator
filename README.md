# Maligator

To start with, we are building an ECMA 262 compliant engine. After that we'll see where we
end up. This sounds like a big enough challenge for now :) The goal is purely an exercise
in spec-based implementing, to get to know ECMAScript just a tad more and to get more
experience in building runtimes.

## Design choices

- We depend on V8 to do our memory management and don't do exercises in memory
  optimization of the implementation.
- We depend on V8 to handle internal representations of values like strings and numbers.

## Useful links

- [The Standard](https://tc39.es/ecma262/)

---

## Some wild ideas

We can do anything as long as we put in the work to get there.

- Build a native runtime and compile to bytecode for that runtime.
- Build a new dev-toolchain (linting, formatting, whatevs)
- Perform dynamic type analysis on TypeScript ionputs.
