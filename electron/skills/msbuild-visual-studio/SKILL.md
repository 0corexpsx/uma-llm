---
name: msbuild-visual-studio
description: Build a Visual Studio .sln or .vcxproj with MSBuild from the terminal and fix its errors. Use for Visual Studio projects.
---

# Build a Visual Studio project

1. Call check_environment. It reports the MSBuild path. If Visual Studio or its C++ tools are missing, stop and tell the user.
2. Call list_files to find the .sln or .vcxproj file.
3. Build with run_command, using the MSBuild path from step 1 in quotes and the call operator:

   `& "C:\path\to\MSBuild.exe" "Project.vcxproj" /p:Configuration=Release /p:Platform=x64 /t:Build /nologo /v:minimal`

   For a solution, use the .sln file instead. Use Debug while fixing problems.
4. If it fails, take the first line with "error" and fix it (read_file around the line, then replace_in_file). Build again. Repeat at most 8 times.
5. Find the exe with search_files or list_files under x64\Release or x64\Debug.
6. Run it with run_command only if it is a console program. A window program keeps running: start it with `Start-Process "path\to\App.exe"` instead, so the command does not wait forever.

Build scripts (.bat) that end with `pause` wait for a key: never run those with run_command; call MSBuild directly.
Say the build passed only if the MSBuild output shows "Build succeeded" or exits without errors. Tell the user the exe path.
