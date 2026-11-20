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
- The rules for work nobody is watching (below), and the phone relay in `relay/`.

Out of scope: Claude Code, the Codex CLI, and the models themselves (please report those to Anthropic or OpenAI), and what an agent does in a folder you gave it full access to.

## Work nobody is watching

Watches and other runs that start without you present are held to rules that **the app enforces in code**, not rules written in a prompt. The app does not try to tell honest text from injected text on a web page or in an issue, because detection keeps being bypassed. It limits what a run can do after reading anything. The idea is that a run may read untrusted text, may hold private data and may change things inside its own folder, but anything that reaches outward or cannot be undone waits for you.

The principle, which is what stays true as the details are tightened:

- **Allowed:** reading inside the run's folder, changing files inside it, and the team's own tools. Reading your notes or other chats is allowed too. Every such run is treated, from its first step, as having read text other people wrote, because the files in a folder often are.
- **Asks you first:** every request to the web (you approve the site, and that lasts for the run), every connector call, saving to memory or the vault, and anything outward or irreversible: sending, posting, pushing, publishing, writing or deleting outside the folder, a connector tool that changes something, acting on a web page, starting a goal or a loop.
- **Refused outright:** control of the computer, reading sign-in and key folders, questions to a user who is not there, and shell commands unless they run inside an operating-system sandbox. For Claude on Windows that means an unattended run gets **no shell tool at all**. For ChatGPT (Codex) the shell stays inside Codex's own sandbox: writes limited to the folder, network off.
- **Approvals are exact.** An approval covers one call, with the same tool and the same input, once. Anything else asks again. It lapses after 12 hours, and Stop revokes open ones. A run that was stopped takes nothing more until you write to it.
- **A record that shows tampering.** Every step and every guard decision is written to a log in which each line carries a fingerprint of the line before, so an edit or a deletion breaks the chain at that line.
- **Limits on use.** Daily caps on runs, and no unattended run is started on an account that is low on allowance or whose allowance is not known. Known limit: that check covers the account that leads the run. Agents the lead brings in on other accounts are held by the same rules above, the team's size cap and the run's own limit (three rounds, 30 minutes), but not yet by the allowance check.

What is not claimed: these rules have been checked by the app's automated tests and an internal attack review, not by an outside audit. A bypass is a security problem; please report it as above.

**The phone relay.** If you run the optional relay on your own Cloudflare account, traffic between your phone and your computer is end-to-end encrypted and the relay cannot read or change it. It does serve the phone's page, so a relay you do not control could serve a changed page. That is why Ensemble has no shared relay. Details: [relay/README.md](../relay/README.md).

## Supported versions

Only the latest release. Ensemble updates itself, so please check that a problem is still there in the newest version.
