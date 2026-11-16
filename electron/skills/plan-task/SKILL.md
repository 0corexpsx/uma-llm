---
name: plan-task
description: Plan a large task before starting it and save the plan to a file. Use when the user asks for a plan, or for a rewrite or migration.
requires: edits
---

# Plan a task

Write the plan only. Do not start the work until the user agrees.

1. Call list_files with path "." and depth 2, then read_file on the files the task touches. Read at most 6 files. A plan about code you have not read is a guess.
2. If the goal is unclear in a way that changes the plan, ask one question and stop.
3. Save the plan with write_file as PLAN.md, with these parts:
   - **Goal**: one or two sentences, in the user's words.
   - **What exists now**: the files and functions involved, from what you read.
   - **Steps**: a numbered list. Each step names the file it changes and what changes, and is small enough to check on its own.
   - **How to check it**: the command to run or the thing to look at after each step or at the end.
   - **Risks and open questions**: what could go wrong, and what you could not find out.
4. Order the steps so the project still works after each one. Put the riskiest step early.
5. Name only files you saw in a tool result. Do not invent commands; give one only if a file you read shows it.
6. Tell the user the plan is in PLAN.md, give the steps in one short list, and ask whether to start with step 1.
