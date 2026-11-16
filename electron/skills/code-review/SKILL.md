---
name: code-review
description: Review code for bugs and risks and report findings without changing anything. Use for "review", "audit", or "check this code".
---

# Code review

Do not change any files. This is a report only.

1. Find the code to review with list_files, then call read_file on each relevant file. Read at most 6 files.
2. Look for things that really go wrong: logic errors, unhandled failures, data loss, security holes, wrong edge cases.
3. Skip style opinions unless they hide a bug.
4. Report each finding, most serious first:
   - File and line number or function name
   - What goes wrong, and when it happens
   - The fix, in one sentence
5. Quote only code a tool returned. If you find nothing serious, say so. Do not invent problems to fill the report.
6. List any files you did not read, and offer to fix the top finding.
