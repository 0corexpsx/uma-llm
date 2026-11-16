---
name: website-restyle
description: Redesign or improve the look of an existing HTML and CSS website. Use for requests to restyle a site or make it look professional.
---

# Restyle a website

1. Call list_files to find the HTML and CSS files. If there are none, tell the user.
2. Call read_file on each HTML page and stylesheet, so your CSS selectors match what is really there.
3. Save the new stylesheet with write_file. Never paste it into chat. If it is long, write the first part with write_file, then add the rest with append_file.
4. Keep the existing class names and page text. Change the HTML with replace_in_file only when the design needs it.
5. Make the layout work at phone width, keep text contrast readable, and do not add external libraries unless the user asked.
6. Call read_file on the stylesheet to confirm it saved completely, with no rule cut off.
7. If look_at_page is among your tools, call it on the page and fix what looks wrong in the picture. Otherwise ask the user to open it in a browser and check how it looks.
8. Tell the user which files changed.
