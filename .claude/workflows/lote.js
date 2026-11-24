export const meta = {
  name: 'lote',
  description: 'One development batch (lote): implement items in their own worktrees, review by risk, stack them locally, one final review and one full e2e verification of the tip; never more than 2 agents at a time, no pushes',
  whenToUse: 'A batch of independent tasks for Neque\'s Realm to develop, verify and leave stacked locally for a single push (docs/11 "Lotes")',
  phases: [
    { title: 'Implement', detail: 'one agent per item, its own worktree, no Docker' },
    { title: 'Review', detail: 'by risk: high = 2 rounds, server = 1, content = 1 light (sonnet), client/docs = none' },
    { title: 'Stack', detail: 'one at a time: rebase on the previous branch, lint/test/validate' },
    { title: 'Final review', detail: 'one independent code review of the whole batch' },
    { title: 'Verify', detail: 'fixes of the final review, then the only full e2e of the batch' },
  ],
}

// args: {
//   base: 'fix/lote4',            // branch the batch starts from (the previous tip)
//   name: 'lote5',                // used for the verify branch and the e2e database
//   items: [{
//     slug: 'portal-items',       // short id
//     branch: 'feat/portal-items',
//     wt: 'pi',                   // worktree under .wt/ (2-3 letters: Windows MAX_PATH)
//     from: 'feat/x',             // optional: start from another item's branch (it then waits for it)
//     risk: 'high' | 'server' | 'content' | 'client' | 'docs',
//     brief: '...',               // goal, files and docs to read, constraints, done criteria
//   }],
// }
// Leaves everything as local commits: the coordinator pushes the tip once and opens one PR.

if (!args || !args.base || !args.name || !Array.isArray(args.items) || args.items.length === 0) {
  throw new Error('args: { base, name, items: [{ slug, branch, wt, risk, brief }] }')
}

const REPO = 'C:\\ProyectosVSCode\\RPG_Project'
const BASE = args.base
const NAME = args.name
const PATHX = 'export PATH="/c/Program Files/Go/bin:/c/Program Files/Docker/Docker/resources/bin:/c/Users/fenzo/go/bin:/c/Users/fenzo/AppData/Roaming/npm:$PATH"'
const ATTR = 'End every commit message with these two lines:\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01VYGzVaXXq1gtpVXN5LfFrF'
const RISKS = ['high', 'server', 'content', 'client', 'docs']
for (const it of args.items) {
  if (!it.slug || !it.branch || !it.wt || !it.brief || !RISKS.includes(it.risk)) {
    throw new Error(`item ${it.slug || '?'}: needs slug, branch, wt, brief and a risk in ${RISKS.join('|')}`)
  }
}

// The owner's cap: at most 2 agents at the same time (docs/11 "Lotes").
const MAX_AGENTS = 2
let active = 0
const waiting = []
async function slot(fn) {
  while (active >= MAX_AGENTS) await new Promise((resolve) => waiting.push(resolve))
  active++
  try {
    return await fn()
  } finally {
    active--
    const next = waiting.shift()
    if (next) next()
  }
}
const run = (prompt, opts) => slot(() => agent(prompt, opts))

const RULES = `Game: Neque's Realm (repo ${REPO}). Follow CLAUDE.md: server authoritative, single owner of world state (game loop goroutine, no DB I/O in the loop, no mutexes on entities), no time.Now() in game logic, player-visible text only through i18n es+en, content as data, ids with make gen-ids, legal rule (nothing from Tibia; third-party assets only CC0/CC-BY/OGA-BY/CC-BY-SA, fonts OFL, each file recorded in assets/CREDITS.md; art and music generated with the Gemini account of the owner are recorded there too, and their prompts never name another game, artist or work). Docs in Spanish; code, comments and commits in English.
Native Windows + Git Bash: start EVERY Bash call with: ${PATHX}
Never push, never open PRs, never call gh, never use git stash. Do NOT launch sub-agents (the owner caps agents at 2 at a time, sub-agents included).`

const WT = (it) => `Your worktree is ${REPO}\\.wt\\${it.wt} (branch ${it.branch}). If it already exists, an earlier run of this task was cut: reuse it, look at git status / git log / git diff and keep the good work. Otherwise create it from ${REPO}: git worktree add .wt/${it.wt} -b ${it.branch} ${it.from || BASE}. Work ONLY there (cd into it in every Bash call, absolute paths with that prefix); pnpm install --frozen-lockfile first.`

const IMPL = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, touches_server: { type: 'boolean' }, summary: { type: 'string' }, e2e_notes: { type: 'string' } },
  required: ['ok', 'touches_server', 'summary', 'e2e_notes'],
}
const DONE = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, summary: { type: 'string' } },
  required: ['ok', 'summary'],
}

function implement(it) {
  return run(`${RULES}
${WT(it)}
Do NOT use Docker, servers, make e2e or make test-integration: the batch runs them once at the end. Use make lint, make test, make validate, go test, vitest, mapcli/spritegen previews (review images with Read).
Done for this stage: the change + tests that fail without it + docs (Spanish) + docs/14 "Pendientes conocidos" adjusted + make lint test validate green + small Conventional Commits. ${ATTR}

TASK:
${it.brief}

Answer (structured): ok, touches_server (server/, proto/ or .github/ changed), summary (Spanish, PR-ready: what changed, decisions, tests, results, pending), e2e_notes (what the final e2e/screenshot review should look at).`, { label: `impl:${it.slug}`, phase: 'Implement', schema: IMPL })
}

const reviewPrompt = (it, round) => `${RULES}
Review the local branch ${it.branch} against ${it.from || BASE}: git -C ${REPO} diff ${it.from || BASE}...${it.branch} (worktree ${REPO}\\.wt\\${it.wt}, read files there). Do not modify files, no commits, no Docker, no e2e.
${round > 1 ? 'A first review was already applied: review the whole diff from scratch.\n' : ''}Task of the branch: ${it.brief}
Look for real bugs first (item or gold duplication or loss, exploits, players stuck, crashes, races, security of CI and untrusted input), then project rules, tests that do not test what they claim, docs that contradict the code. You may run go test / vitest without a database.
Answer in Spanish: BLOCKING (file:line, scenario, fix), IMPORTANT, MINOR; say explicitly if there is nothing blocking or important.`

const contentReviewPrompt = (it) => `${RULES}
Light content review of the local branch ${it.branch}: git -C ${REPO} diff ${it.from || BASE}...${it.branch} (worktree ${REPO}\\.wt\\${it.wt}). Read only; no commits, no Docker.
Check: i18n es/en complete and natural, no Tibia names or texts, numbers coherent with docs/02 and data/balance.yaml (prices: no buy/sell loop that creates money), map changes made with mapcli and valid, assets licensed and in CREDITS.
Answer in Spanish: BLOCKING / IMPORTANT / MINOR with file:line and fix, or "nada bloqueante ni importante".`

function fix(it, review, label) {
  return run(`${RULES}
${WT(it)}
Apply this code review to your branch (the work is already committed there). Fix every BLOCKING and IMPORTANT finding (verify it first; explain any you reject) and the cheap MINOR ones, each with a test that fails without the fix. make lint test validate green; commit. ${ATTR} No Docker, no e2e.
Review:
${review}`, { label, phase: 'Review', schema: DONE })
}

async function review(impl, it) {
  if (!impl || !impl.ok) return { impl, notes: '' }
  const risk = impl.touches_server && (it.risk === 'client' || it.risk === 'docs' || it.risk === 'content') ? 'server' : it.risk
  if (risk === 'client' || risk === 'docs') return { impl, notes: `Sin revisión de código (riesgo ${risk}).` }
  if (risk === 'content') {
    const r = await run(contentReviewPrompt(it), { label: `review:${it.slug}`, phase: 'Review', model: 'sonnet', effort: 'low' })
    const f = /BLOQUEANTE|BLOCKING|IMPORTANTE|IMPORTANT/.test(r || '') && !/nada bloqueante ni importante/i.test(r || '')
      ? await fix(it, r, `fix:${it.slug}`)
      : null
    return { impl, notes: `Revisión de contenido:\n${r}\n${f ? `Aplicada:\n${f.summary}` : ''}` }
  }
  const r1 = await run(reviewPrompt(it, 1), { label: `review:${it.slug}`, phase: 'Review', agentType: 'code-reviewer' })
  const f1 = await fix(it, r1, `fix:${it.slug}`)
  if (risk !== 'high') return { impl, notes: `Revisión aplicada:\n${f1 ? f1.summary : '(el agente de arreglos falló)'}` }
  const r2 = await run(reviewPrompt(it, 2), { label: `re-review:${it.slug}`, phase: 'Review', agentType: 'code-reviewer' })
  const f2 = await fix(it, r2, `re-fix:${it.slug}`)
  return { impl, notes: `Primera revisión aplicada:\n${f1 ? f1.summary : '(falló)'}\nSegunda revisión aplicada:\n${f2 ? f2.summary : '(falló)'}` }
}

// Stack: one branch at a time, in the order they get ready (an item with `from` waits for it).
let chain = Promise.resolve()
let prev = BASE
const stacked = []
function stack(r, it) {
  const p = chain.then(async () => {
    if (!r || !r.impl || !r.impl.ok) return { slug: it.slug, ok: false, summary: r && r.impl ? r.impl.summary : 'la implementación falló' }
    if (it.from && it.from !== BASE && !stacked.includes(it.from)) return { slug: it.slug, ok: false, summary: `No se apiló: su base ${it.from} no quedó en la pila.` }
    const base = prev
    const out = await run(`${RULES}
Rebase the local branch ${it.branch} (worktree ${REPO}\\.wt\\${it.wt}; cd into it in every Bash call) onto ${base}: git rebase ${base}. If a rebase is already in progress or the tree is dirty, an earlier run was cut: finish it. Resolve conflicts keeping both sides' intent (lists in data/i18n/docs/sprites/CREDITS: union; ids: make gen-ids; generated code: make gen / make sprites; migrations: unique increasing numbers). Then make lint test validate green (no Docker, no e2e: the batch runs them once at the end). Commit any fix. ${ATTR}
Answer (structured): ok (rebased and green), summary (Spanish: conflicts and how you resolved them).`, { label: `stack:${it.slug}`, phase: 'Stack', schema: DONE, effort: 'low' })
    if (out && out.ok) { prev = it.branch; stacked.push(it.branch) }
    return { slug: it.slug, ok: !!(out && out.ok), summary: `${r.impl.summary}\n\n${r.notes}\n\nApilado: ${out ? out.summary : '(falló)'}`, e2e_notes: r.impl.e2e_notes }
  })
  chain = p.catch(() => {})
  return p
}

const byBranch = new Map()
const ready = args.items.map((it) => {
  const after = it.from && it.from !== BASE ? byBranch.get(it.from) : null
  const done = (after || Promise.resolve()).then(() => implement(it)).then((impl) => review(impl, it))
  byBranch.set(it.branch, done)
  return done.then((r) => stack(r, it))
})
const results = await Promise.all(ready)
const tip = prev
log(`stacked: ${stacked.join(' -> ') || '(nothing)'}`)

let finalReview = null
let verify = null
if (stacked.length > 0) {
  phase('Final review')
  finalReview = await run(`${RULES}
Independent final review of the batch: git -C ${REPO} diff ${BASE} ${tip} (and --stat). Branches: ${stacked.join(' -> ')}. Read only; no commits, no Docker, no e2e. Focus on server/, proto/, .github/ and anything with untrusted input, economy or persistence; skim the rest.
Answer in Spanish: BLOCKING / IMPORTANT / MINOR (file:line, scenario, fix), or say explicitly there is nothing blocking or important.`, { label: 'final-review', phase: 'Final review', agentType: 'code-reviewer' })

  phase('Verify')
  const notes = results.filter((x) => x && x.ok).map((x) => `- ${x.slug}: ${x.e2e_notes}`).join('\n')
  verify = await run(`${RULES}
You close the batch "${NAME}". From ${REPO} create the worktree: git worktree add .wt/vf -b ${NAME}/verify ${tip} (if .wt/vf exists, an earlier run was cut: reuse it). Work only there; pnpm install --frozen-lockfile.
1. Apply the BLOCKING and IMPORTANT findings of the final review below (verify each; explain rejects) and cheap MINOR ones, with tests. Commit. ${ATTR}
2. Before Docker: the owner may be playing with 'make play' (a gameserver.exe and Vite on :8080/:5173 started from ${REPO}). Never stop it. For every PID that 'netstat -ano | grep LISTENING | grep -E ":(8080|5173) "' shows, read where it runs from: powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ProcessId=<PID>' | Format-List ExecutablePath,CommandLine". One whose path or command line is under ${REPO}\\.wt\\vf was left by a cut run of this same step: stop it (taskkill //PID <PID> //F). Any other is the owner's: wait in a loop (check every 2 min, up to 8 h) until it is gone. If it is still there after 8 h, stop: no Docker, no step 3 or 4; answer ok=false with a summary that says the fixes of step 1 are committed and the verification waits for the owner to close 'make play' (resume this step then). Then you are the only agent with Docker and ports. If docker info fails: powershell -NoProfile -Command "Start-Process 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'", poll, make db-up. Fresh database rpg_e2e_${NAME} (DROP IF EXISTS + CREATE via docker exec ... psql -U postgres); DATABASE_URL and TEST_DATABASE_URL = postgres://postgres:postgres@localhost:5432/rpg_e2e_${NAME}.
3. make lint, make test, make validate, make test-integration, make e2e — all full, the only e2e of the batch. Fix until green (never weaken tests; a flaky test gets its cause found and fixed). Review with Read the screenshots the items point at:
${notes}
4. taskkill //IM gameserver.exe //F, DROP the database, stop the Vite servers you started, then docker desktop stop and wsl --shutdown.
Final review:
${finalReview}
Answer (structured): ok (all green and committed), summary (Spanish, PR-ready: final review findings applied/rejected, real results of each make, screenshots reviewed, pending).`, { label: 'verify', phase: 'Verify', schema: DONE })
}

return { results, stacked, tip: verify && verify.ok ? `${NAME}/verify` : tip, finalReview, verify }
