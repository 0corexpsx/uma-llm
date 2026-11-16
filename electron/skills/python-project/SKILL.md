---
name: python-project
description: Set up or fix a Python project: virtual environment, requirements, tracebacks, and pytest.
---

# Python project

1. Call check_environment to confirm python exists. Call list_files to find requirements.txt, pyproject.toml, and the main script.
2. A virtual environment keeps packages inside the project. If there is none and packages are needed, run `python -m venv .venv`, then use `.venv\Scripts\python.exe` for every later command (on macOS and Linux `.venv/bin/python`).
3. Install packages: `.venv\Scripts\python.exe -m pip install -r requirements.txt` (timeout_seconds 600). Ask before installing packages that are not listed.
4. Run the program with the venv python. On a traceback, read the LAST lines first: the error type and the deepest file and line that belong to the project. Call read_file there.
5. Common errors:
   - ModuleNotFoundError: the package is not installed in this venv, or the import name differs from the package name
   - IndentationError / TabError: mixed tabs and spaces near that line
   - FileNotFoundError: the script runs from another folder; build paths from `Path(__file__).parent`
6. Fix with replace_in_file and run again. Run tests with `.venv\Scripts\python.exe -m pytest -q` when there are tests.

Report the command, the result, and what you changed. Never say it works without the run that shows it.
