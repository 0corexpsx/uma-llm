---
name: visual-check
description: Look at a running program's window or a web page as a picture, to check how it really looks and fix what is wrong. Needs a model that can see.
---

# Check how it looks

Use this after building or changing something with a visible result: a window program, a web page, a chart.

A window program:
1. Build it, then start it without waiting for it to end: run_command `Start-Process "path\to\App.exe"`, then `Start-Sleep -Seconds 3`.
2. Call look_at_screen with part of the window's title: {"window":"Task Manager"}. If no window matches, the error lists the open windows: pick the right title from it.
3. Describe what the picture shows, in plain words: which lists, tabs, graphs and texts are there, and what is empty, cut off, overlapping or missing.
4. Compare it with what the user asked for. Fix one problem at a time with replace_in_file, build, close the old program with `Stop-Process -Name App`, start it again and look again.

A program the user names (a browser, an editor): call look_at_screen with its name, like {"window":"Brave"}. If it is not open, start it with run_command `Start-Process brave`, wait 3 seconds, then look. Never refuse before trying.

You cannot click, type or scroll in a program. To search a site in the user's browser, open its search address: run_command `Start-Process brave "https://www.youtube.com/results?search_query=words+here"`, wait 3 seconds, then look.

A web page:
1. Call look_at_page with the file: {"path":"index.html"}, or with a local server's address: {"url":"http://localhost:3000"}.
2. Describe the layout, colours and anything broken, then fix the HTML or CSS and look again.

Rules:
- Say only what is in the picture. If text is too small to read, say so and do not guess.
- A picture shows one moment: it cannot show clicking, scrolling or animation. Ask the user about those.
- If look_at_screen is not allowed, tell the user to turn on "See the screen" in Settings, and until then ask them what they see.
- Look again after every fix before saying it looks right, at most 4 rounds.
