---
name: refactor-code
description: Restructure code without changing what it does. Use for "refactor", "clean up", "simplify", or splitting a long function or file.
requires: edits
---

# Refactor code

The code must do exactly the same thing afterwards. Fixing bugs and adding features are separate tasks.

1. Call read_file on the code to change. Then call search_files with each function or class name you plan to rename or move, to find every place that uses it.
2. If the project has tests and terminal access is on, run them with run_command first and note the result. If you cannot run anything, tell the user at the end that the change is unverified.
3. Tell the user in two or three lines what you will change, then do it. Make one kind of change at a time:
   - split a long function into smaller named ones
   - remove code that is repeated
   - give a clearer name, updating every use you found in step 1
   - delete code that nothing uses, only when search_files shows no use
4. Edit with replace_in_file, one small piece at a time. Do not rewrite a whole file, change formatting, or reorder code you are not refactoring.
5. Keep every public name, argument, and return value the same unless the user asked to change it.
6. Call read_file on each changed file and check that nothing was lost or left half-edited.
7. Run the same tests or command again. If the result differs from step 2, find what you changed in behaviour and fix it.
8. Tell the user what changed, file by file, and whether the tests still pass.
