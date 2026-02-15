# Maligator

We started with an ECMA 262 compliant engine in `src/engine`. It is a naive one-to-one
implementation of the spec. Most basic things work for now, but various parts are not
implemented. Things like classes, template literals, generators, async functions and a
whole slew of intrinsics are skipped.

With this implementation I learned a lot about the inner workings of ECMAScript, spec
reading and the ungodly amount of work it is to write a compliant engine. But I also took
some things for granted, like the internal string and number representations of V8 and
garbage collection by V8.

Now we want to upgrade to a more efficient (hopefully) and interesting approach. An
ahead-of-time compiler to C.

## Useful links

- [The Standard](https://tc39.es/ecma262/multipage)
