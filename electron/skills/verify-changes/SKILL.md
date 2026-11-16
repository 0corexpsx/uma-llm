---
name: verify-changes
description: Check that code edits really work: re-read the changed lines, build, run, and report only what tools showed. Use after any code change.
---

# Verify changes

A change counts only when a tool made it and a tool confirmed it.

1. For each file you changed, call read_file on the changed lines. Check that the edit is there exactly once and that nothing around it broke (braces, indentation, duplicate lines).
2. Build with run_command, using the project's own build command. Read the whole result: warnings about the lines you changed matter too.
3. Run the tests if the project has them (npm test, pytest, dotnet test, cargo test, ctest).
4. Run the program if it can run without a window. For a window program, start it with `Start-Process` and ask the user to check what they see.
5. If any step fails, fix it with replace_in_file and repeat from step 1.

Report like this:
- Changed: file and what changed, one line each
- Build: the result line from the output
- Tests: passed / failed / none
- Not checked: anything you could not run

Never write "fixed", "works", or "build succeeded" without the tool output that shows it.
