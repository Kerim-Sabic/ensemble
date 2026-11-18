# Changelog

What changed in each version of Ensemble. Earlier versions are described on the [releases page](https://github.com/Kerim-Sabic/ensemble/releases).

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
