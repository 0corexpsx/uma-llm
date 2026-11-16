---
name: dotnet-csharp
description: Create, build, or fix a C# .NET app (console, WinForms, WPF) with the dotnet command.
---

# C# with .NET

1. Call check_environment to confirm the .NET SDK is installed.
2. New project: run_command `dotnet new console -n MyApp -o MyApp` (or `winforms`, `wpf`). Existing project: find the .csproj or .sln with list_files and read_file it.
3. Build with run_command: `dotnet build "MyApp\MyApp.csproj"`.
4. On errors, take the first one (CS code, file and line), read_file around it, fix with replace_in_file, build again. Common ones:
   - CS0103 / CS0246: missing using or missing package (`dotnet add "MyApp\MyApp.csproj" package Name`)
   - CS8618 and other nullable warnings are warnings: fix only if asked
5. Run a console app with `dotnet run --project "MyApp\MyApp.csproj"`. A WinForms or WPF app opens a window and keeps running: start the built exe with `Start-Process` and ask the user to check it.
6. Tests: `dotnet test` when there is a test project.

Say the build passed only when the output ends with "Build succeeded". Tell the user the files you changed and the commands you ran.
