---
name: rust-cargo
description: Create, build, or fix a Rust project with cargo, using the compiler's own hints.
---

# Rust with cargo

1. Check that cargo exists with run_command `cargo --version`. If it is missing, tell the user to install Rust from rustup.rs.
2. New project: `cargo new my_app`. Existing: read_file on Cargo.toml.
3. Build with run_command: `cargo build` (add `--manifest-path "my_app\Cargo.toml"` when the project is in a subfolder).
4. Read the first error. Rust's error text usually says how to fix it ("help: consider borrowing here", "help: add `mut`"). Read the lines it points to with read_file, apply the suggested fix with replace_in_file, and build again.
5. Borrow errors (E0502, E0499, E0382): do not add .clone() everywhere. Shorten how long a borrow lives, or clone only the value that is moved, and say why.
6. Add crates with `cargo add name`. Run with `cargo run`, test with `cargo test`. Use `cargo clippy` only if the user asks for lint fixes.

Say it builds only when the output shows "Finished". Tell the user each change and the final command result.
