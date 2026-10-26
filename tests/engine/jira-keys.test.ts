import { describe, expect, it } from 'vitest'
import { extractJiraKeys, jiraBoardsFrom, managementAppRepo } from '@/engine/jira-keys'

const BOARDS = ['OTTER', 'SHRIMP', 'SHRMP', 'SIINFOSEC']

describe('extractJiraKeys', () => {
    it('finds keys with a hyphen or a space, any case, and normalizes them', () => {
        expect(extractJiraKeys('Otter 802 keep code resubmission notes', BOARDS)).toEqual([
            'OTTER-802',
        ])
        expect(extractJiraKeys('SIINFOSEC-1626: drop invalid signin', BOARDS)).toEqual([
            'SIINFOSEC-1626',
        ])
    })

    it('maps the SHRMP typo to SHRIMP', () => {
        expect(extractJiraKeys('SHRMP-328 Update TO email', BOARDS)).toEqual(['SHRIMP-328'])
    })

    it('returns each key once, in order of appearance', () => {
        expect(extractJiraKeys('OTTER-822 fixes; see OTTER-822 and OTTER-471', BOARDS)).toEqual([
            'OTTER-822',
            'OTTER-471',
        ])
    })

    it('ignores ticket-shaped noise from unknown boards', () => {
        expect(extractJiraKeys('fixes-2026 node-7 haiku-4', BOARDS)).toEqual([])
    })
})

describe('settings-backed values', () => {
    it('reads JIRA_BOARDS as a comma list and the repo slug', () => {
        const vars = { JIRA_BOARDS: 'OTTER, SHRIMP', MANAGEMENT_APP_REPO: 'safeinsights/x' }
        expect(jiraBoardsFrom(vars)).toEqual(['OTTER', 'SHRIMP'])
        expect(managementAppRepo(vars)).toBe('safeinsights/x')
    })

    it('fails loudly when either is missing', () => {
        expect(() => jiraBoardsFrom({})).toThrow(/JIRA_BOARDS/)
        expect(() => managementAppRepo({})).toThrow(/MANAGEMENT_APP_REPO/)
    })
})
