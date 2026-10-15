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

    it('denies when the script file is missing', () => {
        const result = checkFigmaCode(script, '')
        expect(result.allow).toBe(false)
        expect(result.reason).toContain('Sync')
    })
})
