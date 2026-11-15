# mcpclaude — Progress Log

One entry per milestone, newest first. Each entry lists what was verified and how; the
checkboxes in [PLAN.md](PLAN.md) are only ticked on the basis of these entries.

## M3 — Live ngrok check (2026-11-15)

- With a real authtoken (Linux, Node 24): `mcpclaude doctor` round trip passed (488 ms).
  `mcpclaude -d <dir> -m project -y` opened a public `ngrok-free.dev` URL; the official MCP
  client connected through it, listed 33 tools and ran `run_command` in the project
  directory; a wrong URL token got HTTP 401. The ngrok authtoken was not written to the
  config file.
- On a user's Mac, `doctor` reported `ERR_NGROK_334` (address held by another agent on the
  account). `doctor` now reports that as a warning, since it proves the token and network work.

## M2 — Shell, processes, files, transfer, system tools (2026-11-14)

- Implemented 33 tools on top of the M1 framework (35 with the two meta tools): `run_command`,
  `run_script`; `start_process`, `list_processes`, `read_process_output`,
  `write_process_input`, `stop_process`, `list_system_processes`, `kill_process`; twelve file
  tools; three navigation tools; six transfer tools (inline base64, one-time HTTP links on
  the tunnel, URL download/upload); `system_info`, `get_environment`, `check_tools`.
- Every tool is exercised by an integration test that drives a real HTTP server with the
  official MCP client, in Full System Access and in Project-Only mode (path refusals, symlink
  escapes, hidden tools).
- Seatbelt sandbox: the first macOS CI run (43557433946) failed — Apple's own tools (`mktemp`,
  `xcrun`, `sips`, the Swift compiler) ignore `TMPDIR` and write to the per-user Darwin temp
  and cache directories, which the profile keeps closed because every application of the user
  shares them. Fixed by pointing those tools at private sub-directories through
  `DIRHELPER_USER_DIR_SUFFIX` (the mechanism macOS uses for sandboxed apps), confirmed first
  with a probe run and then in the suite.
- Verified in CI run 43558105166 (commit `052545d`): Linux Node 22 and 24, `macos-15` and
  `macos-26` all green. On macOS 392 tests pass, including the 22 enforcement cases in
  `tests/macos/sandbox.test.ts` that run real commands under the generated profile: reads
  and writes outside the project are denied, symlinks do not escape, the project root cannot
  be removed, other applications and outside processes cannot be driven or signalled, the
  ssh agent and mcpclaude's own secrets are not exposed — while zsh/bash/sh, git, Node, npm
  install, Python, the C and Swift compilers, DNS/TLS and localhost servers keep working.
- Not a sandbox: on Linux (development only) Project-Only mode has path checks but no OS
  confinement for commands; `server_info` and the startup output say so.

## M1 — Core server (2026-11-14)

- Implemented: config store, auth gate, path policy, runtime, audit log, tool framework,
  stateless MCP endpoint, HTTP server (auth, Host/Origin checks, health, transfer-link
  routes), `server_info` and `usage_guide`. Process manager, exec helpers, Seatbelt profile
  generator and transfer-link store were written ahead of M2 because the runtime owns them.
- Verified locally (Linux, Node 24): `npm run typecheck`, `npm test` — 107 tests passing,
  including an integration suite that drives a real HTTP server with the official MCP client
  in both protocol eras (2025 `initialize` handshake and pinned `2026-07-28`): tool listing
  with schemas, calls, error mapping, progress notifications, setup gate, pause, Project-Only
  visibility and refusals, bearer/URL-token/no-auth access, throttling, Host/Origin
  rejection, audit trail.
- Symlink escapes (directory links, file links, dangling links) are covered by
  `tests/unit/permissions.test.ts`.
- macOS capability probe (run 43554506883, since removed) on `macos-26` (Swift 6.3.3) and
  `macos-15` (Swift 6.1.2): `sandbox-exec` with `-D` parameters enforces read/write denials;
  `screencapture` and `sips` work (1024×768 display at 1x); Accessibility is trusted;
  CGEvent mouse moves are honoured (cursor read back at the posted position); AX window
  queries and System Events menu listing work; `open -a TextEdit` works. Apple events sent
  straight to TextEdit time out (no TCC grant on the runner), so CI reads text back through
  Accessibility instead.
- Added `tests/macos/sandbox.test.ts`: 20 enforcement cases that run real commands under the
  generated profile on the macOS runners (result recorded under M2).

## M0 — Planning and scaffolding (2026-11-14)

- Requirements analysed and mapped to milestones in PLAN.md; architecture and decisions
  written.
- Scaffold: TypeScript 7, Vitest 5, MCP SDK v2 (`@modelcontextprotocol/server` 2.4), ngrok SDK
  1.8.
- Verified locally: `npm run typecheck`, `npm run build`, `npm test`.
- Verified with a throwaway experiment that the MCP SDK's stateless handler serves both a
  2025-era client (initialize handshake) and progress notifications from one factory.
- Pushed as commit `e4d6ada`; CI run 43554118682 green on Linux (Node 22, 24) and macOS.
- Ran a temporary CI job (`macos-probe`) reporting which desktop capabilities the
  hosted macOS runners provide (screen capture, synthetic input, Accessibility, Seatbelt), to
  decide how much of M4 can be verified in CI.
