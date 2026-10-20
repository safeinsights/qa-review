# Validation Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the qa-validate session read every Figma Dev Mode annotation read-only, list every requirement before it tests, classify each one (PASS / FAIL / CONFLICT / UNCLEAR / NOT TESTED), post a PM-readable comment, and open linked follow-up cards.

**Architecture:** A fixed read-only Plugin API script is the only code `use_figma` may run; a `PreToolUse` hook enforces that. The engine (`src/engine/jira.ts`) gains attachment download, issue creation, issue linking, and ADF `expand`/`mention` nodes, exposed as `qar` commands. A pure `recommendFollowUp` function decides how failures are routed. The Go GUI gains a cached "Figma seat" Doctor row. The skill text ties the pieces into phases.

**Tech Stack:** TypeScript (tsx runtime, vitest, Biome), Node ESM hook script, Go (Wails GUI, `go test`), Jira Cloud REST v3 + ADF, Figma Plugin API via the `plugin:figma:figma` MCP.

**Spec:** `docs/superpowers/specs/2026-10-15-validation-coverage-design.md`

## Global Constraints

- Formatting is Biome: 4-space, single quotes, no semicolons, 100-col. Run `pnpm lint:fix`; `pnpm lint` is the gate.
- Suites and anything loaded at suite time use relative imports; `src/` and `tests/` use the `@/` alias (existing convention in `src/cli/commands/jira.ts`).
- `src/cli/args.ts` scopes valueless switches per command in `COMMAND_BOOLEANS`; a new switch goes there, keyed by `CommandName`.
- Every new `qar` command needs an entry in `COMMANDS` (`src/cli/help.ts`) and a `case` in `bin/qar.ts`; `tests/cli/help.test.ts` checks the two agree.
- All Jira HTTP goes through `jiraFetch` (sandbox-aware error message).
- `.tmp/` is the only scratch location the skill may use.
- The fixed Figma script must never call a write API (setter, `create*`, `remove`, `appendChild`, `insertChild`, `setSharedPluginData`, `loadFontAsync`).
- Figma plan constant: `figmaPlanName = "SafeInsights"`. Seats `Full` and `Dev` pass; `View` and `Collab` fail.
- Seat cache lives at `<appSupportDir()>/figma-seat.json` and is valid 24 h. A failed probe is never cached.
- Default follow-up issue type `Bug`, default link type `Relates`; both are verified with Jira before `POST /issue`.
- Parent card after follow-up cards: heading `## VALIDATED WITH FOLLOW-UPS ✅`, transition as validated, `qar verdict-posted --result validated`.
- `node_modules` is absent in this checkout: run `pnpm install` once before any test (this is a dev checkout — `bin/qar.ts` exists — so the packaged-app warning in CLAUDE.md does not apply).

## Review Focus

1. **A `use_figma` call whose code is the fixed script plus one appended line** (e.g. `node.remove()` after the `return`). The hook must deny it. Pinned in Task 2 (`denies an extra trailing line`).
2. **A card attachment named like text but with a binary MIME type**, or a text file over a few MB. `jira-attachments --download` must skip non-text MIME types and refuse files over 2 MB with a clear message, not write garbage into `.tmp/`. Pinned in Task 3.
3. **An `{expand:…}` block with no closing `{expand}`.** The body must still post: treat the rest of the text as the expand body and do not drop it. Pinned in Task 4.
4. **A Jira project whose `createmeta` endpoint is forbidden (403) or returns no issue types.** `jira-create-issue` must stop with the HTTP error, not create an issue with a guessed type. Pinned in Task 5.
5. **A `whoami` result that lists SafeInsights twice (guest + member) with different seats.** The seat check must take the best seat (Full > Dev > Collab > View), not the first. Pinned in Task 7.

---

### Task 0: Install dependencies and confirm green

**Files:** none

- [ ] **Step 1: Install**

Run: `cd ~/code/si/qa-review && pnpm install`
Expected: completes; `node_modules/marklassian` exists.

- [ ] **Step 2: Baseline**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass. If anything fails, fix it before Task 1 (CLAUDE.md: a red check is never worked around).

---

### Task 1: The fixed read-only Figma script

**Files:**
- Create: `.claude/skills/qa-validate/figma-notes.js`
- Test: `tests/skills/figma-notes.test.ts`

**Interfaces:**
- Produces: the script file path `.claude/skills/qa-validate/figma-notes.js`, whose first two lines are exactly `const MODE = '<pages|locate|page>'` and `const TARGET = '<ids>'`. Task 2's hook compares against this file.

- [ ] **Step 1: Write the failing test**

```ts
// tests/skills/figma-notes.test.ts
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(__dirname, '../../.claude/skills/qa-validate/figma-notes.js')

// Names that change a Figma file. The script is sent to use_figma, which CAN write,
// so the only thing keeping it read-only is that none of these appear in it.
const WRITE_APIS = [
    /\bcreate[A-Z]\w*\s*\(/,
    /\.remove\s*\(/,
    /\bappendChild\b/,
    /\binsertChild\b/,
    /\bsetSharedPluginData\b/,
    /\bloadFontAsync\b/,
    /\bsetBoundVariable\b/,
    /\.(characters|fills|strokes|name|visible|opacity|x|y)\s*=[^=]/,
]

describe('figma-notes.js', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8')
    const lines = src.split('\n')

    it('starts with the two variable lines the hook allows to change', () => {
        expect(lines[0]).toMatch(/^const MODE = '(pages|locate|page)'/)
        expect(lines[1]).toMatch(/^const TARGET = '[^']*'/)
    })

    it('contains no write API', () => {
        for (const re of WRITE_APIS) expect(src).not.toMatch(re)
    })

    it('switches page at most once', () => {
        expect(src.match(/setCurrentPageAsync/g)?.length ?? 0).toBeLessThanOrEqual(1)
    })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/skills/figma-notes.test.ts`
Expected: FAIL — `ENOENT` reading the script.

- [ ] **Step 3: Write the script**

```js
const MODE = 'pages'
const TARGET = ''
// figma-notes.js — the ONLY code qa-validate sends to use_figma. Read-only.
// The hook .claude/hooks/figma-readonly.mjs denies any use_figma call whose code
// differs from this file in anything but the two lines above.
//   pages  → every page {id, name}
//   locate → for each id in TARGET (comma-separated): {id, name, type, page}
//   page   → TARGET is a page id: top-level frames + every annotation on the page
const cats = await figma.annotations.getAnnotationCategoriesAsync()
const catName = Object.fromEntries(cats.map(c => [c.id, c.label]))
const hasNotes = n => Array.isArray(n.annotations) && n.annotations.length > 0

if (MODE === 'pages') {
    return { pages: figma.root.children.map(p => ({ id: p.id, name: p.name })) }
}

if (MODE === 'locate') {
    const out = []
    for (const id of TARGET.split(',').map(s => s.trim()).filter(Boolean)) {
        const node = await figma.getNodeByIdAsync(id)
        if (!node) {
            out.push({ id, found: false })
            continue
        }
        let p = node
        while (p && p.type !== 'PAGE') p = p.parent
        out.push({
            id,
            found: true,
            name: node.name,
            type: node.type,
            page: p ? { id: p.id, name: p.name } : null,
        })
    }
    return { nodes: out }
}

if (MODE === 'page') {
    const page = await figma.getNodeByIdAsync(TARGET)
    if (!page || page.type !== 'PAGE') return { error: `not a page: ${TARGET}` }
    await figma.setCurrentPageAsync(page)
    const frames = page.children.map(f => ({
        id: f.id,
        name: f.name,
        type: f.type,
        annotations: ('findAll' in f ? f.findAll(hasNotes).length : 0) + (hasNotes(f) ? 1 : 0),
    }))
    const notes = []
    for (const top of page.children) {
        const nodes = [...(hasNotes(top) ? [top] : []), ...('findAll' in top ? top.findAll(hasNotes) : [])]
        for (const n of nodes) {
            const pathParts = []
            let p = n
            while (p && p.type !== 'PAGE') {
                pathParts.unshift(p.name)
                p = p.parent
            }
            for (const a of n.annotations) {
                notes.push({
                    frame: { id: top.id, name: top.name },
                    nodeId: n.id,
                    path: pathParts.join(' / '),
                    category: a.categoryId ? (catName[a.categoryId] ?? a.categoryId) : null,
                    text: a.labelMarkdown || a.label || '',
                    properties: (a.properties || []).map(p => p.type),
                })
            }
        }
    }
    return { page: { id: page.id, name: page.name }, categories: cats.map(c => c.label), frames, notes }
}

return { error: `unknown MODE: ${MODE}` }
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run tests/skills/figma-notes.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Check `pnpm lint` does not choke on the file**

Run: `pnpm lint`
Expected: pass. If Biome lints `.claude/`, add `".claude/skills/**/*.js"` to the `files.ignore`/`includes` exclusion in `biome.json` — top-level `return` is legal only inside `use_figma`'s wrapper.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/qa-validate/figma-notes.js tests/skills/figma-notes.test.ts biome.json
git commit -m "Add the fixed read-only Figma annotations script"
```

---

### Task 2: The `use_figma` guard hook

**Files:**
- Create: `.claude/hooks/figma-readonly.mjs`
- Modify: `.claude/settings.json` (add `hooks.PreToolUse`)
- Test: `tests/skills/figma-readonly-hook.test.ts`

**Interfaces:**
- Produces: `checkFigmaCode(code: string, script: string): { allow: boolean; reason?: string }` exported from the hook module. The CLI entry reads `{ tool_input: { code } }` from stdin and prints a PreToolUse JSON decision.

- [ ] **Step 1: Write the failing test**

```ts
// tests/skills/figma-readonly-hook.test.ts
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkFigmaCode } from '../../.claude/hooks/figma-readonly.mjs'

const script = fs.readFileSync(
    path.resolve(__dirname, '../../.claude/skills/qa-validate/figma-notes.js'),
    'utf8'
)

function withHeader(mode: string, target: string): string {
    const rest = script.split('\n').slice(2).join('\n')
    return `const MODE = '${mode}'\nconst TARGET = '${target}'\n${rest}`
}

describe('checkFigmaCode', () => {
    it('allows the unchanged script', () => {
        expect(checkFigmaCode(script, script)).toEqual({ allow: true })
    })

    it('allows each mode with a valid target', () => {
        expect(checkFigmaCode(withHeader('pages', ''), script).allow).toBe(true)
        expect(checkFigmaCode(withHeader('locate', '3531:6192,3531:6217'), script).allow).toBe(true)
        expect(checkFigmaCode(withHeader('page', '589:3591'), script).allow).toBe(true)
    })

    it('ignores line-ending and trailing-whitespace differences', () => {
        const crlf = script.replace(/\n/g, '  \r\n')
        expect(checkFigmaCode(crlf, script).allow).toBe(true)
    })

    it('denies a changed body', () => {
        const changed = script.replace('return { pages:', 'figma.root.children[0].remove(); return { pages:')
        const result = checkFigmaCode(changed, script)
        expect(result.allow).toBe(false)
        expect(result.reason).toContain('figma-notes.js')
    })

    it('denies an extra trailing line', () => {
        expect(checkFigmaCode(`${script}\nfigma.currentPage.children[0].remove()\n`, script).allow).toBe(false)
    })

    it('denies a bad MODE', () => {
        expect(checkFigmaCode(withHeader('write', ''), script).allow).toBe(false)
    })

    it('denies a TARGET that is not a node id list', () => {
        expect(checkFigmaCode(withHeader('page', "'; figma.root.remove(); '"), script).allow).toBe(false)
        expect(checkFigmaCode(withHeader('page', 'abc'), script).allow).toBe(false)
        expect(checkFigmaCode(withHeader('pages', '1:2'), script).allow).toBe(false)
    })

    it('denies when the script file is missing', () => {
        const result = checkFigmaCode(script, '')
        expect(result.allow).toBe(false)
        expect(result.reason).toContain('Sync')
    })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/skills/figma-readonly-hook.test.ts`
Expected: FAIL — cannot resolve `figma-readonly.mjs`.

- [ ] **Step 3: Write the hook**

```js
// .claude/hooks/figma-readonly.mjs
// PreToolUse guard for mcp__plugin_figma_figma__use_figma.
//
// use_figma runs arbitrary Plugin API code and CAN edit the design file. The
// validator only ever needs to READ annotations, so the only code it may send is
// .claude/skills/qa-validate/figma-notes.js, with just its MODE/TARGET lines varied.
// Anything else is denied here — the allowlist in gui/app.go pre-approves the whole
// figma server, so this hook is what keeps the session read-only.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../skills/qa-validate/figma-notes.js'
)
const MODES = new Set(['pages', 'locate', 'page'])
const NODE_LIST = /^\d+:\d+(,\d+:\d+)*$/
const HEADER = /^const (MODE|TARGET) = '([^'\\]*)'\s*$/

function normalize(text) {
    return text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(line => line.replace(/\s+$/, ''))
        .join('\n')
        .replace(/\n+$/, '')
}

// Splits off the two header lines; returns null when they are not the expected shape.
function splitHeader(text) {
    const lines = normalize(text).split('\n')
    const mode = lines[0]?.match(HEADER)
    const target = lines[1]?.match(HEADER)
    if (!mode || mode[1] !== 'MODE' || !target || target[1] !== 'TARGET') return null
    return { mode: mode[2], target: target[2], body: lines.slice(2).join('\n') }
}

export function checkFigmaCode(code, script) {
    const deny = reason => ({ allow: false, reason })
    if (!script) {
        return deny(
            'figma-notes.js is missing from this clone — Sync the repo (QA Runner Sync button) and retry.'
        )
    }
    const sent = splitHeader(code)
    const fixed = splitHeader(script)
    if (!sent || !fixed || sent.body !== fixed.body) {
        return deny(
            'use_figma may only run .claude/skills/qa-validate/figma-notes.js unchanged ' +
                '(MODE and TARGET lines only).'
        )
    }
    if (!MODES.has(sent.mode)) return deny(`MODE must be one of pages, locate, page (got '${sent.mode}')`)
    if (sent.mode === 'pages' ? sent.target !== '' : !NODE_LIST.test(sent.target)) {
        return deny(`TARGET must be empty for 'pages', else node ids like 123:456 (got '${sent.target}')`)
    }
    return { allow: true }
}

function main() {
    let raw = ''
    try {
        raw = fs.readFileSync(0, 'utf8')
    } catch {}
    let code = ''
    try {
        code = JSON.parse(raw)?.tool_input?.code ?? ''
    } catch {}
    let script = ''
    try {
        script = fs.readFileSync(SCRIPT_PATH, 'utf8')
    } catch {}
    const result = checkFigmaCode(code, script)
    const decision = result.allow
        ? { permissionDecision: 'allow' }
        : { permissionDecision: 'deny', permissionDecisionReason: result.reason }
    process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision } })
    )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run tests/skills/figma-readonly-hook.test.ts`
Expected: PASS (9 tests). If vitest refuses the `.mjs` import under TypeScript, add `// @ts-expect-error untyped hook module` above the import.

- [ ] **Step 5: Wire the hook in `.claude/settings.json`**

Add a top-level `"hooks"` key next to `"permissions"`:

```json
"hooks": {
  "PreToolUse": [
    {
      "matcher": "mcp__plugin_figma_figma__use_figma",
      "hooks": [
        {
          "type": "command",
          "command": "\"${QAR_NODE:-node}\" \"$CLAUDE_PROJECT_DIR/.claude/hooks/figma-readonly.mjs\""
        }
      ]
    }
  ]
}
```

- [ ] **Step 6: Smoke-test the CLI path**

Run:
```bash
printf '%s' "$(node -e "const fs=require('fs');console.log(JSON.stringify({tool_input:{code:fs.readFileSync('.claude/skills/qa-validate/figma-notes.js','utf8')}}))")" | node .claude/hooks/figma-readonly.mjs
```
Expected: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}`

Run: `echo '{"tool_input":{"code":"figma.root.remove()"}}' | node .claude/hooks/figma-readonly.mjs`
Expected: a `deny` decision whose reason names `figma-notes.js`.

- [ ] **Step 7: Lint and commit**

Run: `pnpm lint:fix && pnpm lint`

```bash
git add .claude/hooks/figma-readonly.mjs .claude/settings.json tests/skills/figma-readonly-hook.test.ts
git commit -m "Deny any use_figma call that is not the fixed read-only script"
```

---

### Task 3: Jira attachments — list and download

**Files:**
- Modify: `src/engine/jira.ts` (append after `deleteComment`)
- Modify: `src/cli/commands/jira.ts` (append)
- Modify: `src/cli/help.ts` (`COMMANDS`), `src/cli/args.ts` (`COMMAND_BOOLEANS`), `bin/qar.ts` (dispatch)
- Test: `tests/engine/jira.test.ts`, `tests/cli/jira-attachments.test.ts`

**Interfaces:**
- Produces:
  - `interface JiraAttachment { id: string; filename: string; mimeType: string; size: number }`
  - `listAttachments(config: JiraConfig, issueKey: string): Promise<JiraAttachment[]>`
  - `downloadAttachment(config: JiraConfig, attachmentId: string, destPath: string): Promise<void>`
  - `isTextAttachment(a: JiraAttachment): boolean` (mime `text/*` or filename `.md`/`.txt`/`.csv`)
  - `qar jira-attachments --issue <KEY> [--download] [--dir <path>]` — prints one JSON line per attachment `{id, filename, mimeType, size, saved?}`.

- [ ] **Step 1: Write the failing engine tests**

Append to `tests/engine/jira.test.ts` (extend the existing import from `@/engine/jira` with `listAttachments`, `downloadAttachment`, `isTextAttachment`):

```ts
describe('listAttachments', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('requests only the attachment field and maps the rows', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    fields: {
                        attachment: [
                            { id: '10', filename: 'manualtest617.md', mimeType: 'text/markdown', size: 1200 },
                            { id: '11', filename: 'shot.png', mimeType: 'image/png', size: 90000 },
                        ],
                    },
                }),
                { status: 200 }
            )
        )
        vi.stubGlobal('fetch', fetchMock)
        const rows = await listAttachments(
            { baseUrl: 'https://x.atlassian.net', email: 'a', apiToken: 'b' },
            'OTTER-617'
        )
        expect(fetchMock.mock.calls[0][0]).toBe(
            'https://x.atlassian.net/rest/api/3/issue/OTTER-617?fields=attachment'
        )
        expect(rows).toEqual([
            { id: '10', filename: 'manualtest617.md', mimeType: 'text/markdown', size: 1200 },
            { id: '11', filename: 'shot.png', mimeType: 'image/png', size: 90000 },
        ])
    })
})

describe('isTextAttachment', () => {
    it('accepts text mime types and md/txt/csv names, rejects images', () => {
        expect(isTextAttachment({ id: '1', filename: 'a.md', mimeType: 'application/octet-stream', size: 1 })).toBe(true)
        expect(isTextAttachment({ id: '1', filename: 'a.bin', mimeType: 'text/plain', size: 1 })).toBe(true)
        expect(isTextAttachment({ id: '1', filename: 'a.png', mimeType: 'image/png', size: 1 })).toBe(false)
    })
})

describe('downloadAttachment', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('follows the content redirect and writes the bytes', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('# plan', { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-att-'))
        const dest = path.join(dir, 'plan.md')
        await downloadAttachment(
            { baseUrl: 'https://x.atlassian.net', email: 'a', apiToken: 'b' },
            '10',
            dest
        )
        expect(fetchMock.mock.calls[0][0]).toBe('https://x.atlassian.net/rest/api/3/attachment/content/10')
        expect(fetchMock.mock.calls[0][1].redirect).toBe('follow')
        expect(fs.readFileSync(dest, 'utf8')).toBe('# plan')
        fs.rmSync(dir, { recursive: true, force: true })
    })
})
```

Add `import fs from 'node:fs'`, `import os from 'node:os'`, `import path from 'node:path'` at the top of the test file.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/engine/jira.test.ts`
Expected: FAIL — `listAttachments` is not exported.

- [ ] **Step 3: Implement in `src/engine/jira.ts`**

```ts
export interface JiraAttachment {
    id: string
    filename: string
    mimeType: string
    size: number
}

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.csv'])

// Text attachments (a developer's test plan, a CSV of cases) add requirements the
// card text leaves out. Images are listed but never downloaded — the validator can't
// read them, and a binary "text" file would just be garbage under .tmp/.
export function isTextAttachment(attachment: JiraAttachment): boolean {
    return (
        attachment.mimeType.startsWith('text/') ||
        TEXT_EXTENSIONS.has(path.extname(attachment.filename).toLowerCase())
    )
}

// The MCP's jira_get_issue omits attachments unless `fields` names them, and even
// then returns metadata only — this is the path to their CONTENT.
export async function listAttachments(
    config: JiraConfig,
    issueKey: string
): Promise<JiraAttachment[]> {
    const response = await jiraFetch(
        `${config.baseUrl}/rest/api/3/issue/${issueKey}?fields=attachment`,
        { method: 'GET', headers: { Authorization: authHeader(config) } }
    )
    await assertOk(response, `Listing attachments on ${issueKey}`)
    const body = (await response.json()) as { fields?: { attachment?: JiraAttachment[] } }
    return (body.fields?.attachment ?? []).map(a => ({
        id: String(a.id),
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
    }))
}

// Same endpoint resolveMediaId uses, but FOLLOWING the redirect to the bytes.
export async function downloadAttachment(
    config: JiraConfig,
    attachmentId: string,
    destPath: string
): Promise<void> {
    const response = await jiraFetch(
        `${config.baseUrl}/rest/api/3/attachment/content/${attachmentId}`,
        { method: 'GET', headers: { Authorization: authHeader(config) }, redirect: 'follow' }
    )
    await assertOk(response, `Downloading attachment ${attachmentId}`)
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    fs.writeFileSync(destPath, Buffer.from(await response.arrayBuffer()))
}
```

- [ ] **Step 4: Run the engine tests**

Run: `pnpm vitest run tests/engine/jira.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing command test**

```ts
// tests/cli/jira-attachments.test.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { jiraAttachmentsCommand } from '@/cli/commands/jira'

const vars = { JIRA_USERNAME: 'a@b.c', JIRA_API_TOKEN: 't', JIRA_URL: 'https://x.atlassian.net' }

function stubJira(rows: unknown[], content = 'body') {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
            url.includes('/attachment/content/')
                ? new Response(content, { status: 200 })
                : new Response(JSON.stringify({ fields: { attachment: rows } }), { status: 200 })
        )
    )
}

describe('jira-attachments', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('lists every attachment without downloading', async () => {
        stubJira([{ id: '10', filename: 'a.md', mimeType: 'text/markdown', size: 5 }])
        const out: string[] = []
        vi.spyOn(process.stdout, 'write').mockImplementation(s => (out.push(String(s)), true))
        await jiraAttachmentsCommand({ issue: 'OTTER-1' }, vars)
        expect(JSON.parse(out[0])).toEqual({ id: '10', filename: 'a.md', mimeType: 'text/markdown', size: 5 })
    })

    it('downloads only text attachments under the size cap into --dir', async () => {
        stubJira([
            { id: '10', filename: 'plan.md', mimeType: 'text/markdown', size: 5 },
            { id: '11', filename: 'shot.png', mimeType: 'image/png', size: 5 },
            { id: '12', filename: 'huge.txt', mimeType: 'text/plain', size: 3 * 1024 * 1024 },
        ])
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-att-'))
        const out: string[] = []
        vi.spyOn(process.stdout, 'write').mockImplementation(s => (out.push(String(s)), true))
        await jiraAttachmentsCommand({ issue: 'OTTER-1', download: 'true', dir }, vars)
        const rows = out.map(l => JSON.parse(l))
        expect(rows[0].saved).toBe(path.join(dir, 'plan.md'))
        expect(fs.readFileSync(rows[0].saved, 'utf8')).toBe('body')
        expect(rows[1].saved).toBeUndefined()
        expect(rows[2].saved).toBeUndefined()
        expect(rows[2].skipped).toMatch(/2 MB/)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('requires --issue', async () => {
        await expect(jiraAttachmentsCommand({}, vars)).rejects.toThrow('--issue')
    })
})
```

- [ ] **Step 6: Implement the command**

Append to `src/cli/commands/jira.ts` (extend the import from `@/engine/jira` with `downloadAttachment`, `isTextAttachment`, `listAttachments`; add `import path from 'node:path'`):

```ts
const MAX_TEXT_ATTACHMENT_BYTES = 2 * 1024 * 1024

// `qar jira-attachments --issue <KEY> [--download] [--dir <path>]`
//
// Lists a card's attachments as JSON lines; with --download, saves the TEXT ones
// (test plans, CSVs) under --dir (default .tmp/<KEY>-attachments) so the validator
// can read them. Images are listed only.
export async function jiraAttachmentsCommand(
    opts: Record<string, string>,
    vars: Vars
): Promise<void> {
    const issue = opts.issue ?? ''
    if (!issue) throw new Error('jira-attachments requires --issue <KEY>')
    const config = jiraConfig(vars)
    const download = opts.download === 'true'
    const dir = opts.dir || path.join('.tmp', `${issue}-attachments`)

    for (const attachment of await listAttachments(config, issue)) {
        const row: Record<string, unknown> = { ...attachment }
        if (download && isTextAttachment(attachment)) {
            if (attachment.size > MAX_TEXT_ATTACHMENT_BYTES) {
                row.skipped = 'larger than 2 MB'
            } else {
                const dest = path.join(dir, path.basename(attachment.filename))
                await downloadAttachment(config, attachment.id, dest)
                row.saved = dest
            }
        }
        process.stdout.write(`${JSON.stringify(row)}\n`)
    }
}
```

- [ ] **Step 7: Register the command**

`src/cli/help.ts`, after the `jira-delete-comment` entry:

```ts
    {
        name: 'jira-attachments',
        usage: 'qar jira-attachments --issue <KEY> [--download] [--dir <path>]',
        summary: "List a card's attachments; --download saves the text ones under .tmp/.",
        details:
            'jira_get_issue returns attachment metadata at best, never content. Text ' +
            'attachments (.md/.txt/.csv, or text/* mime) are saved; images are listed only.',
    },
```

`src/cli/args.ts`, in `COMMAND_BOOLEANS`: `'jira-attachments': ['download'],`

`bin/qar.ts`, next to the other jira cases: `case 'jira-attachments': return jiraAttachmentsCommand(opts, await loadSettings())` and add `jiraAttachmentsCommand` to the import from `@/cli/commands/jira`.

- [ ] **Step 8: Run all tests, typecheck, lint**

Run: `pnpm vitest run tests/cli/jira-attachments.test.ts tests/cli/help.test.ts tests/cli/args.test.ts && pnpm typecheck && pnpm lint:fix && pnpm lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/engine/jira.ts src/cli/commands/jira.ts src/cli/help.ts src/cli/args.ts bin/qar.ts tests/engine/jira.test.ts tests/cli/jira-attachments.test.ts
git commit -m "Add qar jira-attachments to list and download a card's text attachments"
```

---

### Task 4: ADF `expand` and `mention` nodes; `--mention` on jira-comment

**Files:**
- Modify: `src/engine/jira.ts` (`buildCommentAdf`)
- Modify: `src/cli/commands/jira.ts` (`jiraCommentCommand`), `src/cli/help.ts` (usage line)
- Test: `tests/engine/jira.test.ts`

**Interfaces:**
- Produces:
  - `buildCommentAdf(segments: CommentSegment[], options?: { mention?: string }): Record<string, unknown>` — `{expand:Title}…{expand}` in a text segment becomes an ADF `expand` node; `{{mention}}` in text becomes a `mention` node for `options.mention` (an accountId). With `mention` set but no placeholder, a mention paragraph is prepended.
  - `splitExpands(text: string): Array<{ kind: 'markdown'; text: string } | { kind: 'expand'; title: string; text: string }>` (exported for tests).
  - `qar jira-comment … [--mention <accountId>]`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/engine/jira.test.ts` (extend the import with `splitExpands`):

```ts
describe('splitExpands', () => {
    it('splits an expand block out of surrounding markdown', () => {
        expect(splitExpands('intro\n\n{expand:Passed (2)}\n- a\n- b\n{expand}\n\nafter')).toEqual([
            { kind: 'markdown', text: 'intro\n\n' },
            { kind: 'expand', title: 'Passed (2)', text: '- a\n- b\n' },
            { kind: 'markdown', text: '\n\nafter' },
        ])
    })

    it('treats a missing closing tag as "to the end"', () => {
        expect(splitExpands('{expand:T}\nbody')).toEqual([{ kind: 'expand', title: 'T', text: 'body' }])
    })
})

describe('buildCommentAdf expand and mention', () => {
    it('emits an ADF expand node with the title and inner blocks', () => {
        const doc = buildCommentAdf([{ type: 'text', text: '{expand:Passed (2)}\n- a\n- b\n{expand}' }])
        const node = (doc.content as Record<string, unknown>[])[0]
        expect(node.type).toBe('expand')
        expect(node.attrs).toEqual({ title: 'Passed (2)' })
        expect((node.content as { type: string }[])[0].type).toBe('bulletList')
    })

    it('replaces {{mention}} with a mention node inline', () => {
        const doc = buildCommentAdf([{ type: 'text', text: 'Decisions for {{mention}}:' }], {
            mention: '62a8e164bfade2006964f268',
        })
        const para = (doc.content as Record<string, unknown>[])[0]
        const inline = para.content as Record<string, unknown>[]
        expect(inline.map(n => n.type)).toEqual(['text', 'mention', 'text'])
        expect(inline[1].attrs).toEqual({ id: '62a8e164bfade2006964f268' })
    })

    it('prepends a mention paragraph when the body has no placeholder', () => {
        const doc = buildCommentAdf([{ type: 'text', text: 'hello' }], { mention: 'abc' })
        const first = (doc.content as Record<string, unknown>[])[0]
        expect((first.content as { type: string }[])[0].type).toBe('mention')
    })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/engine/jira.test.ts`
Expected: FAIL — `splitExpands` not exported.

- [ ] **Step 3: Implement**

In `src/engine/jira.ts`, replace `buildCommentAdf` with:

```ts
export type BodyPart =
    | { kind: 'markdown'; text: string }
    | { kind: 'expand'; title: string; text: string }

const EXPAND_OPEN = /^\{expand:([^}]*)\}[ \t]*\n?/m
const EXPAND_CLOSE = /^\{expand\}[ \t]*\n?/m

// A long validation comment buries the three lines a PM needs under forty PASS
// rows, so PASS rows go inside a collapsed `{expand:Passed (N)}…{expand}` block.
// marklassian has no syntax for ADF's expand node, so the block is split out
// HERE and each part converted separately. A block with no closing tag runs to
// the end rather than being dropped.
export function splitExpands(text: string): BodyPart[] {
    const parts: BodyPart[] = []
    let rest = text
    for (;;) {
        const open = rest.match(EXPAND_OPEN)
        if (!open || open.index === undefined) break
        if (open.index > 0) parts.push({ kind: 'markdown', text: rest.slice(0, open.index) })
        rest = rest.slice(open.index + open[0].length)
        const close = rest.match(EXPAND_CLOSE)
        const end = close?.index ?? rest.length
        parts.push({ kind: 'expand', title: open[1].trim(), text: rest.slice(0, end) })
        rest = close ? rest.slice(end + close[0].length) : ''
    }
    if (rest) parts.push({ kind: 'markdown', text: rest })
    return parts
}

const MENTION_TOKEN = '{{mention}}'

function markdownBlocks(text: string): Record<string, unknown>[] {
    if (!text.trim()) return []
    const doc = markdownToAdf(text) as { content?: Record<string, unknown>[] }
    return doc.content ?? []
}

// Walks inline text nodes and splits `{{mention}}` into a mention node, which is
// what makes Jira notify the PM — a typed @name in markdown is just text.
function injectMentions(nodes: Record<string, unknown>[], accountId: string): boolean {
    let found = false
    for (const node of nodes) {
        const children = node.content as Record<string, unknown>[] | undefined
        if (!children) continue
        const next: Record<string, unknown>[] = []
        for (const child of children) {
            if (child.type === 'text' && typeof child.text === 'string' && child.text.includes(MENTION_TOKEN)) {
                found = true
                const pieces = child.text.split(MENTION_TOKEN)
                pieces.forEach((piece, i) => {
                    if (piece) next.push({ ...child, text: piece })
                    if (i < pieces.length - 1) next.push({ type: 'mention', attrs: { id: accountId } })
                })
            } else {
                next.push(child)
            }
        }
        node.content = next
        if (injectMentions(next, accountId)) found = true
    }
    return found
}

export function buildCommentAdf(
    segments: CommentSegment[],
    options: { mention?: string } = {}
): Record<string, unknown> {
    const content: Record<string, unknown>[] = []
    for (const segment of segments) {
        if (segment.type === 'text') {
            for (const part of splitExpands(segment.text)) {
                if (part.kind === 'markdown') content.push(...markdownBlocks(part.text))
                else {
                    content.push({
                        type: 'expand',
                        attrs: { title: part.title },
                        content: markdownBlocks(part.text),
                    })
                }
            }
        } else {
            const attrs: Record<string, unknown> = {
                id: segment.mediaId,
                type: 'file',
                collection: '',
            }
            if (segment.width) attrs.width = segment.width
            if (segment.height) attrs.height = segment.height
            content.push({
                type: 'mediaSingle',
                attrs: { layout: 'center' },
                content: [{ type: 'media', attrs }],
            })
        }
    }
    if (options.mention) {
        const found = injectMentions(content, options.mention)
        if (!found) {
            content.unshift({
                type: 'paragraph',
                content: [{ type: 'mention', attrs: { id: options.mention } }],
            })
        }
    }
    // An ADF doc must contain at least one node.
    if (!content.length) content.push({ type: 'paragraph', content: [] })
    return { version: 1, type: 'doc', content }
}
```

Keep the existing comment above the function (it still explains the media path); add one line to it: "`{expand:…}` blocks and `{{mention}}` are handled here too — see `splitExpands` / `injectMentions`."

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/engine/jira.test.ts`
Expected: PASS, including the pre-existing `buildCommentAdf` tests.

- [ ] **Step 5: Thread `--mention` through `jira-comment`**

In `jiraCommentCommand` (`src/cli/commands/jira.ts`) change the ADF line to:

```ts
    const adf = buildCommentAdf(splitBodyIntoSegments(body, mediaIds), {
        mention: opts.mention || undefined,
    })
```

In `src/cli/help.ts` update the `jira-comment` entry:

```ts
        usage: 'qar jira-comment --issue <KEY> --body-file <path.md> [--images a.png,b.png] [--mention <accountId>]',
        details:
            'Body is Markdown (headings, bold, lists, links). Use {{image:N}} to place an image ' +
            'inline, {expand:Title}…{expand} for a collapsed block, and {{mention}} (with ' +
            '--mention <accountId>) to @-mention someone so Jira notifies them.',
```

- [ ] **Step 6: Typecheck, lint, full tests, commit**

Run: `pnpm typecheck && pnpm lint:fix && pnpm lint && pnpm test`

```bash
git add src/engine/jira.ts src/cli/commands/jira.ts src/cli/help.ts tests/engine/jira.test.ts
git commit -m "Render {expand} blocks and {{mention}} in Jira comments"
```

---

### Task 5: `qar jira-create-issue` — create, describe with images, link

**Files:**
- Modify: `src/engine/jira.ts`
- Create: `src/cli/commands/jira-create-issue.ts`
- Modify: `src/cli/help.ts`, `bin/qar.ts`
- Test: `tests/engine/jira.test.ts`, `tests/cli/jira-create-issue.test.ts`

**Interfaces:**
- Produces, in `src/engine/jira.ts`:
  - `issueTypeNames(config, projectKey): Promise<string[]>` — `GET /rest/api/3/issue/createmeta/{project}/issuetypes` → `issueTypes[].name`.
  - `linkTypeNames(config): Promise<string[]>` — `GET /rest/api/3/issueLinkType` → `issueLinkTypes[].name`.
  - `createIssue(config, { project, type, summary }): Promise<{ key: string; id: string }>` — `POST /rest/api/3/issue`.
  - `updateDescriptionAdf(config, key, adf): Promise<void>` — `PUT /rest/api/3/issue/{key}`.
  - `linkIssues(config, { type, inward, outward }): Promise<void>` — `POST /rest/api/3/issueLink` with `{ type: { name }, inwardIssue: { key: inward }, outwardIssue: { key: outward } }`.
- Produces the command `qar jira-create-issue --project <KEY> --summary <text> --body-file <path.md> [--type Bug] [--images a.png,b.png] [--link <PARENT>] [--link-type Relates]`, printing `{"key","url"}`.
- Consumes: `uploadAttachment`, `resolveMediaId`, `buildCommentAdf` (Task 4), `splitBodyIntoSegments`.

- [ ] **Step 1: Write the failing engine tests**

Append to `tests/engine/jira.test.ts` (extend the import with `createIssue`, `issueTypeNames`, `linkIssues`, `linkTypeNames`, `updateDescriptionAdf`):

```ts
const cfg = { baseUrl: 'https://x.atlassian.net', email: 'a', apiToken: 'b' }

describe('issue creation endpoints', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('issueTypeNames reads createmeta for the project', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ issueTypes: [{ name: 'Task' }, { name: 'Bug' }] }), { status: 200 })
        )
        vi.stubGlobal('fetch', fetchMock)
        expect(await issueTypeNames(cfg, 'OTTER')).toEqual(['Task', 'Bug'])
        expect(fetchMock.mock.calls[0][0]).toBe(
            'https://x.atlassian.net/rest/api/3/issue/createmeta/OTTER/issuetypes'
        )
    })

    it('issueTypeNames surfaces a 403 instead of guessing', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 })))
        await expect(issueTypeNames(cfg, 'OTTER')).rejects.toThrow('403')
    })

    it('linkTypeNames reads the global link types', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ issueLinkTypes: [{ name: 'Blocks' }, { name: 'Relates' }] }), { status: 200 })
            )
        )
        expect(await linkTypeNames(cfg)).toEqual(['Blocks', 'Relates'])
    })

    it('createIssue posts project, type and summary and returns the key', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ id: '99', key: 'OTTER-901' }), { status: 201 })
        )
        vi.stubGlobal('fetch', fetchMock)
        expect(await createIssue(cfg, { project: 'OTTER', type: 'Bug', summary: 'S' })).toEqual({
            id: '99',
            key: 'OTTER-901',
        })
        const body = JSON.parse(fetchMock.mock.calls[0][1].body)
        expect(body).toEqual({
            fields: { project: { key: 'OTTER' }, issuetype: { name: 'Bug' }, summary: 'S' },
        })
    })

    it('updateDescriptionAdf PUTs the ADF as fields.description', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 204 }))
        vi.stubGlobal('fetch', fetchMock)
        const adf = { version: 1, type: 'doc', content: [] }
        await updateDescriptionAdf(cfg, 'OTTER-901', adf)
        expect(fetchMock.mock.calls[0][0]).toBe('https://x.atlassian.net/rest/api/3/issue/OTTER-901')
        expect(fetchMock.mock.calls[0][1].method).toBe('PUT')
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ fields: { description: adf } })
    })

    it('linkIssues posts the named link between the two keys', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 201 }))
        vi.stubGlobal('fetch', fetchMock)
        await linkIssues(cfg, { type: 'Relates', inward: 'OTTER-901', outward: 'OTTER-617' })
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
            type: { name: 'Relates' },
            inwardIssue: { key: 'OTTER-901' },
            outwardIssue: { key: 'OTTER-617' },
        })
    })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/engine/jira.test.ts`
Expected: FAIL — missing exports.

- [ ] **Step 3: Implement in `src/engine/jira.ts`**

```ts
function jsonHeaders(config: JiraConfig): Record<string, string> {
    return { Authorization: authHeader(config), 'Content-Type': 'application/json' }
}

// Issue-type and link-type NAMES are per-site configuration. A wrong name is a
// Jira 400 naming nothing useful, so both are checked before a card is created.
export async function issueTypeNames(config: JiraConfig, projectKey: string): Promise<string[]> {
    const response = await jiraFetch(
        `${config.baseUrl}/rest/api/3/issue/createmeta/${projectKey}/issuetypes`,
        { method: 'GET', headers: { Authorization: authHeader(config) } }
    )
    await assertOk(response, `Reading issue types for ${projectKey}`)
    const body = (await response.json()) as { issueTypes?: Array<{ name: string }> }
    return (body.issueTypes ?? []).map(t => t.name)
}

export async function linkTypeNames(config: JiraConfig): Promise<string[]> {
    const response = await jiraFetch(`${config.baseUrl}/rest/api/3/issueLinkType`, {
        method: 'GET',
        headers: { Authorization: authHeader(config) },
    })
    await assertOk(response, 'Reading issue link types')
    const body = (await response.json()) as { issueLinkTypes?: Array<{ name: string }> }
    return (body.issueLinkTypes ?? []).map(t => t.name)
}

// Created with summary only: the description needs media ids, and media can only
// be uploaded to an issue that already exists, so the description is PUT afterwards.
export async function createIssue(
    config: JiraConfig,
    fields: { project: string; type: string; summary: string }
): Promise<{ key: string; id: string }> {
    const response = await jiraFetch(`${config.baseUrl}/rest/api/3/issue`, {
        method: 'POST',
        headers: jsonHeaders(config),
        body: JSON.stringify({
            fields: {
                project: { key: fields.project },
                issuetype: { name: fields.type },
                summary: fields.summary,
            },
        }),
    })
    await assertOk(response, 'Creating issue')
    const created = (await response.json()) as { id: string; key: string }
    return { key: created.key, id: created.id }
}

export async function updateDescriptionAdf(
    config: JiraConfig,
    issueKey: string,
    adf: Record<string, unknown>
): Promise<void> {
    const response = await jiraFetch(`${config.baseUrl}/rest/api/3/issue/${issueKey}`, {
        method: 'PUT',
        headers: jsonHeaders(config),
        body: JSON.stringify({ fields: { description: adf } }),
    })
    await assertOk(response, `Setting description on ${issueKey}`)
}

export async function linkIssues(
    config: JiraConfig,
    link: { type: string; inward: string; outward: string }
): Promise<void> {
    const response = await jiraFetch(`${config.baseUrl}/rest/api/3/issueLink`, {
        method: 'POST',
        headers: jsonHeaders(config),
        body: JSON.stringify({
            type: { name: link.type },
            inwardIssue: { key: link.inward },
            outwardIssue: { key: link.outward },
        }),
    })
    await assertOk(response, `Linking ${link.inward} to ${link.outward}`)
}
```

Refactor `addCommentAdf` to use `jsonHeaders(config)` (same headers, no behavior change).

- [ ] **Step 4: Run the engine tests**

Run: `pnpm vitest run tests/engine/jira.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing command test**

```ts
// tests/cli/jira-create-issue.test.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { jiraCreateIssueCommand } from '@/cli/commands/jira-create-issue'

const vars = { JIRA_USERNAME: 'a@b.c', JIRA_API_TOKEN: 't', JIRA_URL: 'https://x.atlassian.net' }
const UUID = '0f8b4e2a-1c3d-4f5a-9b7e-2d6c8a1f3b5d'

function stubJira(overrides: { issueTypes?: string[]; linkTypes?: string[] } = {}) {
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit = {}) => {
            calls.push({
                url,
                method: init.method ?? 'GET',
                body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
            })
            if (url.includes('/createmeta/')) {
                return new Response(
                    JSON.stringify({ issueTypes: (overrides.issueTypes ?? ['Task', 'Bug']).map(name => ({ name })) }),
                    { status: 200 }
                )
            }
            if (url.endsWith('/issueLinkType')) {
                return new Response(
                    JSON.stringify({ issueLinkTypes: (overrides.linkTypes ?? ['Relates']).map(name => ({ name })) }),
                    { status: 200 }
                )
            }
            if (url.endsWith('/rest/api/3/issue') && init.method === 'POST') {
                return new Response(JSON.stringify({ id: '1', key: 'OTTER-901' }), { status: 201 })
            }
            if (url.includes('/attachments')) return new Response(JSON.stringify([{ id: '55' }]), { status: 200 })
            if (url.includes('/attachment/content/')) {
                return new Response('', { status: 303, headers: { location: `https://m/file/${UUID}/binary` } })
            }
            return new Response('', { status: 204 })
        })
    )
    return calls
}

function tmpBody(): { dir: string; body: string; image: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-ci-'))
    const body = path.join(dir, 'card.md')
    const image = path.join(dir, 'shot.png')
    fs.writeFileSync(body, '## Expected\nx\n\n{{image:1}}')
    fs.writeFileSync(image, Buffer.from([0x89, 0x50]))
    return { dir, body, image }
}

describe('jira-create-issue', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('verifies types, creates, uploads, describes, links, and prints the key', async () => {
        const calls = stubJira()
        const { dir, body, image } = tmpBody()
        const out: string[] = []
        vi.spyOn(process.stdout, 'write').mockImplementation(s => (out.push(String(s)), true))
        await jiraCreateIssueCommand(
            { project: 'OTTER', summary: 'Pending state missing', 'body-file': body, images: image, link: 'OTTER-617' },
            vars
        )
        expect(JSON.parse(out.at(-1) as string)).toEqual({
            key: 'OTTER-901',
            url: 'https://x.atlassian.net/browse/OTTER-901',
        })
        const methods = calls.map(c => `${c.method} ${c.url.replace('https://x.atlassian.net', '')}`)
        expect(methods).toEqual([
            'GET /rest/api/3/issue/createmeta/OTTER/issuetypes',
            'GET /rest/api/3/issueLinkType',
            'POST /rest/api/3/issue',
            'POST /rest/api/3/issue/OTTER-901/attachments',
            'GET /rest/api/3/attachment/content/55',
            'PUT /rest/api/3/issue/OTTER-901',
            'POST /rest/api/3/issueLink',
        ])
        expect(calls[6].body).toEqual({
            type: { name: 'Relates' },
            inwardIssue: { key: 'OTTER-901' },
            outwardIssue: { key: 'OTTER-617' },
        })
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('stops before POST /issue when the issue type is unknown, listing the valid names', async () => {
        const calls = stubJira({ issueTypes: ['Task', 'Story'] })
        const { dir, body } = tmpBody()
        await expect(
            jiraCreateIssueCommand({ project: 'OTTER', summary: 's', 'body-file': body }, vars)
        ).rejects.toThrow(/Bug.*Task, Story/)
        expect(calls.some(c => c.method === 'POST')).toBe(false)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('stops when the link type is unknown', async () => {
        const calls = stubJira({ linkTypes: ['Blocks'] })
        const { dir, body } = tmpBody()
        await expect(
            jiraCreateIssueCommand({ project: 'OTTER', summary: 's', 'body-file': body, link: 'OTTER-617' }, vars)
        ).rejects.toThrow(/Relates.*Blocks/)
        expect(calls.some(c => c.method === 'POST')).toBe(false)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('names the created key when a later step fails', async () => {
        stubJira()
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string, init: RequestInit = {}) => {
                if (url.includes('/createmeta/')) return new Response(JSON.stringify({ issueTypes: [{ name: 'Bug' }] }), { status: 200 })
                if (url.endsWith('/rest/api/3/issue') && init.method === 'POST') return new Response(JSON.stringify({ id: '1', key: 'OTTER-902' }), { status: 201 })
                return new Response('boom', { status: 500 })
            })
        )
        const { dir, body } = tmpBody()
        await expect(
            jiraCreateIssueCommand({ project: 'OTTER', summary: 's', 'body-file': body }, vars)
        ).rejects.toThrow(/OTTER-902.*description/)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('requires --project, --summary and --body-file', async () => {
        await expect(jiraCreateIssueCommand({}, vars)).rejects.toThrow('--project')
    })
})
```

- [ ] **Step 6: Implement the command**

```ts
// src/cli/commands/jira-create-issue.ts
import fs from 'node:fs'
import { splitBodyIntoSegments } from '@/cli/commands/jira'
import {
    buildCommentAdf,
    createIssue,
    issueTypeNames,
    jiraConfig,
    linkIssues,
    linkTypeNames,
    resolveMediaId,
    updateDescriptionAdf,
    uploadAttachment,
} from '@/engine/jira'
import type { Vars } from '@/engine/settings'

const DEFAULT_TYPE = 'Bug'
const DEFAULT_LINK_TYPE = 'Relates'

function required(opts: Record<string, string>, name: string): string {
    const value = (opts[name] ?? '').trim()
    if (!value) throw new Error(`jira-create-issue requires --${name}`)
    return value
}

function splitList(value: string | undefined): string[] {
    return (value ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

// `qar jira-create-issue --project <KEY> --summary <text> --body-file <path.md>
//     [--type Bug] [--images a.png,b.png] [--link <PARENT>] [--link-type Relates]`
//
// A validation follow-up card. The MCP's jira_create_issue stores markdown as literal
// text, can't embed screenshots, and can't link issues — the three things the PM asked
// for — so this reuses the comment pipeline (upload → media id → ADF) on a new issue.
// Both type names are checked first: a bad name is a Jira 400 that names nothing.
export async function jiraCreateIssueCommand(
    opts: Record<string, string>,
    vars: Vars
): Promise<void> {
    const project = required(opts, 'project')
    const summary = required(opts, 'summary')
    const bodyFile = required(opts, 'body-file')
    const body = fs.readFileSync(bodyFile, 'utf8')
    const type = opts.type || DEFAULT_TYPE
    const link = (opts.link ?? '').trim()
    const linkType = opts['link-type'] || DEFAULT_LINK_TYPE
    const images = splitList(opts.images)
    for (const image of images) {
        if (!fs.existsSync(image)) throw new Error(`Image not found: ${image}`)
    }

    const config = jiraConfig(vars)
    const types = await issueTypeNames(config, project)
    if (!types.includes(type)) {
        throw new Error(`Issue type "${type}" is not available in ${project}. Valid: ${types.join(', ')}`)
    }
    if (link) {
        const linkTypes = await linkTypeNames(config)
        if (!linkTypes.includes(linkType)) {
            throw new Error(`Link type "${linkType}" does not exist. Valid: ${linkTypes.join(', ')}`)
        }
    }

    const created = await createIssue(config, { project, type, summary })
    const step = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
        try {
            return await run()
        } catch (cause) {
            const reason = cause instanceof Error ? cause.message : String(cause)
            throw new Error(`Created ${created.key}, but ${what} failed: ${reason}`, { cause })
        }
    }

    const mediaIds: string[] = []
    for (const image of images) {
        const attachmentId = await step('uploading an image', () => uploadAttachment(config, created.key, image))
        mediaIds.push(await step('resolving an image id', () => resolveMediaId(config, attachmentId)))
    }
    const adf = buildCommentAdf(splitBodyIntoSegments(body, mediaIds))
    await step('setting the description', () => updateDescriptionAdf(config, created.key, adf))
    if (link) {
        await step(`linking to ${link}`, () =>
            linkIssues(config, { type: linkType, inward: created.key, outward: link })
        )
    }
    process.stdout.write(`${JSON.stringify({ key: created.key, url: `${config.baseUrl}/browse/${created.key}` })}\n`)
}
```

- [ ] **Step 7: Register the command**

`src/cli/help.ts`, after `jira-attachments`:

```ts
    {
        name: 'jira-create-issue',
        usage: 'qar jira-create-issue --project <KEY> --summary <text> --body-file <path.md> [--type Bug] [--images a.png,b.png] [--link <PARENT>] [--link-type Relates]',
        summary: 'Create a follow-up card with an ADF description, inline screenshots, and a link to its parent.',
        details:
            'Checks the issue type and link type exist before creating anything. Body is ' +
            'Markdown with {{image:N}} placeholders, like jira-comment. Prints {"key","url"}.',
    },
```

`bin/qar.ts`: `case 'jira-create-issue': return jiraCreateIssueCommand(opts, await loadSettings())` with `import { jiraCreateIssueCommand } from '@/cli/commands/jira-create-issue'`.

- [ ] **Step 8: Tests, typecheck, lint, commit**

Run: `pnpm test && pnpm typecheck && pnpm lint:fix && pnpm lint`

```bash
git add src/engine/jira.ts src/cli/commands/jira-create-issue.ts src/cli/help.ts bin/qar.ts tests/engine/jira.test.ts tests/cli/jira-create-issue.test.ts
git commit -m "Add qar jira-create-issue for linked follow-up cards"
```

---

### Task 6: `recommendFollowUp` and `qar followup-advice`

**Files:**
- Create: `src/engine/followup.ts`, `src/cli/commands/followup-advice.ts`
- Modify: `src/cli/help.ts`, `bin/qar.ts`
- Test: `tests/engine/followup.test.ts`, `tests/cli/followup-advice.test.ts`

**Interfaces:**
- Produces:
  - `type Severity = 'blocker' | 'major' | 'minor'`
  - `interface Fail { id: string; severity: Severity; area: string }`
  - `type FollowUpOption = 'send-back' | 'one-card' | 'multiple-cards'`
  - `recommendFollowUp(fails: Fail[]): { option: FollowUpOption; reason: string }` — throws on an empty list.
  - `qar followup-advice --input <path.json>` where the file is `{ "fails": Fail[] }`; prints the recommendation as JSON.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/engine/followup.test.ts
import { describe, expect, it } from 'vitest'
import { recommendFollowUp } from '@/engine/followup'

describe('recommendFollowUp', () => {
    it('sends back when any FAIL is a blocker', () => {
        const r = recommendFollowUp([
            { id: 'a', severity: 'minor', area: 'copy' },
            { id: 'b', severity: 'blocker', area: 'sorting' },
        ])
        expect(r.option).toBe('send-back')
        expect(r.reason).toMatch(/1 blocker/)
    })

    it('recommends one card for a few non-blocking FAILs', () => {
        const r = recommendFollowUp([
            { id: 'a', severity: 'minor', area: 'copy' },
            { id: 'b', severity: 'major', area: 'error state' },
        ])
        expect(r.option).toBe('one-card')
    })

    it('recommends one card when every FAIL is in the same area', () => {
        const fails = ['a', 'b', 'c', 'd'].map(id => ({ id, severity: 'major' as const, area: 'table layout' }))
        expect(recommendFollowUp(fails).option).toBe('one-card')
    })

    it('recommends multiple cards for several independent FAILs', () => {
        const r = recommendFollowUp([
            { id: '3', severity: 'major', area: 'overflow' },
            { id: '4', severity: 'major', area: 'error state' },
            { id: '5', severity: 'major', area: 'pending state' },
            { id: '7', severity: 'major', area: 'last updated' },
            { id: '8', severity: 'minor', area: 'link component' },
        ])
        expect(r.option).toBe('multiple-cards')
        expect(r.reason).toMatch(/5 FAILs.*4 areas|5 FAILs.*5 areas/)
    })

    it('rejects an empty list', () => {
        expect(() => recommendFollowUp([])).toThrow('no FAILs')
    })
})
```

```ts
// tests/cli/followup-advice.test.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { followupAdviceCommand } from '@/cli/commands/followup-advice'

describe('followup-advice', () => {
    it('reads {fails:[…]} from --input and prints the recommendation', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-fu-'))
        const input = path.join(dir, 'fails.json')
        fs.writeFileSync(input, JSON.stringify({ fails: [{ id: 'a', severity: 'blocker', area: 'x' }] }))
        const out: string[] = []
        vi.spyOn(process.stdout, 'write').mockImplementation(s => (out.push(String(s)), true))
        await followupAdviceCommand({ input })
        expect(JSON.parse(out[0]).option).toBe('send-back')
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('requires --input', async () => {
        await expect(followupAdviceCommand({})).rejects.toThrow('--input')
    })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/engine/followup.test.ts tests/cli/followup-advice.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// src/engine/followup.ts
export type Severity = 'blocker' | 'major' | 'minor'

export interface Fail {
    id: string
    severity: Severity
    area: string
}

export type FollowUpOption = 'send-back' | 'one-card' | 'multiple-cards'

const FEW = 3

// Where validation failures go is the user's call; this is the suggestion. The rule
// lives here, not in the skill text, so it is the same on every run and testable:
// a blocker means the card is not done; otherwise a handful of related fixes make
// one card and independent ones make several (what the PM asked for on OTTER-617).
export function recommendFollowUp(fails: Fail[]): { option: FollowUpOption; reason: string } {
    if (!fails.length) throw new Error('recommendFollowUp: no FAILs to route')
    const blockers = fails.filter(f => f.severity === 'blocker').length
    if (blockers) {
        return {
            option: 'send-back',
            reason: `${blockers} blocker${blockers === 1 ? '' : 's'} among ${fails.length} FAILs — the card is not done.`,
        }
    }
    const areas = new Set(fails.map(f => f.area.trim().toLowerCase())).size
    if (fails.length <= FEW || areas === 1) {
        return {
            option: 'one-card',
            reason: `${fails.length} FAILs in ${areas} area${areas === 1 ? '' : 's'}, no blockers — one card covers them.`,
        }
    }
    return {
        option: 'multiple-cards',
        reason: `${fails.length} FAILs across ${areas} areas, no blockers — each can be fixed separately.`,
    }
}
```

```ts
// src/cli/commands/followup-advice.ts
import fs from 'node:fs'
import { type Fail, recommendFollowUp } from '@/engine/followup'

// `qar followup-advice --input <path.json>` — the skill writes its FAILs with a
// severity and an area, and asks this for the routing suggestion.
export async function followupAdviceCommand(opts: Record<string, string>): Promise<void> {
    const input = (opts.input ?? '').trim()
    if (!input) throw new Error('followup-advice requires --input <path.json>')
    const parsed = JSON.parse(fs.readFileSync(input, 'utf8')) as { fails?: Fail[] }
    const result = recommendFollowUp(parsed.fails ?? [])
    process.stdout.write(`${JSON.stringify(result)}\n`)
}
```

`src/cli/help.ts`, after `verdict-posted`:

```ts
    {
        name: 'followup-advice',
        usage: 'qar followup-advice --input <path.json>',
        summary: 'Recommend how to route validation FAILs: send back, one card, or multiple cards.',
        details:
            'Input is {"fails":[{"id","severity":"blocker|major|minor","area"}]}. Any blocker → ' +
            'send-back; ≤3 FAILs or one area → one-card; otherwise multiple-cards.',
    },
```

`bin/qar.ts`: `case 'followup-advice': return followupAdviceCommand(opts)` with its import.

- [ ] **Step 4: Tests, typecheck, lint, commit**

Run: `pnpm test && pnpm typecheck && pnpm lint:fix && pnpm lint`

```bash
git add src/engine/followup.ts src/cli/commands/followup-advice.ts src/cli/help.ts bin/qar.ts tests/engine/followup.test.ts tests/cli/followup-advice.test.ts
git commit -m "Add followup-advice: route validation FAILs by severity and spread"
```

---

### Task 7: "Figma seat" Doctor row (Go)

**Files:**
- Modify: `gui/app.go` (after `figmaMcpCheck`; wiring in `RunDoctor`)
- Modify: `gui/paths.go` (cache path helper next to `repoLocationFile`)
- Test: `gui/app_test.go`

**Interfaces:**
- Produces:
  - `const figmaPlanName = "SafeInsights"`
  - `func figmaSeatCheck(out string, err error) DoctorCheck`
  - `func findWhoami(out string) (whoamiPayload, bool)` — scans `claude -p … --output-format stream-json` lines for any string field that parses as `{"whoami":{…}}`.
  - `func loadSeatCache(path string, now time.Time) (string, time.Time, bool)` / `func saveSeatCache(path, out string, now time.Time) error` — `{ "out": "...", "checkedAt": RFC3339 }`, valid 24 h.
  - `func figmaSeatCachePath() string` in `paths.go`.

- [ ] **Step 1: Write the failing tests**

Append to `gui/app_test.go`:

```go
// The seat row proves the signed-in Figma account can actually use the MCP: View
// and Collab seats are capped at 6 calls a month, which reads as "Figma is broken"
// from inside a session. It parses the whoami tool result out of a stream-json run.
func TestFigmaSeatCheck(t *testing.T) {
	whoami := func(plans string) string {
		payload := `{"whoami":{"handle":"N","email":"n@rice.edu","plans":[` + plans + `]}}`
		esc, _ := json.Marshal(payload)
		return `{"type":"system","subtype":"init"}` + "\n" +
			`{"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"text","text":` + string(esc) + `}]}]}}` + "\n" +
			`{"type":"result","result":"done"}`
	}
	plan := func(name, seat string) string {
		return `{"name":"` + name + `","seat":"` + seat + `","role":"member"}`
	}
	for _, tc := range []struct {
		name, out, wantDetail, wantHint string
		err                             error
		wantOK                          bool
	}{
		{name: "full seat", out: whoami(plan("SafeInsights", "Full")), wantOK: true, wantDetail: "Full seat (n@rice.edu)"},
		{name: "dev seat", out: whoami(plan("SafeInsights", "Dev")), wantOK: true, wantDetail: "Dev seat"},
		{name: "view seat", out: whoami(plan("SafeInsights", "View")), wantOK: false, wantDetail: "View seat", wantHint: "6 Figma MCP calls"},
		{name: "collab seat", out: whoami(plan("SafeInsights", "Collab")), wantOK: false, wantDetail: "Collab seat", wantHint: "Dev seat"},
		{name: "best of two entries wins", out: whoami(plan("SafeInsights", "View") + "," + plan("SafeInsights", "Dev")), wantOK: true, wantDetail: "Dev seat"},
		{name: "other plans only", out: whoami(plan("OpenStax", "Full")), wantOK: false, wantDetail: "n@rice.edu", wantHint: "/mcp"},
		{name: "no tool result", out: `{"type":"result","result":"I cannot"}`, wantOK: false, wantDetail: "no whoami result"},
		{name: "bad json", out: "not json at all", wantOK: false, wantDetail: "no whoami result"},
		{name: "claude failed", out: "boom", err: errors.New("exit 1"), wantOK: false, wantDetail: "boom"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := figmaSeatCheck(tc.out, tc.err)
			if got.OK != tc.wantOK {
				t.Fatalf("OK = %v, want %v (detail %q)", got.OK, tc.wantOK, got.Detail)
			}
			if !strings.Contains(got.Detail, tc.wantDetail) {
				t.Errorf("Detail %q does not contain %q", got.Detail, tc.wantDetail)
			}
			if tc.wantHint != "" && !strings.Contains(got.Hint, tc.wantHint) {
				t.Errorf("Hint %q does not contain %q", got.Hint, tc.wantHint)
			}
		})
	}
}

func TestSeatCache(t *testing.T) {
	path := filepath.Join(t.TempDir(), "figma-seat.json")
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	if _, _, ok := loadSeatCache(path, now); ok {
		t.Fatal("missing file should not load")
	}
	if err := saveSeatCache(path, "probe-output", now); err != nil {
		t.Fatal(err)
	}
	out, at, ok := loadSeatCache(path, now.Add(23*time.Hour))
	if !ok || out != "probe-output" || !at.Equal(now) {
		t.Fatalf("fresh entry: ok=%v out=%q at=%v", ok, out, at)
	}
	if _, _, ok := loadSeatCache(path, now.Add(25*time.Hour)); ok {
		t.Fatal("entry older than 24h should be ignored")
	}
}
```

Add `"encoding/json"`, `"errors"`, `"path/filepath"`, `"time"` to the test file's imports if absent.

- [ ] **Step 2: Run to verify failure**

Run: `cd gui && go test ./... -run 'TestFigmaSeatCheck|TestSeatCache'`
Expected: compile error — undefined `figmaSeatCheck`.

- [ ] **Step 3: Implement**

`gui/paths.go`, after `repoLocationFile`:

```go
// figmaSeatCachePath holds the last successful `whoami` probe. The Doctor runs on
// every launch and the probe costs a claude -p round trip, so it is reused for a day.
func figmaSeatCachePath() string {
	return filepath.Join(appSupportDir(), "figma-seat.json")
}
```

`gui/app.go`, after `figmaMcpCheck`:

```go
// figmaPlanName is the Figma plan that owns the SI design files. A seat on any
// OTHER plan says nothing about whether those files can be read.
const figmaPlanName = "SafeInsights"

const seatCacheTTL = 24 * time.Hour

type whoamiPlan struct {
	Name string `json:"name"`
	Seat string `json:"seat"`
}

type whoamiPayload struct {
	Whoami struct {
		Email string       `json:"email"`
		Plans []whoamiPlan `json:"plans"`
	} `json:"whoami"`
}

// findWhoami digs the whoami tool result out of `claude -p --output-format
// stream-json` output. The payload arrives as a JSON string INSIDE a tool_result
// block, so every string value in every line is tried as a document with a
// top-level "whoami" key — that is more robust than pinning the stream's exact shape.
func findWhoami(out string) (whoamiPayload, bool) {
	for _, ln := range strings.Split(out, "\n") {
		var any interface{}
		if err := json.Unmarshal([]byte(strings.TrimSpace(ln)), &any); err != nil {
			continue
		}
		if p, ok := whoamiInValue(any); ok {
			return p, true
		}
	}
	return whoamiPayload{}, false
}

func whoamiInValue(v interface{}) (whoamiPayload, bool) {
	switch t := v.(type) {
	case string:
		var p whoamiPayload
		if err := json.Unmarshal([]byte(t), &p); err == nil && (p.Whoami.Email != "" || len(p.Whoami.Plans) > 0) {
			return p, true
		}
	case map[string]interface{}:
		for _, child := range t {
			if p, ok := whoamiInValue(child); ok {
				return p, true
			}
		}
	case []interface{}:
		for _, child := range t {
			if p, ok := whoamiInValue(child); ok {
				return p, true
			}
		}
	}
	return whoamiPayload{}, false
}

// seatRank orders seats by what the MCP lets them do: a guest + member pair on the
// same plan reports twice, and the BEST seat is the one that applies.
func seatRank(seat string) int {
	switch strings.ToLower(seat) {
	case "full":
		return 3
	case "dev":
		return 2
	case "collab":
		return 1
	case "view":
		return 0
	}
	return -1
}

func figmaSeatCheck(out string, err error) DoctorCheck {
	const name = "Figma seat"
	const docURL = "https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/"
	if err != nil {
		return DoctorCheck{Name: name, OK: false, Detail: "`claude -p` whoami probe failed: " + firstLines(out, 3),
			Hint: "Start a `claude` session and run `/mcp` to check the figma server, then re-run the doctor."}
	}
	payload, ok := findWhoami(out)
	if !ok {
		return DoctorCheck{Name: name, OK: false, Detail: "no whoami result in probe output: " + firstLines(out, 2),
			Hint: "Start a `claude` session and run `/mcp` to reconnect the figma server.", DocURL: docURL}
	}
	best := ""
	for _, p := range payload.Whoami.Plans {
		if p.Name == figmaPlanName && seatRank(p.Seat) > seatRank(best) {
			best = p.Seat
		}
	}
	email := payload.Whoami.Email
	if best == "" {
		return DoctorCheck{Name: name, OK: false,
			Detail: "signed in as " + email + ", which has no seat on the " + figmaPlanName + " plan",
			Hint:   "Sign in to Figma with your " + figmaPlanName + " account, then run `/mcp` in a claude session to re-authenticate.",
			DocURL: docURL}
	}
	detail := figmaPlanName + " — " + best + " seat (" + email + ")"
	if seatRank(best) >= seatRank("dev") {
		return DoctorCheck{Name: name, OK: true, Detail: detail}
	}
	return DoctorCheck{Name: name, OK: false, Detail: detail,
		Hint:   "View and Collab seats get 6 Figma MCP calls per month — not enough to read a design. Ask a " + figmaPlanName + " Figma admin for a Dev seat.",
		DocURL: docURL}
}

type seatCache struct {
	Out       string    `json:"out"`
	CheckedAt time.Time `json:"checkedAt"`
}

func loadSeatCache(path string, now time.Time) (string, time.Time, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", time.Time{}, false
	}
	var c seatCache
	if err := json.Unmarshal(data, &c); err != nil || c.Out == "" {
		return "", time.Time{}, false
	}
	if now.Sub(c.CheckedAt) > seatCacheTTL || c.CheckedAt.After(now) {
		return "", time.Time{}, false
	}
	return c.Out, c.CheckedAt, true
}

func saveSeatCache(path, out string, now time.Time) error {
	data, err := json.Marshal(seatCache{Out: out, CheckedAt: now})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

// figmaSeatRow runs the (cached) whoami probe. Only a successful probe is cached:
// caching a failure would hide a fix for a day.
func figmaSeatRow() DoctorCheck {
	now := time.Now()
	if out, at, ok := loadSeatCache(figmaSeatCachePath(), now); ok {
		check := figmaSeatCheck(out, nil)
		check.Detail += " — checked " + at.Local().Format("Jan 2 15:04")
		return check
	}
	out, err := runToolFull("claude", "-p", "Call the whoami tool and stop.",
		"--allowedTools", "mcp__plugin_figma_figma__whoami",
		"--output-format", "stream-json", "--verbose")
	check := figmaSeatCheck(out, err)
	if check.OK {
		if saveErr := saveSeatCache(figmaSeatCachePath(), out, now); saveErr != nil {
			logDiag("tool", "figma seat cache write failed: %v", saveErr)
		}
	}
	return check
}
```

In `RunDoctor`, replace the figma block with:

```go
	if toolOnPath("claude") {
		out, err := runToolFull("claude", "mcp", "list")
		mcp := figmaMcpCheck(out, err)
		checks = append(checks, mcp)
		// The seat probe needs a connected figma server; skip it (rather than add a
		// second red row with the same cause) when the MCP row already failed.
		if mcp.OK {
			checks = append(checks, figmaSeatRow())
		}
	}
```

Add `"time"` to `gui/app.go` imports if absent (`encoding/json`, `os`, `path/filepath` are already used there — verify with `go build`).

- [ ] **Step 4: Run the Go tests**

Run: `cd gui && go test ./...`
Expected: PASS.

- [ ] **Step 5: Smoke the probe once by hand**

Run (outside the sandbox — it calls `claude`):
```bash
claude -p "Call the whoami tool and stop." --allowedTools mcp__plugin_figma_figma__whoami --output-format stream-json --verbose | grep -c whoami
```
Expected: ≥ 1. If 0, open the output and adjust `findWhoami` to the real shape — then add that shape to `TestFigmaSeatCheck` as a fixture.

- [ ] **Step 6: Commit**

```bash
git add gui/app.go gui/paths.go gui/app_test.go
git commit -m "Add a cached Figma seat row to the Setup Doctor"
```

---

### Task 8: Skill, prompts and CLAUDE.md

**Files:**
- Modify: `.claude/skills/qa-validate/SKILL.md`
- Modify: `gui/prompts/validation.md`, `gui/prompts/validation-by-pr.md`
- Modify: `CLAUDE.md`
- Modify: `gui/app.go` `validationAllowedTools` (no change needed — verify `mcp__plugin_figma_figma` is still there)

No automated test covers prose; `tests/suites/step-names.test.ts` and the GUI prompt tests must still pass (`prompts.go` trims a trailing newline and substitutes `{{target}}`/`{{jiraCard}}`/`{{pr}}` — keep those placeholders).

- [ ] **Step 1: Replace "What to do" in SKILL.md**

Replace the whole `## What to do` section (steps 1–7) with:

```markdown
## What to do — five phases

### Phase 1: Inventory (before login, before any test)
Build `.tmp/<CARD>-inventory.md`: ONE line per requirement, each with an id, the
text, and its source. Nothing is tested until the user approves this list.

1. **Card.** `jira_get_issue(issue_key=…, include='remote_links,comments', fields='*all')`.
   Every sub-requirement in the description is its own line — not one line per
   heading. Ids follow the card's structure (`RL.SubmittedBy.3`). OTTER-617 yields
   about 60 lines; if you have 10, you have summarised, not inventoried.
2. **Comments.** A decision in a comment changes or adds a line; the line names
   its source ("Iris 10/12: Last updated sorts both ways"). The newest decision wins.
3. **Attachments.** `qar jira-attachments --issue <CARD> --download` saves the text
   ones (a developer's test plan, a CSV of cases) under `.tmp/<CARD>-attachments/`.
   Read each; they add lines. Images are listed only.
4. **Figma.** See "Reading Figma annotations" below. Every annotation on every page
   that holds a linked node becomes a line, sorted by category.
5. **Conflicts.** When a card line and a Figma line disagree, merge them into ONE
   line marked CONFLICT. The app is checked against the card text.
6. Show the user a summary — line count, conflicts, absence checks, sources — and
   wait for approval. This replaces "state the acceptance criteria and plan".

### Phase 2: Test
Infer the role from the inventory (ask if unclear). `qar session-login --role <role>`.
Drive every line with the chrome-devtools MCP. Before you give up on a line, try the
standard methods: timezone/locale and network throttle (`emulate`), viewport
(`resize_page`), a forced request failure (`evaluate_script` wrapping `fetch`),
`qar study-state`, `qar session-create-study`, `qar session-create-user`.

### Phase 3: Classify
Each line gets exactly one result:

| Result | When | Effect |
|---|---|---|
| PASS | The app does what the line says | — |
| FAIL | The app does not, and card and Figma agree | REJECTED or follow-up cards (Phase 5) |
| CONFLICT | Card and Figma disagree | PM question; the app is checked against the card |
| UNCLEAR | The line can be read two ways | PM question; never PASS |
| NOT TESTED | You could not build the state, AND the user approved | — |

- A CONFLICT line is never also a FAIL.
- A line with no effect a user can see ("sorting is server-side") goes under
  "Also observed", not FAIL.
- **NOT TESTED needs the user's approval, per line, and should almost never
  happen.** Stop and ask, giving the line, the methods you tried, and ONE reason
  from: needs a real enclave run `study-state` cannot fake; needs a forbidden
  action (modify an existing user, rotate a key on a shared env); needs an
  external system (real email, a third party); needs time to pass; the code is
  not on the target. "Too much effort" is not a reason. The posted line reads
  `— NOT TESTED (confirmed by <user>)`. While any line is unresolved, no verdict.

### Phase 4: Report
Post with `qar jira-comment` using the template under "Posting findings". Write
for a PM with two minutes: the verdict, the counts, and their questions come
first; PASS rows are collapsed.

### Phase 5: Route the failures
Skip when there is no FAIL. Otherwise give each FAIL a severity — **blocker** (a
card-text criterion broken, wrong data, a user cannot finish the flow), **major**
(a state or behaviour a Figma annotation specifies is missing), **minor** (copy,
visual, component) — and an **area** (a short label; FAILs that one fix would
cover share an area). Write them to `.tmp/<CARD>-fails.json` as
`{"fails":[{"id","severity","area"}]}` and run
`qar followup-advice --input .tmp/<CARD>-fails.json`. Present the three options
with the returned recommendation and its reason, and let the user choose:

- **Comment and send back to dev** — `## REJECTED ❌`; transition to "To Do";
  assign the last person who worked the card (see "Transition the ticket").
- **One follow-up card** / **Multiple follow-up cards** — draft each card to
  `.tmp/<CARD>-followup-N.md` (summary; expected, quoting the source; observed;
  steps; screenshots). Show the drafts; the user approves or edits. Then, per
  approved draft:
  `qar jira-create-issue --project <CARD's project> --summary "<text>" --body-file .tmp/<CARD>-followup-N.md --images a.png,b.png --link <CARD>`
  (`--type` defaults to Bug, `--link-type` to Relates; both are verified first).
  The parent comment's heading is `## VALIDATED WITH FOLLOW-UPS ✅` and lists the
  new keys; the parent then moves as VALIDATED, and `qar verdict-posted` gets
  `--result validated`.

CONFLICT and UNCLEAR lines never become cards — they stay as questions.
On a PR preview: no Jira writes at all, so no cards (show the drafts instead).
```

- [ ] **Step 2: Replace "Checking the implementation against linked Figma designs"**

Replace that whole section (through its "Judgment" paragraph) with:

```markdown
## Reading Figma annotations

The design's rules live in **Dev Mode annotations** — per-column widths, reset
rules, states, "not ready for engineering" markers. `get_screenshot`,
`get_metadata` and `get_variable_defs` do NOT return them, and neither does the
REST API; only the Plugin API does. So annotations are read with
`mcp__plugin_figma_figma__use_figma` running ONE fixed, read-only script:
**`.claude/skills/qa-validate/figma-notes.js`**. A hook denies any `use_figma`
call whose code differs from that file in anything but its first two lines, so
there is no way to edit a design from this session — do not try to write your
own Plugin API code; it will be refused.

Before any Figma call, run `mcp__plugin_figma_figma__whoami`. If the SafeInsights
plan seat is View or Collab, stop and tell the user (those seats get 6 MCP calls a
month); do not read Figma.

### 1. Find the links
Figma links reach a ticket three ways: **remote links** (what the Figma–Jira
integration creates — invisible unless you ask with
`include='remote_links,comments'`), the **description**, and **comments** (often
a later revision; the newest wins — say which you used). A design URL is
`https://figma.com/design/<fileKey>/<name>?node-id=<a>-<b>`; the node id is
`<a>:<b>`. Skip `/make/`, `/board/` and `/slides/` URLs.

### 2. Read, with the fixed script
Send the file's contents as `code` with only the header lines changed:

1. `const MODE = 'pages'` / `const TARGET = ''` — every page in the file.
2. `const MODE = 'locate'` / `const TARGET = '<id1>,<id2>,…'` — ONE call for all
   linked node ids → each node's page.
3. `const MODE = 'page'` / `const TARGET = '<pageId>'` — one call per page that
   holds a linked node → every top-level frame and every annotation on that page
   (frame, layer path, category, text).

A link with no `node-id` is not a dead end: run `pages`, show the page names, and
ask the user which page to read. **Every frame on a read page is in scope**, not
just the linked ones — loading and error frames sit beside the linked frames and
their notes apply to the same table. Pause briefly between Figma calls.

### 3. Sort each annotation by category

| Category | Treatment |
|---|---|
| Development, Interaction, Accessibility, Design notes, Visual Inconsistencies, Notes for QA | An inventory line |
| NOT READY, NOT READY FOR DEV, NOT OTTER, JUST FOR MOCKUP | An **absence check**: the feature must NOT be in the app |
| IRIS NOTES, Concept Notes, DONE!, Transition, Transition - IN, Transition - OUT | Context only; not tested |
| anything else | Ask the user |

No category = Development. The same annotation shows up once per component
instance (the RL and DP tables share one); merge identical text into one line
that lists each frame. Every Figma line records page, frame and category, and
links the node: `https://figma.com/design/<fileKey>?node-id=<a>-<b>`.

### 4. Compare at the right altitude
Match the browser to the design's conditions first — viewport (`resize_page`),
state, role. Then check structure and presence, copy (quoted exactly), states
(drive the app into each one the notes describe), and visual detail backed by
numbers (`get_variable_defs`, `getComputedStyle`), not eyeballing. Do not report
sub-pixel differences, font rendering, scrollbar width, or placeholder content.
`get_screenshot` (pass `enableBase64Response: true`; figma.com is not in the
sandbox allowlist) and `get_metadata` remain useful for layout; never use
`get_design_context`.
```

- [ ] **Step 3: Replace the comment template in "Posting findings"**

Replace the fenced template and its "Rules for filling it in" list with:

````markdown
   ```markdown
   ## REJECTED ❌
   <!-- or: VALIDATED ✅  /  VALIDATED WITH FOLLOW-UPS ✅ -->
   **<env>** · release `<sha>` · PR [#<n>](<url>) · <roles>
   **<N> requirements:** <a> PASS · <b> FAIL · <c> CONFLICT · <d> UNCLEAR · <e> NOT TESTED
   Sources: card, <k> comments, <m> attachments, <j> Figma annotations on <p> pages
   → <c+d> decisions needed from {{mention}} (below). Follow-up cards: <keys or none>.

   ### Decisions needed from PM
   <!-- Omit the section AND --mention when there are no CONFLICT/UNCLEAR lines. -->
   **1. <line id> — CONFLICT.** Card: *"<quote>"*. Figma (<page> / <frame>, <category>): *"<quote>"*.
   App today: <what it does>. **A** keep the card's behaviour · **B** follow Figma.
   **2. <line id> — UNCLEAR.** *"<quote>"* can mean <A> or <B>. App today: <…>. **A** / **B**.

   ### Failed
   **<line id> — FAIL (<severity>).** Expected (<source>): *"<quote>"*. Observed: <evidence>.
   {{image:1}}

   ### Not tested
   **<line id> — NOT TESTED (confirmed by <user>).** <reason>.

   {expand:Passed (<a>)}
   **<card section>**
   - <line id> — *"<quote>"*: <evidence>
   {expand}

   ### Also observed
   <true but outside the lines, explicitly not a failure. Omit when empty.>

   **Setup:** <state built: studies created, decisions submitted — and that they were deleted.>
   ```

   Rules:
   - The first five lines are the whole status for a busy PM; keep them to five.
   - Pass `--mention <reporter accountId>` (from `jira_get_issue` → `reporter.account_id`)
     ONLY when "Decisions needed" is non-empty, so the PM is notified exactly when
     they have something to answer.
   - **Evidence, not assertion**: quoted strings, measured pixels, state transitions.
   - Every inventory line appears exactly once, under one heading. Never drop one.
   - Any FAIL makes the heading REJECTED — unless the user chose follow-up cards,
     in which case it is VALIDATED WITH FOLLOW-UPS and the keys are listed.
   - Each Figma-sourced line names page, frame and category with a node link.
   - Omit a section (and the expand block) when it has nothing in it.
````

- [ ] **Step 4: Update "Rules" and the environment list**

In `## The environment you're in`, change the Figma bullet to:

```markdown
- The **`plugin:figma:figma` MCP tools** are available. Annotations are read with
  `use_figma` running ONLY the fixed script `figma-notes.js` (a hook enforces it);
  `get_screenshot`/`get_metadata`/`get_variable_defs` stay available for layout —
  see "Reading Figma annotations" below.
```

In `## Rules`, replace the Figma bullet with:

```markdown
- Read Figma annotations only through `figma-notes.js` via `use_figma`; never send
  other Plugin API code (the hook denies it). Every annotation on a read page is an
  inventory line with page/frame/category and a node link.
- CONFLICT and UNCLEAR are PM questions, never PASS or FAIL. NOT TESTED needs the
  user's per-line approval and is very rare.
```

- [ ] **Step 5: Update the prompts**

`gui/prompts/validation.md` — replace the sentence `Infer the role that should be utilized and state the acceptance criteria and plan plainly.` with:

```
Build the requirement inventory first (card, comments, attachments via `qar jira-attachments`, and every Figma annotation via the fixed `figma-notes.js` script), write it to `.tmp/{{jiraCard}}-inventory.md`, show me the summary, and wait for my approval before logging in.
```

`gui/prompts/validation-by-pr.md` — after `read that ticket (jira-atlassian MCP) for its acceptance criteria,` insert `build the requirement inventory (card, comments, attachments, Figma annotations) and show me its summary for approval,`.

Keep each file as a single line with no trailing newline (prompts.go trims, but a mid-text newline would submit early).

- [ ] **Step 6: Add a CLAUDE.md section**

Insert after the "Posting Jira comments with inline screenshots" section:

```markdown
## Figma annotations are Plugin-API-only (and the validator may only READ)

Dev Mode annotations — where a design's per-column rules, states and "not ready
for engineering" markers live — are not returned by `get_screenshot`,
`get_metadata`, `get_variable_defs`, or the Figma REST API. Only the Plugin API
(`mcp__plugin_figma_figma__use_figma`) exposes `node.annotations`. OTTER-617 was
validated twice against rendered frames alone and missed seven annotated rules.

`use_figma` can also WRITE to a design file, and `gui/app.go` pre-approves the
whole figma server in validation sessions. So the only code a session may send is
`.claude/skills/qa-validate/figma-notes.js` (modes `pages` / `locate` / `page`),
and the `PreToolUse` hook `.claude/hooks/figma-readonly.mjs` (wired in
`.claude/settings.json`) denies any `use_figma` call whose code differs from that
file in anything but its `MODE`/`TARGET` header. `tests/skills/` pins both the
hook and the script's write-API-free body. The hook runs `"${QAR_NODE:-node}"`,
so the packaged app's node is used.

Reading needs a **Dev or Full seat on the SafeInsights plan**: View/Collab seats
get 6 MCP calls a month. The Setup Doctor's "Figma seat" row probes `whoami`
through `claude -p` and caches a successful answer for 24 h in
`~/Library/Application Support/qa-runner/figma-seat.json`; delete that file to
force a re-check.

Follow-up cards go through `qar jira-create-issue` (ADF description, inline
screenshots, a Relates link to the parent) — the MCP's `jira_create_issue` can do
none of those three. `qar followup-advice` is the routing rule (blocker → send
back; few/same-area → one card; else several), kept in code so it is testable.
```

Also add to "Useful commands": `pnpm qar jira-attachments --issue OTTER-617 --download`, `pnpm qar jira-create-issue …`, `pnpm qar followup-advice --input .tmp/OTTER-617-fails.json`.

- [ ] **Step 7: Lint, full test, Go test, commit**

Run: `pnpm lint:fix && pnpm lint && pnpm test && pnpm typecheck && (cd gui && go test ./...)`

```bash
git add .claude/skills/qa-validate/SKILL.md gui/prompts/validation.md gui/prompts/validation-by-pr.md CLAUDE.md
git commit -m "qa-validate: inventory, classify, PM-first report, follow-up cards"
```

---

### Task 9: Manual validation of OTTER-617

**Files:** none (verification only)

- [ ] **Step 1: Rebuild the GUI** so `prompts.go`'s embedded markdown and the Doctor row are current: `cd gui && wails build` (or run under `wails dev`).

- [ ] **Step 2: Setup Doctor** — confirm a green "Figma seat" row that reads `SafeInsights — Dev seat (…)`. Run it twice; the second shows `— checked <time>`.

- [ ] **Step 3: Start a Validation session** on QA for `OTTER-617`. Confirm:
  - The session calls `whoami`, then `use_figma` three or more times, all allowed.
  - Send a deliberate `use_figma` with other code from the session ("run `figma.root.children[0].name`") — it must be denied with the hook's reason.
  - The inventory summary reports ≥ 50 lines, 4 conflicts, ≥ 1 absence check (the "+ New study" button on the Researcher tab), and 33 Figma annotations from 2 pages.

- [ ] **Step 4: Approve and let it test.** Expected classification versus the 10/13 comment: issues 1 and 2 → CONFLICT; issue 6 → "Also observed"; issues 3, 4, 5, 7, 8 → FAIL; the intro-condition, empty-DP-intro and switcher-memory items → CONFLICT. No line NOT TESTED without the session asking first.

- [ ] **Step 5: Routing.** `followup-advice` must recommend `multiple-cards` (5 FAILs, no blockers, ≥ 4 areas). Choose it, review the drafts, and **stop before posting** unless the user says to post — the real card is live.

- [ ] **Step 6: Record the outcome** in the PR description: counts, deviations from the expected classification, and anything the skill text still gets wrong. Fix the skill text in the same PR if a deviation is a wording problem.
