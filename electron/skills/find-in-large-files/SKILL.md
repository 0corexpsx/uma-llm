---
name: find-in-large-files
description: Find information inside very large files such as logs, data dumps, or disassembly. Use when a file is too big to read in one go.
---

# Find things in large files

Never try to read a large file from start to end.

1. Call file_info on the file to get its size and line count.
2. Call search_files with one exact word or symbol and the file as path. Use words likely to be on the line: ERROR, Exception, a function name, an ID.
3. No matches means change the word. Try up to three different words, then tell the user what you tried.
4. Call read_file with start_line and max_lines to read about 60 lines around the best match.
5. Answer with the line numbers you read, and quote only text a tool returned.
6. Say plainly that you read only those parts, not the whole file.
