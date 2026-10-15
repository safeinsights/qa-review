import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error untyped hook module
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
        expect(checkFigmaCode(withHeader('frame', '3531:6192'), script).allow).toBe(true)
    })

    it('ignores line-ending and trailing-whitespace differences', () => {
        const crlf = script.replace(/\n/g, '  \r\n')
        expect(checkFigmaCode(crlf, script).allow).toBe(true)
    })

    it('denies a changed body', () => {
        const changed = script.replace(
            'return { pages:',
            'figma.root.children[0].remove(); return { pages:'
        )
        expect(changed).not.toBe(script)
        const result = checkFigmaCode(changed, script)
        expect(result.allow).toBe(false)
        expect(result.reason).toContain('figma-notes.js')
    })

    it('denies an extra trailing line', () => {
        const extra = `${script}\nfigma.currentPage.children[0].remove()\n`
        expect(checkFigmaCode(extra, script).allow).toBe(false)
    })

    it('denies a bad MODE', () => {
        expect(checkFigmaCode(withHeader('write', ''), script).allow).toBe(false)
    })

    it('denies a TARGET that is not a node id list', () => {
        const injected = "'; figma.root.remove(); '"
        expect(checkFigmaCode(withHeader('page', injected), script).allow).toBe(false)
        expect(checkFigmaCode(withHeader('page', 'abc'), script).allow).toBe(false)
        expect(checkFigmaCode(withHeader('pages', '1:2'), script).allow).toBe(false)
    })

    it('denies a header followed by trailing code', () => {
        const rest = script.split('\n').slice(2).join('\n')
        const code = `const MODE = 'page'; evil()\nconst TARGET = '1:2'\n${rest}`
        expect(checkFigmaCode(code, script).allow).toBe(false)
    })

    it('denies a swapped header order', () => {
        const rest = script.split('\n').slice(2).join('\n')
        const code = `const TARGET = ''\nconst MODE = 'pages'\n${rest}`
        expect(checkFigmaCode(code, script).allow).toBe(false)
    })

    it('denies when the script file is missing', () => {
        const result = checkFigmaCode(script, '')
        expect(result.allow).toBe(false)
        expect(result.reason).toContain('Sync')
    })
})

describe('hook CLI', () => {
    const hookPath = path.resolve(__dirname, '../../.claude/hooks/figma-readonly.mjs')

    function decide(input: string) {
        const run = spawnSync(process.execPath, [hookPath], { input, encoding: 'utf8' })
        return JSON.parse(run.stdout).hookSpecificOutput
    }

    it('allows the unchanged script', () => {
        const out = decide(JSON.stringify({ tool_input: { code: script } }))
        expect(out.permissionDecision).toBe('allow')
    })

    it('denies other code, naming the script', () => {
        const out = decide(JSON.stringify({ tool_input: { code: 'figma.root.remove()' } }))
        expect(out.permissionDecision).toBe('deny')
        expect(out.permissionDecisionReason).toContain('figma-notes.js')
    })

    it('denies garbage input', () => {
        expect(decide('not json').permissionDecision).toBe('deny')
    })

    it('denies a non-string code', () => {
        expect(decide('{"tool_input":{"code":42}}').permissionDecision).toBe('deny')
    })
})
