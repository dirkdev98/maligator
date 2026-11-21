Import `defineLibrary` from `@maligator/cli` to declare the headers and facts that Maligator uses to bind a C library. Point the [`ffi` build option](/api/build#ffi) at the contract file. The CLI loads and validates that file as trusted project code.

Use `find` to describe how to locate the library. Paths in the contract resolve from the contract file's directory. Set `find` in the build configuration's library entry to replace the contract's discovery alternatives on a particular machine.

Follow [Bind a library](/guides/c-libraries) to call C code from an application. Use [`maligator ffi inspect`](/api/cli#ffi-inspect) to see which declarations bind and which need more facts.
