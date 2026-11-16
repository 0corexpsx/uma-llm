---
name: node-project
description: Work on a Node.js or npm project: npm install, scripts, tests, and module errors such as "Cannot find module" or import problems.
---

# Node.js project

1. Call check_environment to confirm node and npm exist.
2. Call read_file on package.json. Its "scripts" are the real commands: use them instead of guessing.
3. If node_modules is missing, run `npm install` with run_command (timeout_seconds 600).
4. Run the script the task needs (`npm run build`, `npm test`, `npm start`). A server or app that keeps running would block: run it with a timeout, or ask the user to start it.
5. Common errors:
   - "Cannot find module 'x'": the package is missing (`npm install x`) or the path is wrong (check the file exists with list_files).
   - "require is not defined" or "Cannot use import statement": the file uses the other module style. Check "type" in package.json and the file extension (.cjs / .mjs).
   - ERESOLVE: version conflict. Read which packages conflict; do not use --force unless the user agrees.
6. Fix with replace_in_file, then run the same script again to confirm.

Never edit files inside node_modules. Tell the user which commands you ran and their results.
