# Security Policy

Roostr is designed to run safely inside multi-agent developer workspaces with zero external npm dependencies.

## Built-In Security Guarantees

1. **Zero Runtime Dependencies**:
   Roostr uses Node 22 built-in modules exclusively (`fs`, `path`, `child_process`, `crypto`, `os`). There is no `node_modules` tree and zero third-party supply-chain surface.
2. **No Shell Execution (`execFile` Only)**:
   Every Herdr CLI invocation (`src/herdr.js`) and every `.roostr.toml` check command (`src/checks.js`) runs via `child_process.execFile` with an explicit `argv` array, never `exec` or `shell: true`. Pane titles, task lines, and model names are treated strictly as data.
3. **SHA-256 Content-Hash Pinning for `.roostr.toml`**:
   Because `.roostr.toml` can define check commands, Roostr refuses to execute any check from a new or modified `.roostr.toml` until you explicitly approve its SHA-256 content hash inside the board (`a` key) and verifies file permissions (`chmod go-w`).
4. **Symlink & Path Traversal Protection**:
   State files, reports, and crewfiles validate resolved paths via `fs.realpathSync` and reject control characters or traversal outside expected directories.
5. **Zero Secret Discovery**:
   Roostr never reads `.env` files, SSH keys, or credential stores from your home directory. Optional provider keys come strictly from explicit environment variables.

## Supported Versions

| Version | Supported |
| --- | --- |
| `0.2.x` / `main` | Yes |
| `< 0.2.0` | No |

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities.
Instead, report vulnerabilities privately through [GitHub Security Advisories](https://github.com/mandoworks/roostr/security/advisories/new). Include a minimal reproduction and affected version or commit hash. We aim to acknowledge reports within 48 hours.
