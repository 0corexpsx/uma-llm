---
name: python-script
description: Write a new Python script and run it to confirm it works. Use for automating a task or processing files with Python.
requires: terminal
---

# Python script

1. Call check_environment to confirm Python is installed. If it is not, tell the user and stop.
2. Save the script with write_file, in a file named for what it does. Use only the standard library unless the user asked for a package.
3. Do not hard-code paths the user may want to change. Use command-line arguments with argparse when the script takes input.
4. Run it with run_command: `python script_name.py`
5. If it fails, read the error and run it again. A usage error means it needs arguments: `python script_name.py input.txt`. For a traceback, fix the line it names with replace_in_file first. Do not finish until it has run successfully.
6. Before anything that deletes or overwrites the user's files, stop and ask first. Test on a copy when you can.
7. Tell the user the file name, how to run it, and what it printed.
