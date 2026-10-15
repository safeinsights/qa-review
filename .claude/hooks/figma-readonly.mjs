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

export function checkFigmaCode(code, script) {
    const deny = (reason) => ({ allow: false, reason })
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
    if (!MODES.has(sent.mode)) {
        return deny(`MODE must be one of pages, locate, page (got '${sent.mode}')`)
    }
    if (sent.mode === 'pages' ? sent.target !== '' : !NODE_LIST.test(sent.target)) {
        return deny(
            `TARGET must be empty for 'pages', else node ids like 123:456 (got '${sent.target}')`
        )
    }
    return { allow: true }
}

function emit(decision) {
    process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision } })
    )
}

function deny(reason) {
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
