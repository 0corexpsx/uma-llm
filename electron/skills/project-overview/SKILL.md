---
name: project-overview
description: Answer "what is this project?" or give a map of a folder. Never for adding, fixing, documenting, or looking something up.
---

# Project overview

Do not change any files.

1. Call list_files with path "." and depth 2.
2. Call read_file on what explains the project, if present: README, package.json, CMakeLists.txt, pyproject.toml, requirements.txt, *.sln.
3. Call read_file on the main entry point, such as main.cpp, main.py, index.html, or src/main.*. Read at most 5 files in total.
4. Reply with:
   - What it is, in one or two sentences.
   - The main folders and what each one holds.
   - How to build or run it, only if a file you read says so. Otherwise say you could not tell.
   - Up to three useful next steps.

Name only files you saw in a tool result.
