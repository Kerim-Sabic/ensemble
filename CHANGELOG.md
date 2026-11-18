# Changelog

What changed in each version of Ensemble. Earlier versions are described on the [releases page](https://github.com/Kerim-Sabic/ensemble/releases).

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
