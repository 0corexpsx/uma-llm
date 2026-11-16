---
name: explain-code
description: Explain how a piece of code works, step by step, without changing it. Use for "how does this work" or "walk me through this".
---

# Explain code

Do not change any files.

1. Find the code. If the user named a file, call read_file on it. If they named a function or feature, call search_files with that one name, then read_file around the match.
2. Read the whole function or class, not only the lines that matched. If it calls a function you need to understand, read that one too. Read at most 5 files.
3. Explain in this order:
   - What it is for, in one sentence.
   - What goes in and what comes out.
   - The steps it takes, in the order they run. Give the line numbers or function names you read.
   - Anything surprising: a side effect, a special case, an assumption it makes.
4. Use plain words. Explain a term the first time you use it. Quote only short pieces of code a tool returned.
5. If part of it lives in a file you did not read, say so instead of guessing what it does.
6. End with one line: where a reader should look next, or what would break if this code changed.
