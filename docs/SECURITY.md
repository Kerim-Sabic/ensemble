# Security

Ensemble runs AI agents on your computer with your own sign-ins, so a security problem in it can matter. Thank you for reporting one.

## Reporting a problem

Please report it privately, not in a public issue: on this repository's **Security** tab, choose **Report a vulnerability** ([direct link](https://github.com/Kerim-Sabic/ensemble/security/advisories/new)). Describe what an attacker could do, and the steps to show it if you have them.

You should hear back within a week. Fixes ship as a new release, which every installed copy picks up on its own.

## What is in scope

- The app itself: the window, the engine in the main process, the bridge between them.
- The locked box that Live answers mini apps run in (no network, no files, no access to the app).
- How the app stores connector keys and its own data in `%APPDATA%\Ensemble`.
- The release and update path (GitHub releases).

Out of scope: Claude Code, the Codex CLI, and the models themselves (please report those to Anthropic or OpenAI), and what an agent does in a folder you gave it full access to.

## Supported versions

Only the latest release. Ensemble updates itself, so please check that a problem is still there in the newest version.
