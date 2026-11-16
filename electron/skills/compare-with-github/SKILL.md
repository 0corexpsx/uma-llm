---
name: compare-with-github
description: Compare this project with a GitHub repository, or see what a GitHub project does and how it differs from the user's code. Needs internet access.
requires: internet
---

# Compare with a GitHub repository

The address looks like https://github.com/OWNER/REPO. If the user gave it earlier in the chat, use that one: do not ask for it again. If the request already holds a <github_repository> block, Uma has read the README and file list: skip steps 1 and 2.

1. Read what the other project is. Call fetch_url on:
   https://raw.githubusercontent.com/OWNER/REPO/HEAD/README.md
   If that fails, call fetch_url on https://github.com/OWNER/REPO itself.
2. See its files. Call fetch_url on:
   https://api.github.com/repos/OWNER/REPO/contents
   The "name" entries are its top files and folders (add /FOLDER to the address to look inside one). Note the languages and the main folders.
3. Read one or two of its key files when the comparison needs it (package.json, the main source file):
   https://raw.githubusercontent.com/OWNER/REPO/HEAD/PATH
4. Now look at the user's project: call list_files on the workspace, then read_file on its README and its package.json or other project file.
5. Answer with a comparison, not two descriptions:
   - What each one is, in one sentence each.
   - What both do.
   - What only the GitHub project does.
   - What only the user's project does.
   - Differences in how they are built: language, framework, engine, how they run.
   - Up to three ideas worth taking from the other project.

Say which files you read on each side. Do not describe a web page as "open in the browser": read it with fetch_url. If internet access is off, tell the user to turn it on in Settings → Agent permissions.
