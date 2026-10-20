// PreToolUse guard for use_figma, under ANY server name. The matcher in
// .claude/settings.json is `^mcp__.+__use_figma$`, not the plugin's tool name: the
// plugin, `claude mcp add … figma` and the claude.ai connector each expose it under
// a different prefix, and a matcher naming one leaves the guard off for the others.
//
// use_figma runs arbitrary Plugin API code and CAN edit the design file. The
// validator only ever needs to READ annotations, so the only code it may send is
// .claude/skills/qa-validate/figma-notes.js, with just its MODE/TARGET lines varied.
// Anything else is denied here — use_figma is deliberately NOT pre-approved in
// gui/app.go; this hook's explicit allow is what makes the fixed script prompt-free,
// and its deny is what keeps the session read-only.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../skills/qa-validate/figma-notes.js'
)
const MODES = new Set(['pages', 'locate', 'page', 'frame'])
// The validation session can Edit files, so the on-disk script is not trusted by
// itself: its body (everything below the two header lines) must hash to this value.
// Changing figma-notes.js means updating this hash, which is a change to the hook.
const SCRIPT_BODY_SHA256 = '4b95085849a56df85de6afb66b90fcb9f106528729904338eb72127079cc8f60'
// `I123:456;789:10` is the form get_metadata returns for a node inside an instance.
const NODE_ID = String.raw`I?\d+:\d+(?:;\d+:\d+)*`
const TARGET_PATTERNS = {
    pages: /^$/,
    locate: new RegExp(`^${NODE_ID}(,${NODE_ID})*$`),
    page: /^\d+:\d+$/,
    frame: new RegExp(`^${NODE_ID}(#\\d+)?$`),
}
const TARGET_HINTS = {
    pages: 'empty',
    locate: 'comma-separated node ids like 123:456',
    page: 'one page id like 123:456',
    frame: 'one node id like 123:456, optionally followed by #offset',
}
const HEADER = /^const (MODE|TARGET) = '([^'\\]*)'\s*$/

function normalize(text) {
    return text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.replace(/\s+$/, ''))
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

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex')
}

export function checkFigmaCode(code, script) {
    const deny = (reason) => ({ allow: false, reason })
    if (!script) {
        return deny(
            'figma-notes.js is missing from this clone — Sync the repo (QA Runner Sync button) and retry.'
        )
    }
    const sent = splitHeader(code)
    const fixed = splitHeader(script)
    if (!fixed || sha256(fixed.body) !== SCRIPT_BODY_SHA256) {
        return deny(
            'figma-notes.js does not match the hash pinned in figma-readonly.mjs — it was ' +
                'edited. Sync the repo (QA Runner Sync button) to restore it.'
        )
    }
    if (!sent || sent.body !== fixed.body) {
        return deny(
            'use_figma may only run .claude/skills/qa-validate/figma-notes.js unchanged ' +
                '(MODE and TARGET lines only).'
        )
    }
    if (!MODES.has(sent.mode)) {
        return deny(`MODE must be one of pages, locate, page, frame (got '${sent.mode}')`)
    }
    if (!TARGET_PATTERNS[sent.mode].test(sent.target)) {
        return deny(
            `TARGET for '${sent.mode}' must be ${TARGET_HINTS[sent.mode]} (got '${sent.target}')`
        )
    }
    return { allow: true }
}

function emit(decision) {
    process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision } })
    )
}

// On exit 2 Claude Code ignores stdout and feeds stderr back as the block reason.
function deny(reason) {
    process.stderr.write(`${reason}\n`)
    emit({ permissionDecision: 'deny', permissionDecisionReason: reason })
}

function main() {
    // Unreadable input or script leaves the value empty, which checkFigmaCode denies.
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
    if (typeof code !== 'string') return deny('use_figma code must be a string.')
    const result = checkFigmaCode(code, script)
    if (result.allow) return emit({ permissionDecision: 'allow' })
    deny(result.reason)
}

function run() {
    try {
        main()
    } catch (error) {
        // Only exit code 2 or an explicit deny blocks; a crash must never fall through.
        deny(`figma-readonly hook crashed: ${error}`)
        process.exit(2)
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run()
