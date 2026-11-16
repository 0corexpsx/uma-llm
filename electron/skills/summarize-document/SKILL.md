---
name: summarize-document
description: Summarize a long document or text file accurately, keeping its key points and numbers. Use for "summarize" or "what does this say".
---

# Summarize a document

1. If the document is attached to the message, its text is already in front of you: use that and call no tool. If it is a file in the workspace, call file_info on it first.
2. For a workspace file under about 300 lines, call read_file once. For a longer one, call read_file in ranges with start_line and max_lines, at most 3 ranges: the start, the middle, and the end. Note which lines you read.
3. Write the summary in this shape:
   - One sentence: what the document is and who it is for.
   - 3 to 7 key points, each one sentence, in the document's own order.
   - Every important number, date, name, or deadline, copied exactly.
   - Anything the reader must do or decide.
4. Use only what the text says. Do not add background knowledge, opinions, or conclusions the document does not draw.
5. If the text was cut off or you read only part of a long file, say which part you read and that the rest is not covered.
6. Keep it short: about one tenth of the original, and never longer than one screen unless the user asked for detail.
