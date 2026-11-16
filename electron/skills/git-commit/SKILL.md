---
name: git-commit
description: Save work to Git by reviewing changes and committing them. Use when the user asks to commit or to check what has changed in a repository.
requires: terminal
---

# Git commit

1. Run `git status` with run_command. If this is not a Git repository, tell the user and stop.
2. Run `git diff` and read what changed.
3. Check for files that should not be committed: passwords, keys, .env files, build output, large binaries. If you see any, leave them out and tell the user.
4. Stage files by name with `git add path/to/file`. Do not use `git add .`
5. Commit with a one-line message that says what changed: `git commit -m "Fix crash when the config file is missing"`
6. Run `git log --oneline -3` to confirm it worked.
7. Do not push, reset, rebase, force, or delete branches unless the user asked for that exact action.
8. Tell the user the commit message and which files went in, and which files you left out.
