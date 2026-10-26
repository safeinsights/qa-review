import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { commandNames } from '@/cli/help'

// A skill that names a qar command that does not exist sends the session into a
// retry loop. This pins every `qar <command>` in both release skills to help.ts.
const SKILLS = ['qa-release-plan', 'qa-release-run']

describe.each(SKILLS)('%s', skill => {
    const file = path.resolve(__dirname, `../../.claude/skills/${skill}/SKILL.md`)
    const src = fs.readFileSync(file, 'utf8')

    it('names only real qar commands', () => {
        const names = new Set(commandNames())
        for (const m of src.matchAll(/`qar ([a-z-]+)/g)) {
            expect(names, `qar ${m[1]} in ${skill}`).toContain(m[1])
        }
    })

    it('carries the PTY rules and never posts to Jira', () => {
        expect(src).toMatch(/One command per Bash call/)
        expect(src).toMatch(/Never prefix a command with `cd`/)
        expect(src).toMatch(/under `\.tmp\//)
        expect(src).not.toMatch(/jira-comment|jira_add_comment|jira-create-issue/)
    })
})

describe('qa-release-plan', () => {
    const src = fs.readFileSync(
        path.resolve(__dirname, '../../.claude/skills/qa-release-plan/SKILL.md'),
        'utf8'
    )
    it('names the five sections in order and the staging-only marker', () => {
        const i = [
            '## Summary',
            '## Baseline',
            '## Changes',
            '## Security',
            '## Technical appendix',
        ].map(s => src.indexOf(s))
        for (const x of i) expect(x).toBeGreaterThan(-1)
        expect([...i].sort((a, b) => a - b)).toEqual(i)
        expect(src).toContain('(staging only)')
    })
})
