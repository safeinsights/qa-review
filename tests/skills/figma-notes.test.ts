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
