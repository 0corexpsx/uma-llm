---
name: debug-runtime-problem
description: Find why a program runs but behaves wrong: blank window, missing data, freeze, crash. Add logging, run it, read the log.
---

# Debug a program that runs but behaves wrong

Guessing twice in a row is the mistake to avoid. Get evidence first.

1. Ask yourself what should happen and what happens instead. Use the user's exact words.
2. Find the code path with search_files (the function that fills the data, the handler that draws, the loop that freezes). Read it with read_file.
3. If the cause is not certain from reading, add logging. Write lines to a file next to the program, for example `debug.log`, at each step: function entered, how many items were found, return values and error codes. Use replace_in_file to add them.
4. Build, then run the program with run_command. For a window program use `Start-Process` and then `Start-Sleep -Seconds 5`, and stop it with `Stop-Process -Name AppName`.
5. Read the log with read_file. The first step whose numbers are wrong is where the bug is.
6. Fix that step with replace_in_file, build, run, and read the log again to confirm.
7. Remove the logging afterwards, or tell the user it is still there.

Tell the user what the log showed, the cause, and the fix. If you could not run the program, say so and give the user the steps to check it.
