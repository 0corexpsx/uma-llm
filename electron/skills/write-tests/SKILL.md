---
name: write-tests
description: Write automated tests for existing code and run them. Use when the user asks for tests or test coverage.
requires: terminal
---

# Write tests

1. Call read_file on the code to test.
2. Find the test setup. Use list_files and read_file on package.json, pyproject.toml, or CMakeLists.txt. Use the framework the project already has.
3. If it has none, use what needs no install: unittest for Python, node:test for JavaScript, a small test program for C++.
4. Save the tests with write_file, next to any existing tests. Cover normal input, edge cases, and one error case.
5. Run them with run_command. For Python: `python -m unittest <test_file_name_without_.py>`. For JavaScript: `node --test`.
6. If a test fails, decide which is wrong. Fix a mistake in your test. If the code itself has a bug, do not change it: tell the user.
7. Tell the user what is covered, and the real pass and fail counts from the output.
