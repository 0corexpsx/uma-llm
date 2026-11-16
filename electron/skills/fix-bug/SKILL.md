---
name: fix-bug
description: Find and fix a bug, crash, error message, or failing build in existing code. Use when something is broken or gives the wrong result.
---

# Fix a bug

1. Find the code. Use search_files with one exact word from the error message or a function name, not a sentence.
2. Call read_file around the place it points to. Read the whole function before deciding anything.
3. If terminal access is on and you know how to run it, reproduce the problem with run_command and read the real error.
4. Name the actual cause in one sentence. Do not guess: if you cannot see the cause, read the calling code next.
5. Make the smallest fix with replace_in_file. Do not reformat or rewrite code around it.
6. Run the same command again to confirm the fix. If it still fails, read the new error and repeat from step 4, at most three times.
7. Tell the user the cause, the file you changed, and whether you confirmed the fix by running it. If you could not run it, say so plainly.
