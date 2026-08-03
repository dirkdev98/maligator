# SQLite amalgamation

- Version: 3.53.3
- Release number: 3530300
- Upstream archive: https://sqlite.org/2026/sqlite-amalgamation-3530300.zip
- Archive SHA3-256: `d45c688a8cb23f68611a894a756a12d7eb6ab6e9e2468ca70adbeab3808b5ab9`
- `sqlite3.c` SHA-256: `87497ab605bedd0dbee27a209c1eeff8c89b229b13f921a7efdbb81a13f779fd`
- `sqlite3.h` SHA-256: `4ff81af4849acabc76fc8349abb926814395072617ca18e08800abf734ab7612`
- Retrieved: 2026-08-03

Only the official `sqlite3.c` and `sqlite3.h` deliverables are vendored. SQLite
has dedicated both files to the public domain:
https://sqlite.org/copyright.html

Do not add the archive's shell or build-system sources here. The compiler embeds
this directory as a build asset and compiles `sqlite3.c` into the host archive;
generated applications never depend on a system-installed SQLite library.
