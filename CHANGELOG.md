# Changelog

What changed in each version of Ensemble. Earlier versions are described on the [releases page](https://github.com/Kerim-Sabic/ensemble/releases).

## 4.0.0 (2026-11-20)

### New

- **Watches and an Inbox.** Ensemble keeps an eye on things by itself: a schedule, failed CI runs, new issues or pull requests, a web page, a folder. It says nothing when nothing changed and puts what it finds in your Inbox, next to the approvals and goals that wait for you. A look costs nothing unless something changed; then the cheapest model looks once. Make a watch in plain questions or with `/watch`. Daily limits keep this from using the allowance you need, and watches may start a team chat at most three times a day.
- **Rules for work nobody is watching.** A watch's run may read and change files in its own folder. It reaches the web only on sites you approve, from its first step, and each approval lasts for that run. Anything else that goes out or cannot be undone (a push, a post, a message, a delete outside the folder) waits for your approval, which covers exactly that action and lapses after 12 hours. Computer control is refused, and so are shell commands where there is no sandbox. The app enforces this, not the prompt, and every decision is written to a record that shows if it was altered.
- **Your phone, from anywhere.** Reach Ensemble on any network: over Tailscale, or through a relay you run on your own Cloudflare account. Everything between the phone and the computer is encrypted end to end, so the relay cannot read or change it. The phone has an Inbox (what needs you first, then what watches found) with approve and deny, Stop for any chat, and notifications that say only that something needs you, never what a chat is about.
- **What I learned.** Every note the team keeps says where it came from: your words, a passing check, or an agent's guess that waits for your yes. Undo any change, or Forget a note, which removes it everywhere. Each chat starts with a small memory chosen for it (at most 300 words); everything else, including the real messages of earlier chats, is searched when needed. After a chat goes quiet, the fastest model looks back and keeps only what a quote in the chat backs, up to 12 times a day, with a switch in Settings.
- **Use Ensemble from your phone.** Turn on Phone and remote in Settings, scan the code with your phone's camera, and from Safari or any phone browser you can follow chats live, message or steer the lead, stop the team, answer approvals and questions, and pick up work that was cut short. It works on the same Wi-Fi, or from anywhere over a private network such as Tailscale. It is off until you turn it on, it answers only the local network, and a paired phone cannot touch accounts, settings, permission levels or computer control.
- **Shared projects.** Share a chat's project with a join code: the other person's team gets the shared project notes and can message yours, directly between the two computers and sealed. The host can remove a member or stop sharing at once.
- **Evidence under every reply.** What changed, what ran, what passed, who reviewed it and what is still uncertain, built from a record the app keeps of every step. A met goal reads as met, and stopped or failed runs show what happened before they ended.
- **From GitHub.** Start from an open issue, a pull request or a failed CI run (or type `/github` with its address). The team reproduces, fixes or reviews it, a fresh checker confirms it from the evidence, and nothing is pushed or posted to GitHub. A closed issue or merged pull request asks before it starts.
- **Voice.** Speak into the message box (the microphone, or Alt+V). Speech becomes text on this computer and nothing leaves it; "send it", "stop", "new chat", "ultra on" and "make this a goal" work as spoken commands. The first use downloads the speech model and runtime once, about 105 MB, and the runtime runs only if it matches the copy Ensemble expects.
- **Quick, Team and Verified** are the main ways of working. Plan first, Council and Deep research are under More, and Ultra and Go crazy under Advanced. Each says what you get, not how many agents.
- **A first run that reaches real work.** Sign in, choose a project folder (or a recent project), and start one task picked for that folder, in two or three clicks. Without a folder the team works in a new Ensemble folder in Documents, never your home folder or a drive root.
- **macOS (new, lightly tested):** builds for Apple silicon and Intel. No computer control and no self-update on a Mac yet.

### Faster and lighter

- **Long chats stay smooth:** only what is on screen is drawn, so thousands of rows scroll like a short chat, and every message can be reached by scrolling.
- Typing and scrolling no longer stall while a big team works: updates that change nothing redraw nothing, and side panels catch up in the background.
- Idle agents' programs close after 4 minutes and reopen on their next turn, which frees their memory.
- Saving is lighter: transcripts are written at most every 10 seconds while an agent streams (your messages and approvals are still saved at once), and task lists once per burst.

### Goals that finish

- **A goal is checked when the whole team's work is in,** and the check sees everything since the last one. Waiting for the team no longer uses up rounds, and a goal is no longer stopped for "no work done" while the team was working.
- A task nobody is working on any more is closed and reported after two minutes, instead of keeping a goal and its lead waiting for ever.
- Changing the lead no longer pauses a goal: the new lead is told the goal and carries on. A lead that runs out of allowance makes the goal wait and carry on by itself when the allowance is back, and a reply that fails is tried again twice before you are asked.
- "You've hit your limit" replies are recognised as running out of allowance, so the work moves to another model or teammate instead of repeating the notice.
- An empty "finished" signal no longer closes a task with "left no report" while its agent is still working.
- The goal bar says what a goal is waiting for, such as "Waiting for the team".

### Safer and sturdier

- **Saves cannot leave a half-written file:** each save is checksummed, the last good copy is kept, and a crash at any point leaves either the old state or the new one.
- **Updates can be signed with the project's own key,** and installed copies then refuse an update whose signature does not check out. Releases carry checksums, a software bill of materials and a build-provenance attestation. (Signing is switched on once the keys are set up; until then updates work as before.)
- "Restart to update" picks up only the work it cut short, not chats you had left alone.
- The local tool server the agents talk through limits size, time, concurrency and origin.
- A watch's finding can never start a loop, a goal or Ultra by how it is worded. A run nobody is watching treats its folder, the vault, memory and earlier chats as text other people may have written, so it asks before any request to the web.
- How many agents this computer can carry is measured from the agents' real memory and processor use, not assumed.
- **Model choice learns from real evidence only:** independent reviews, checked goals, and test and build runs, not a task merely finishing. A change of model is confirmed on tasks held back for the purpose, and each choice comes with one sentence saying why, with the counts.

### Also in this release (prepared as 3.7.2)

- **Every account leads its own part in Ultra and Go crazy.** The lead now gives each teammate that has allowance a whole branch of the work: a version to build, a region to lead, a set of angles to research. That teammate runs its branch with agents of its own, and those can start theirs. Before, a lead could do everything with agents it started itself, so the other accounts' own agents never got a task, even while their allowance was being used. If a lead still leaves a teammate out, Ensemble sends it back once to hand that teammate a branch, also while a long first reply is still under way.
- **The Team tab shows each account's share.** A strip of accounts at the top says how many agents each one carries and how many are working right now. An account's card says "5 agents on this account · 3 working" instead of "Free" while agents run on its sign-in, and says why when it gets no new work: signed out, out of usage until a time, or nearly out and used last. Every agent's card names the account it runs on.
- **Chats that were already under way adopt an update.** On the first start after an update, agents that an older version had piled onto one account are shared out over the accounts that can take work, each carrying on with a summary of what it did. A chat that the update's own restart cut short is picked up again by itself.
- A teammate's branch stays on its own account while the accounts stay even. The even spread from 3.7.1 still decides when one account gets ahead.
- The allowance of ChatGPT accounts is looked at again whenever the lead gets a message, so an account that refilled is used right away.

## 3.7.1 (2026-11-18)

### Fixed

- **The whole team works in Ultra and Go crazy.** Agents are now spread evenly over every account that has allowance. Before, a lead could name its own account for every agent it started, which left the other accounts idle and ran that one dry. The app now counts the agents already living on each account when it places a new one, and an agent asked onto an account that already carries clearly more than another is placed on the other, with a line saying why. The lead is no longer told to choose accounts itself.

## 3.7.0 (2026-11-18)

### New
- **Automatic handover when an account runs out.** Ensemble watches every account's session and weekly allowance. When the lead runs out, the teammate best placed takes over by itself: the one with the most allowance left and the strongest model, from the same provider where possible. It is caught up on the chat and carries on with the work, the goal included. A lead that is about to run out hands over at the end of its reply. The chat shows one line saying who took over, why, and when the old account is back, and that line offers to hand back once it is. Tasks move to a teammate with room. Agents the team started move to another account with a summary of their work. When every account is out, you are told once when the work goes on, and the first account to refill picks it up. It can be turned off in Settings (*Hand over when an account runs out*).
- **The team panel shows each account's state:** running low, out until a time, or covered by the teammate who took over.
- **The brain view.** A chat running Go crazy with a goal shows the lead in the centre, ringed by the goal's rounds, with the regions (research, building, judging, memory) clustered around it and pulses along the handoffs. Above it are the goal, the round and the last check's verdict.
- **Go crazy at full scale.** The lead starts regions, each with a lead of its own and a team under it, linked to each other, with a memory region that keeps the board current. Teams go up to eight levels deep. There is no fixed number of agents: before each new agent, Ensemble checks the computer's free memory and processor cores and which accounts have allowance. A goal set in Go crazy keeps Go crazy for every round.
- **Steer while it works.** A message sent while an agent is working reaches that work at its next step. <kbd>Alt</kbd>+<kbd>Enter</kbd> waits for the reply instead, as before.
- **Design with real images.** With a ChatGPT account on the team, design requests get an image agent of their own: a moodboard of directions first, then the assets the builders need, and the judges see the screens with the images in place.

### Fixed and improved (since 3.6.0)
- A ChatGPT lead now starts its Ultra and Go crazy teams through Ensemble instead of through Codex's own built-in helpers, so every agent appears in the network and can work with the rest of the team.
- A lead that starts too few agents for a substantial Go crazy request is asked once to start the regions.
- An effort level a model doesn't have (for example "max" on a model that stops at "high") now runs at the nearest level below instead of being refused.
- New work skips accounts that are out of allowance or close to the end of their window while another account has room.
- A task can move to another teammate more than once, and to the other provider when its own has nobody free.

## 3.6.0 (2026-11-18)

### New
- **Deep teams.** Agents start agents of their own, deeper than before: two levels below the lead in an ordinary chat, three in Ultra, four in Go crazy. Ultra may now hold up to 20 extra agents and Go crazy up to 32. A task stays open until its helpers have reported, and sending an agent home takes its helpers with it.
- **Smarter Ultra.** The lead writes a rubric first, then picks the shape that fits the request: a tournament (each builder works with its own critic on another model, a tester and a fast researcher), divide and assemble (an architect, owners for each part, an integrator), or an investigation (scouts, a check at the primary source, a synthesis). Judges who did none of the work, evidence from running or rendering, rounds of refinement and the lead's own final check apply to every shape. Go crazy adds a round where the versions critique each other between its two judging rounds.
- **The network view.** Ultra and Go crazy teams show as a network that grows while the agents work: every node is an agent and every line a handoff. It opens by default for Ultra chats in the Team tab, and appears small in mission control and in the chat. Point at an agent to see its task, model and what it is doing; click to open its conversation.
- **Live answers.** Replies can carry charts, tables, comparisons, steps, checklists, tabs, diagrams, forms, choices and calculators, drawn by the app in light and dark. Picking a choice or submitting a form answers that agent. Agents can also write mini apps that run in a locked box with no network, no files and no access to the app.
- **A higher bar for every agent.** Every briefing now says what good design, code, research and writing look like.
- **Try the demo team.** On the first screen, "See it work first" restarts the app with a scripted demo team: no account, no allowance used, nothing sent anywhere, and a bar that says so. It is also in the command palette and Settings, for showing Ensemble to someone.

### Fixed and improved (since 3.5.0)
- A button, form or mini app in an answer can never run one of the app's commands: what it sends reaches the agent as plain words.
- In demo mode the engine's waits follow the demo speed.
- A team of ChatGPT accounts alone is a full team: the goal checker, chat titles and the message improver use ChatGPT when there is no Claude account, and ChatGPT models are chosen from the allowance like Claude ones.
- Ultra runs the lead on its strongest model at high effort, and nobody in an Ultra chat is stepped down to a cheaper model by default.
- ChatGPT agents no longer wait inside a turn for a teammate's report, so reports arrive sooner.
- Stopping the lead mid-reply also takes back the tasks that reply handed out.
- The model shown for a ChatGPT account is the one its own Codex settings name.
