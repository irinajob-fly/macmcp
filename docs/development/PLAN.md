# mcpclaude — Development Plan

This is the living plan for **mcpclaude**, a CLI-launched MCP server that lets cloud AI agents
work on a local Mac through an ngrok tunnel. It is updated after every milestone.

- `[x]` = implemented **and verified** (the "Verified by" column says how).
- `[ ]` = not done, or implemented but not yet verified.
- Verification evidence for each milestone is recorded in [PROGRESS.md](PROGRESS.md).
- Design background: [ARCHITECTURE.md](ARCHITECTURE.md), [DECISIONS.md](DECISIONS.md).

## 1. Requirements analysis

| # | Requirement (from the project brief) | Where it is addressed |
|---|---|---|
| R1 | `mcpclaude` command starts an interactive setup | M3 (CLI + wizard) |
| R2 | Step 1: start an ngrok tunnel automatically, print a unique public MCP URL and connection instructions | M3 (tunnel manager, instructions) |
| R3 | Frictionless option without separate user authentication when explicitly configured; secure alternative with access tokens | M1 (auth: token in header or URL path, explicit `--no-auth`) |
| R4 | Step 2: pick the project directory (interactive browser, manual path, validation) | M3 (directory picker) |
| R5 | Step 3: two permission levels, explained before selection | M1 (policy), M2 (sandbox), M3 (wizard) |
| R6 | Project-Only: everything confined to the selected directory | M1 path policy + M2 Seatbelt sandbox for commands |
| R7 | Full System Access: unrestricted, no per-action prompts after explicit opt-in | M1 policy, M3 explicit confirmation |
| R8 | MCP tools: shell, files, navigation, processes, apps, upload/download, system info, dev tools and scripts, background tasks, screenshots, desktop automation | M2, M4 |
| R9 | Every tool has a schema, parameter definitions, usage instructions, example calls, error handling | M1 tool framework (enforced by tests) |
| R10 | Computer Use: screen capture, mouse, keyboard, app switching, windows, menus/dialogs/buttons, multi-step workflows | M4 |
| R11 | After Effects and Blender: GUI automation combined with native scripting | M5 |
| R12 | Documentation for humans and agents (install, CLI, ngrok, providers, permissions, tool reference, computer use, examples, troubleshooting, macOS permissions) | M6 |
| R13 | Plan, architecture, decisions, progress tracking in a dedicated directory; commit and push per milestone | this directory, every milestone |

Constraints that shape the plan:

- Development happens on Linux; macOS-only behaviour (Seatbelt sandbox, screen capture, input
  injection, accessibility, AppleScript) is verified on GitHub-hosted **macOS runners** in CI.
- Adobe After Effects needs a paid licence and cannot be exercised in CI. Its integration is
  tested against a stubbed `osascript`/`aerender`; the live check stays open until someone runs
  it on a Mac with After Effects installed.
- A live ngrok tunnel needs an ngrok authtoken, which is not available in the development
  environment. The tunnel manager is tested with a fake provider and with the real SDK's
  failure path; the live check stays open until a token is supplied.

## 2. Milestones

### M0 — Planning and scaffolding

| Done | Task | Verified by |
|---|---|---|
| [x] | Requirements analysis, architecture, technical decisions, plan written | docs reviewed against the brief |
| [x] | Repository scaffold: `package.json`, TypeScript, Vitest, `.gitignore` | `npm run typecheck && npm test && npm run build` |
| [x] | CI workflow (Linux + macOS) | green run on GitHub Actions |
| [x] | First commit pushed to GitHub | `git ls-remote` shows the branch |

### M1 — Core server

| Done | Task | Verified by |
|---|---|---|
| [x] | Config store (`~/.mcpclaude/config.json`, 0600) and access-token generation | unit tests |
| [x] | Runtime state and permission policy (path confinement, symlink-safe) | unit tests |
| [x] | Tool framework: definition, zod schema, examples, error model, per-mode visibility, audit log | unit tests + catalogue lint test |
| [x] | HTTP server: MCP endpoint for 2026-07-28 and 2025-era clients | integration tests with the official MCP client in both eras |
| [x] | Auth: bearer header, token-in-URL, explicit no-auth; failed-auth throttle | integration tests |
| [x] | Setup gate (tool calls refused until the wizard finishes) and pause switch | integration tests |
| [x] | Meta tools: `server_info`, `usage_guide` | integration tests |

### M2 — Shell, processes, files, transfer, system tools

| Done | Task | Verified by |
|---|---|---|
| [x] | Execution engine and process manager (background processes, output cursors, stdin, stop) | unit + integration tests |
| [x] | Seatbelt sandbox profile for Project-Only mode | profile unit tests; 22 enforcement tests on macOS 15 and 26 runners |
| [x] | Shell tools: `run_command`, `run_script` | integration tests (both modes; sandboxed on macOS CI) |
| [x] | Process tools: `start_process`, `list_processes`, `read_process_output`, `write_process_input`, `stop_process`, `list_system_processes`, `kill_process` | integration tests |
| [x] | File tools: read, write, edit, list, mkdir, move, copy, delete, info, search by name, search by content, view image | integration tests |
| [x] | Navigation tools: `get_working_directory`, `change_directory`, `project_overview` | integration tests |
| [x] | Transfer tools: inline upload/download, one-time HTTP links, URL download/upload | integration tests |
| [x] | System tools: `system_info`, `get_environment`, `check_tools` | integration tests |

### M3 — CLI, wizard and tunnel

| Done | Task | Verified by |
|---|---|---|
| [ ] | Argument parsing, `--help`, `--version`, subcommands (`start`, `doctor`, `tools`, `config`) | unit tests + CLI smoke tests |
| [ ] | ngrok tunnel manager: authtoken discovery, start/stop, status, error mapping | unit tests with a fake provider; real SDK failure path |
| [x] | Live ngrok tunnel reachable from the internet | `doctor` round trip and an MCP client over the public URL (PROGRESS.md, 2026-11-15) |
| [ ] | Wizard step 1: server + tunnel + connection instructions | PTY end-to-end test |
| [ ] | Wizard step 2: directory selection (browser, manual path, validation) | unit tests + PTY end-to-end test |
| [ ] | Wizard step 3: permission levels explained and selected, explicit confirmation for Full Access | unit tests + PTY end-to-end test |
| [ ] | Live activity view, pause/info/quit keys, graceful shutdown | PTY end-to-end test |
| [ ] | `doctor` diagnostics | CLI smoke test (Linux + macOS CI) |

### M4 — Desktop driver and Computer Use (macOS)

| Done | Task | Verified by |
|---|---|---|
| [ ] | Swift helper compiles on current macOS SDKs | macOS CI build |
| [ ] | Helper build cache and invocation from Node | unit tests + macOS CI |
| [ ] | Screenshot pipeline (capture, scale, zoom region, window) and coordinate mapping | unit tests + macOS CI (real capture) |
| [ ] | Mouse: move, click, double/right/middle click, drag, scroll | macOS CI (cursor read-back, real UI effects) |
| [ ] | Keyboard: type text, key combos, named keys | macOS CI (typed text read back) |
| [ ] | Applications: list, launch, activate, quit, open path | macOS CI |
| [ ] | Windows: list, focus, move/resize, minimise, close | macOS CI |
| [ ] | UI elements and menus through Accessibility | macOS CI |
| [ ] | `run_applescript`, clipboard | macOS CI |
| [ ] | `computer_actions` batch and `wait` | unit tests + macOS CI |

### M5 — Creative applications

| Done | Task | Verified by |
|---|---|---|
| [ ] | Blender: discovery, headless Python, headless render | real Blender run |
| [ ] | Blender: live GUI bridge (`blender_launch`, `blender_run_python` in live mode) | bridge protocol test with real Blender |
| [ ] | After Effects: discovery, ExtendScript runner, `aerender` wrapper | unit tests against stubbed `osascript`/`aerender` |
| [ ] | After Effects verified against a real installation | **needs a Mac with After Effects** |

### M6 — Documentation

| Done | Task | Verified by |
|---|---|---|
| [ ] | Installation, CLI, ngrok, provider configuration, permissions, macOS permissions, security, troubleshooting | reviewed against the implementation |
| [ ] | Agent guide, generated tool reference, Computer Use, After Effects, Blender, examples | generated from the tool registry; sync test in CI |

### M7 — Release hardening

| Done | Task | Verified by |
|---|---|---|
| [ ] | Package install test (`npm pack` → global install → `mcpclaude --version`) | scripted check |
| [ ] | Final end-to-end run and plan/progress sync | CI green on the final commit |

## 3. Out of scope for this version

- OAuth 2.1 authorization server (the brief asks for access tokens; see DECISIONS.md D4).
- Windows and Linux desktop control. The server core runs on Linux for development and tests,
  but the product targets macOS.
- Pseudo-terminal sessions for fully interactive programs.
