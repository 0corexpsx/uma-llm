---
name: fix-build-errors
description: Fix compiler or linker errors until the build passes (C++, C#, Rust, TypeScript, Java). Use when a build or compile fails.
---

# Fix build errors

Work one error at a time. Do each step with a tool call.

1. Run the build with run_command and read the output. If you do not know the build command, look for build files with list_files (CMakeLists.txt, *.sln, *.vcxproj, package.json, Cargo.toml, *.csproj, build scripts).
2. Take the FIRST error only. Later errors are often caused by it. Note its file, line and code (for example C2065, LNK2019, CS0103, E0308, TS2304).
3. Call read_file on that file with start_line about 20 lines before the error and max_lines 60.
4. Name the cause in one sentence. Common ones:
   - undeclared name: missing #include / using / import, or a typo
   - LNK2019 or "unresolved external": a missing library; add it to the linker settings or `#pragma comment(lib, "name.lib")`
   - type mismatch: convert explicitly, do not cast blindly
   - missing semicolon or brace: the real mistake is often the line before
5. Fix it with replace_in_file. Change only what the error needs.
6. Run the same build command again. Repeat from step 2 with the new first error.
7. Stop after 8 rounds if errors keep coming, and tell the user which errors remain.

Never say the build passed unless the last run_command output shows it passed. Tell the user each fix in one line and paste the final build result line.
