---
name: add-feature
description: Add a new feature, function, setting, or option to an existing app or codebase. Use whenever existing code should do something new.
---

# Add a feature

1. Use search_files and read_file to find where similar code lives, and copy its naming and style.
2. Read each file before you change it.
3. Make the change with replace_in_file. Use write_file only for a brand-new file.
4. Add only what was asked for. No extra options, and no reformatting of nearby code.
5. Call read_file on what you changed. Confirm the new code does what was asked, and that existing code is unharmed.
6. If terminal access is on, run the new code with run_command on a sample input and compare the output with what it should be. For a Python function: `python -c "import calc; print(calc.multiply(3, 4))"`. Fix what is wrong and run it again.
7. Tell the user which files changed, how to use the feature, and what the check printed. If you could not run it, say so.
