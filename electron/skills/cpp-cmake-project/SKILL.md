---
name: cpp-cmake-project
description: Create or build a C++ project with CMake and Visual Studio on Windows. Use for any request to make, compile, or run a C++ app.
---

# C++ project with CMake

Work in this order. Do each step with a tool call.

1. Call check_environment to confirm CMake and the Visual Studio C++ tools are installed. If either is missing, stop and tell the user.
2. Call write_file for CMakeLists.txt. Use exactly this form, changing only the project name and source files:

   ```cmake
   cmake_minimum_required(VERSION 3.20)
   project(MyApp LANGUAGES CXX)
   set(CMAKE_CXX_STANDARD 17)
   set(CMAKE_CXX_STANDARD_REQUIRED ON)
   add_executable(MyApp main.cpp)
   ```

   Do not add add_custom_target or other extras unless the user asked for them.
3. Call write_file for main.cpp and any other source files.
4. Configure with run_command: `cmake -S . -B build`
5. Build with run_command: `cmake --build build --config Debug`
6. If a step fails, read the error, fix the file it names with replace_in_file, and run that step again. Do not delete the build folder.
7. Run the program with run_command: `.\build\Debug\MyApp.exe`
8. Tell the user which files you created, whether the build passed, what the program printed, and that the folder can be opened in Visual Studio with File > Open > Folder.

Use paths relative to the workspace. All commands run from the workspace folder, so do not use cd.
