---
name: optimize-performance
description: Find why code is slow and make it faster, measuring before and after. Use for "make this faster", "optimize", or "why is this slow".
---

# Make code faster

Measure first. A guess about what is slow is usually wrong.

1. Find out what is slow and how to run it. Call read_file on that code. If the user did not say what is slow, ask one question and stop.
2. If terminal access is on, time it with run_command before changing anything, and keep the number. In PowerShell: `Measure-Command { python script.py }`. If you cannot run it, say at the end that the result is not measured.
3. Read the slow path and look for the usual causes, in this order:
   - work repeated inside a loop that could be done once before it
   - a loop inside a loop over the same large list, where a dictionary or set lookup would do
   - reading a file, running a query, or calling the network once per item instead of once for all
   - building a long string or list piece by piece in a loop
   - loading a whole large file when only part of it is needed
4. Change one thing with replace_in_file. Keep the result identical: same output, same order, same errors.
5. Time it again with the same command and the same input. Keep the change only if it is clearly faster. If it is not, undo it with replace_in_file and try the next cause.
6. Stop when it is fast enough for what the user asked, or when two changes in a row gave nothing.
7. Tell the user what was slow, what you changed, and the two times. Do not claim a speed-up you did not measure.
