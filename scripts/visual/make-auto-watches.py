# Writes auto-watches.json: the Inbox and Watches in demo mode, light and dark, large and small.
# The demo team does not run watches by itself, so the state is set on the window's own watches
# store (window.__watches) after the view has read the engine once.
import json, os

ONBOARD = r"""
const st = window.__ensemble;
for (let i = 0; i < 10; i++) {
  if (st.getState().settings.onboarded) break;
  const all = [...document.querySelectorAll('button')].filter(b => !b.disabled);
  const find = re => all.find(b => re.test(b.textContent.trim()));
  const b = find(/^(Continue|Start using|Start with|Get started|Start working|Done|Finish|Open Ensemble)/) || find(/^Skip/);
  if (!b) break;
  b.click();
  await new Promise(r => setTimeout(r, 900));
}
const cwd = %CWD%;
const c = await window.ensemble.createChat({ cwd });
await st.getState().openChat(c.id);
return 'onboarded: ' + st.getState().settings.onboarded + ', chat in ' + cwd
""".replace('%CWD%', json.dumps(os.path.join(os.environ['TEMP'], 'demo', 'acme', 'pricing-site')))

# Demo content: one repository (the demo's GitHub fixture is acme/pricing-site).
DATA = r"""
const now = Date.now(), m = 60000, h = 60 * m;
const run = (ago, outcome, note, model, ms) => ({ id: 'r' + Math.random().toString(36).slice(2), at: now - ago, ms: ms || 900, outcome, note, model });
const w = (o) => Object.assign({ cwd: undefined, account: 'auto', onFind: 'tell', status: 'active', createdAt: now - 6 * 24 * h, failures: 0, madeBy: 'user' }, o);
window.__demoWatches = [
  w({ id: 'w-ci', name: 'Failed checks on main', prompt: 'When a check fails on main, find which step failed and why, and hand the fix to the team.', trigger: { kind: 'github', repo: 'acme/pricing-site', on: 'ci-failed' }, onFind: 'team', nextAt: now + 4 * m,
     runs: [run(26 * m, 'handed', 'Checks failed on main: 2 tests in checkout.test.ts round the tax down. Handed to the team as Verified work.', 'gpt-5-mini', 7400), run(56 * m, 'quiet'), run(86 * m, 'quiet'), run(116 * m, 'quiet'), run(146 * m, 'quiet')] }),
  w({ id: 'w-issues', name: 'New issues from customers', prompt: 'Tell me about new issues that come from customers (not from the team), with what they ask for in one line.', trigger: { kind: 'github', repo: 'acme/pricing-site', on: 'issue' }, nextAt: now + 11 * m,
     runs: [run(9 * m, 'found', 'Issue #212 from a customer: the yearly price shows $0 in Safari 17.', 'gpt-5-mini', 5100), run(39 * m, 'quiet'), run(69 * m, 'quiet')] }),
  w({ id: 'w-page', name: 'Competitor pricing page', prompt: 'Tell me when Northwind changes its plans or prices, and what changed.', trigger: { kind: 'url', url: 'https://www.northwind.example/pricing' }, nextAt: now + 47 * m,
     runs: [run(13 * m, 'quiet'), run(73 * m, 'quiet'), run(133 * m, 'quiet'), run(193 * m, 'quiet')] }),
  w({ id: 'w-brief', name: 'Morning summary of pull requests', prompt: 'Each weekday morning, list the open pull requests that wait for a review, oldest first.', trigger: { kind: 'schedule', at: '08:00', days: [1, 2, 3, 4, 5] }, status: 'paused', nextAt: null, failures: 3,
     runs: [run(2 * h, 'failed', 'GitHub said the sign-in has expired. Sign in again under Settings, GitHub.'), run(26 * h, 'failed', 'GitHub said the sign-in has expired.'), run(50 * h, 'failed', 'GitHub said the sign-in has expired.'), run(74 * h, 'found', '3 pull requests wait for a review; the oldest is #198 (5 days).', 'gpt-5-mini', 6200)] }),
];
window.__demoInbox = [
  { id: 'i-perm', kind: 'needs-you', title: 'Waiting for your OK', body: 'Push the branch fix/tax-rounding to github.com/acme/pricing-site and open a pull request', at: now - 4 * m, watchId: 'w-ci', chatId: undefined, approval: { chatId: 'x', requestId: 'demo-req', expiresAt: now + 11 * h + 34 * m }, read: false, done: false, ref: 'perm:demo' },
  { id: 'i-issue', kind: 'found', title: 'Issue #212: the yearly price shows $0 in Safari 17', body: 'Opened by a customer 9 minutes ago. The toggle sets the price before the plan list has loaded, so Safari draws $0 until the page is scrolled. Two people have added "same here".', at: now - 9 * m, watchId: 'w-issues', read: false, done: false },
  { id: 'i-ci', kind: 'found', title: 'Checks failed on main: tax rounded down in checkout', body: 'Two tests in checkout.test.ts expect $21.39 and get $21.38: the tax is rounded per line instead of on the total. Handed to the team as Verified work.', at: now - 26 * m, watchId: 'w-ci', read: true, done: false },
  { id: 'i-fail', kind: 'failed', title: 'Morning summary of pull requests is paused after three failed looks', body: 'GitHub said the sign-in has expired. Sign in again under Settings, GitHub, then resume the watch.', at: now - 2 * h, watchId: 'w-brief', read: false, done: false },
  { id: 'i-old', kind: 'found', title: 'Northwind added a Team plan at $18 a seat', body: '', at: now - 30 * h, watchId: 'w-page', read: true, done: true },
];
window.__demoToday = { runs: 14, byAccount: {}, caps: { runsPerDay: 60, runsPerAccount: 30, keepFree: 30 } };
return 'demo data ready'
"""

def setstate(watches, inbox, today='window.__demoToday'):
    return ("window.__watches.setState({ available: true, watches: %s, inbox: %s, today: %s });"
            " await new Promise(r => setTimeout(r, 300)); return 'set: ' + (window.__watches.getState().watches||[]).length + ' watches, ' + (window.__watches.getState().inbox||[]).length + ' items'") % (watches, inbox, today)

VIEW_INBOX = "const s = window.__ensemble.getState(); s.setView('inbox'); await new Promise(r => setTimeout(r, 600)); const b = [...document.querySelectorAll('button')].find(b => /^Inbox/.test(b.textContent.trim()) && b.closest('header')); b && b.click(); await new Promise(r => setTimeout(r, 300)); return 'inbox view: ' + !!window.__watches"
TAB_WATCHES = "const b = [...document.querySelectorAll('header button')].find(b => /^Watches/.test(b.textContent.trim())); if (!b) return 'no Watches tab'; b.click(); await new Promise(r => setTimeout(r, 300)); const row = [...document.querySelectorAll('button[aria-expanded]')].find(x => /Morning summary/.test(x.textContent)); row && row.click(); await new Promise(r => setTimeout(r, 300)); return 'watches tab'"
TAB_INBOX = "const b = [...document.querySelectorAll('header button')].find(b => /^Inbox/.test(b.textContent.trim())); if (!b) return 'no Inbox tab'; b.click(); await new Promise(r => setTimeout(r, 300)); return 'inbox tab'"
EDITOR = "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await new Promise(r => setTimeout(r, 200)); const b = [...document.querySelectorAll('header button')].find(b => /New watch/.test(b.textContent.trim())); if (!b) return 'no New watch'; b.click(); await new Promise(r => setTimeout(r, 1500)); return 'editor: ' + (document.querySelector('[role=dialog]')?.textContent || '').replace(/\\s+/g, ' ').slice(0, 300)"
EDITOR_FILLED = "const chip = [...document.querySelectorAll('[role=dialog] button')].find(b => /failed checks/i.test(b.textContent)); if (!chip) return 'no chip: ' + [...document.querySelectorAll('[role=dialog] button')].map(b => b.textContent.trim()).join(' | '); chip.click(); await new Promise(r => setTimeout(r, 500)); return 'filled: ' + (document.querySelector('[role=dialog]')?.textContent || '').replace(/\\s+/g, ' ').slice(0, 400)"
CLOSE = "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.__watches.setState({ editing: { open: false } }); await new Promise(r => setTimeout(r, 300)); return 'closed'"
TEXT = "const m = document.querySelector('main') || document.body; return (m.innerText || '').replace(/\\s+/g, ' ').slice(0, 900)"

steps = [
    {"size": [1320, 900], "theme": "light", "wait": 1800},
    {"js": ONBOARD, "wait": 800},
    {"js": DATA, "wait": 100},
    {"js": VIEW_INBOX, "wait": 800},
]
for theme in ['light', 'dark']:
    for size, tag in [([1320, 900], 'large'), ([900, 700], '900')]:
        steps.append({"size": size, "theme": theme, "wait": 500})
        steps.append({"js": TAB_INBOX, "wait": 100})
        steps.append({"js": setstate('window.__demoWatches', 'window.__demoInbox'), "wait": 300})
        steps.append({"js": TEXT, "wait": 100, "shot": f"watches-inbox-{tag}-{theme}.png"})
        steps.append({"js": setstate('window.__demoWatches', '[]'), "wait": 300, "shot": f"watches-inbox-empty-{tag}-{theme}.png"})
        steps.append({"js": setstate('window.__demoWatches', 'window.__demoInbox'), "wait": 100})
        steps.append({"js": TAB_WATCHES, "wait": 400, "shot": f"watches-list-{tag}-{theme}.png"})
        steps.append({"js": EDITOR, "wait": 400, "shot": f"watches-new-{tag}-{theme}.png"})
        steps.append({"js": EDITOR_FILLED, "wait": 400, "shot": f"watches-new-filled-{tag}-{theme}.png"})
        steps.append({"js": CLOSE, "wait": 200})
# The watches list empty, with the ready-made watches for this folder.
steps.append({"size": [1320, 900], "theme": "light", "wait": 400})
steps.append({"js": setstate('[]', '[]', 'null'), "wait": 600, "shot": "watches-list-empty-large-light.png"})

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'auto-watches.json')
with open(out, 'w', encoding='utf-8', newline='\n') as f:
    json.dump(steps, f, indent=1)
print(out, len(steps), 'steps')
