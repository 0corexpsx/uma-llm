---
name: skill-creator
description: Create a new skill from the user's description of a task they repeat. Use when asked to make, write, or save a skill.
requires: edits
---

# Create a skill

A skill is a folder with one file, SKILL.md: a short header, then the steps. The model sees only the description until the skill is loaded, so the description decides whether it is ever used.

1. If the user did not say what the skill should do and when, ask one short question and stop.
2. Pick a name: lowercase words joined by hyphens, like `weekly-report`. Call list_files with path ".uma/skills" to check the name is free. An empty result means no project skills exist yet, which is fine.
3. Save it with write_file at `.uma/skills/<name>/SKILL.md`, in exactly this form:

   ```
   ---
   name: weekly-report
   description: Build the weekly sales report from the CSV files in data/. Use when asked for the weekly report.
   ---

   # Weekly report

   1. First step, naming the exact tool to call.
   2. Second step.
   ```

4. Write the description as: what it does, then "Use when ...". One line, under 160 characters.
5. Write the steps as a numbered list of at most 12. Each step is one action. Name the tool for it (read_file, search_files, write_file, replace_in_file, run_command) and give exact commands and file names where you know them.
6. End the steps with what to tell the user. Add a line `requires: terminal`, `requires: internet`, or `requires: edits` to the header only if the skill cannot work without that permission.
7. Call read_file on the saved file to confirm it is complete.
8. Tell the user the skill is saved for this project, that it is used when a request matches, and that typing `/<name>` at the start of a message picks it directly.
