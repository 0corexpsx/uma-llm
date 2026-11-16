---
name: win32-gui-app
description: Build or fix a Windows desktop GUI in C or C++ with the Win32 API: windows, ListView, tabs, timers, GDI drawing.
---

# Win32 GUI in C or C++

Read before changing: call search_files for WM_CREATE, CreateWindowEx, WM_PAINT, WM_TIMER and read_file around each hit.

Rules that cause most bugs:
1. Call InitCommonControlsEx (ICC_LISTVIEW_CLASSES, ICC_TAB_CLASSES) before creating common controls, and link comctl32.lib.
2. Create child controls in WM_CREATE, store their HWNDs, and only then fill them. A control used before CreateWindowEx returns is NULL.
3. ListView in report view: style WS_CHILD | WS_VISIBLE | LVS_REPORT. Add columns with ListView_InsertColumn before items, give each column a width, then ListView_InsertItem and ListView_SetItemText.
4. A ListView that looks empty but shows rows when selected: it was not resized or redrawn. Size it in WM_SIZE with MoveWindow, and after filling call InvalidateRect(hList, NULL, TRUE). When refilling every second, wrap it in SendMessage(hList, WM_SETREDRAW, FALSE, 0) ... TRUE, and keep the selection.
5. Tabs: show the page for the selected tab and hide the others (ShowWindow) in WM_NOTIFY / TCN_SELCHANGE.
6. Drawing graphs: draw only in WM_PAINT between BeginPaint and EndPaint. Draw into a memory DC (CreateCompatibleDC, CreateCompatibleBitmap) and BitBlt it, so it does not flicker. Return 1 from WM_ERASEBKGND. Call InvalidateRect from WM_TIMER, not drawing code.
7. Free every GDI object you create (DeleteObject, DeleteDC) or the app slows down and stops drawing.
8. Check return values. After a failed call, log GetLastError.

Then build (see the msbuild-visual-studio or fix-build-errors skill) and start the exe with run_command `Start-Process`. If look_at_screen is among your tools, call it with the window's title and check the picture yourself. Otherwise ask the user to describe the window, and never claim it looks right.
