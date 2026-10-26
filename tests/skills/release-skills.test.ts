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
        expect(src).not.toMatch(/jira-comment|jira_add_comment/)
    })
})

// The run session's only Jira write is one card with the local security results,
// and only when the runner asks. The plan session never writes to Jira.
describe('jira-create-issue', () => {
    const read = (skill: string) =>
        fs.readFileSync(path.resolve(__dirname, `../../.claude/skills/${skill}/SKILL.md`), 'utf8')

    it('is named once in the run skill, in the on-request sentence', () => {
        const lines = read('qa-release-run')
            .split('\n')
            .filter(l => l.includes('jira-create-issue'))
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatch(/Only if the runner asks/)
        expect(read('qa-release-run').match(/jira-create-issue/g)).toHaveLength(1)
    })

    it('is never named in the plan skill', () => {
        expect(read('qa-release-plan')).not.toContain('jira-create-issue')
    })
})

describe('the security rule', () => {
    it('the run skill never runs qar run and never uploads the security file', () => {
        const src = fs.readFileSync(
            path.resolve(__dirname, '../../.claude/skills/qa-release-run/SKILL.md'),
            'utf8'
        )
        expect(src).not.toMatch(/qar run --suite/)
        expect(src).toContain('baseline-<env>.json')
        expect(src).toContain('--remote-only')
        expect(src).toContain('Never upload `securityOutput`')
    })

    it('the plan skill uploads testing-plan.md and says Security is stripped', () => {
        const src = fs.readFileSync(
            path.resolve(__dirname, '../../.claude/skills/qa-release-plan/SKILL.md'),
            'utf8'
        )
        expect(src).toContain('--as testing-plan.md')
        expect(src).toMatch(/Security section is stripped on upload/)
        expect(src).not.toContain('regression-plan.md')
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

    it('orders Changes by impact with the three levels', () => {
        expect(src).toContain('ordered by impact')
        expect(src).toContain('impact')
        for (const w of ['high', 'medium', 'low']) expect(src).toContain(w)
    })
})
