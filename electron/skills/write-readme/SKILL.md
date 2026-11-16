---
name: write-readme
description: Write or update a README or other project documentation. Use whenever the user asks to document something, such as how to build it.
requires: edits
---

# Write a README

1. Call list_files with path "." and depth 2.
2. Call read_file on the build and config files and the main entry point. If a README exists, read it and keep what is still true.
3. Save README.md with write_file. Include only sections you can back up from the files:
   - What the project is
   - Requirements
   - How to build and run it, with the exact commands
   - How the folders are organized
4. Never invent features, commands, badges, or links. Leave out anything you could not confirm, and tell the user what you left out.
5. Tell the user the file was saved, in one or two sentences. Do not paste the whole README into chat.
