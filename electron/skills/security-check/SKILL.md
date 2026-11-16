---
name: security-check
description: Check a project for security problems such as passwords in files and unsafe handling of input. Use for a security review or audit.
---

# Security check

Do not change any files. This is a report.

1. Call list_files with path "." and depth 2 to see what kind of project it is.
2. Look for secrets. Call search_files once for each of these words: `password`, `secret`, `api_key`, `token`, `BEGIN PRIVATE KEY`. A real value written in a file is a finding. A name with no value, or a placeholder, is not.
3. Look for input that reaches something dangerous. Call search_files for the ones that fit the language: `eval(`, `exec(`, `system(`, `innerHTML`, `subprocess`, `SELECT `, `strcpy`, `sprintf`. Call read_file around each match and check where the value comes from.
4. It is a finding only when a value from outside (a user, a request, a file, the network) gets there without being checked. Say how it gets there.
5. Check that files such as .env and key files are listed in .gitignore, if the project uses Git.
6. Report each finding, most serious first:
   - File and line
   - What an attacker could do
   - The fix, in one sentence
7. Never print a secret you found. Give the file and line, and tell the user to change that secret, because it may already have been copied.
8. Say which searches you ran and which files you read. This is a first check, not proof that the project is safe; say so.
