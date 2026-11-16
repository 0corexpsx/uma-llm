---
name: organize-files
description: Tidy or reorganize a whole folder of many files. Not for renaming or moving one named file, which needs no skill.
requires: edits
---

# Organize files

Moving files can break projects, so show a plan first.

1. Call list_files with path "." and depth 2.
2. Reply with a plan and stop: a short list of "this file goes there", and which files you would leave alone. Ask the user to confirm. Do not move anything yet.
3. Leave these where they are: project files such as package.json, CMakeLists.txt, and .git, plus anything code refers to by path.
4. Only after the user confirms, use create_folder and then move_file for each item in the plan.
5. Never delete anything as part of tidying. If something looks like junk, list it and let the user decide.
6. Finish by calling list_files, and tell the user what moved.
