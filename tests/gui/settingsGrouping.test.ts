import { describe, expect, it } from 'vitest'
import { isEnvConfigured, toEnvCards } from '@/gui/components/settingsGrouping'
import type { SettingField } from '@/gui/lib/ipc'

const f = (o: Partial<SettingField>): SettingField => ({
    key: '',
    label: '',
    secret: false,
    group: '',
    env: '',
    section: '',
    multiline: false,
    tier: '',
    value: '',
    set: false,
    localOnly: false,
    ...o,
})

// Mirrors the real buildKnownVars() order: Jira, base URLs, then each account.
const FIELDS: SettingField[] = [
    f({ key: 'JIRA_URL', group: 'Jira', localOnly: true }),
    f({ key: 'QA_BASE_URL', env: 'qa', section: 'Environment', value: 'https://qa', set: true }),
    f({ key: 'STAGING_BASE_URL', env: 'staging', section: 'Environment' }),
    f({
        key: 'ADMIN_EMAIL_QA',
        group: 'Admin',
        env: 'qa',
        section: 'Account',
        secret: true,
        set: true,
    }),
    f({ key: 'ADMIN_PASSWORD_QA', group: 'Admin', env: 'qa', section: 'Account', secret: true }),
    f({
        key: 'ADMIN_RESULTS_PRIVATE_KEY_QA',
        group: 'Admin',
        env: 'qa',
        section: 'Results private key',
        secret: true,
        multiline: true,
    }),
    f({
        key: 'ADMIN_EMAIL_STAGING',
        group: 'Admin',
        env: 'staging',
        section: 'Account',
        secret: true,
    }),
    f({ key: 'REVIEWER_EMAIL_QA', group: 'Reviewer', env: 'qa', section: 'Account', secret: true }),
]

describe('toEnvCards', () => {
    it('groups the selected env into base-URL card + account cards, in order', () => {
        const cards = toEnvCards(FIELDS, 'qa')
        expect(cards.map(c => c.group)).toEqual(['', 'Admin', 'Reviewer'])
        // The account-less card holds only that env's base URL.
        expect(cards[0].sections).toEqual([
            { section: 'Environment', fields: [expect.objectContaining({ key: 'QA_BASE_URL' })] },
        ])
        // Admin splits into its two sections, in first-seen order.
        expect(cards[1].sections.map(s => s.section)).toEqual(['Account', 'Results private key'])
        expect(cards[1].sections[0].fields.map(x => x.key)).toEqual([
            'ADMIN_EMAIL_QA',
            'ADMIN_PASSWORD_QA',
        ])
    })

    it('excludes other envs entirely, including Jira (global)', () => {
        const keys = toEnvCards(FIELDS, 'staging').flatMap(c =>
            c.sections.flatMap(s => s.fields.map(x => x.key))
        )
        expect(keys).toEqual(['STAGING_BASE_URL', 'ADMIN_EMAIL_STAGING'])
        expect(keys).not.toContain('JIRA_URL')
    })

    it('returns nothing for an env with no fields', () => {
        expect(toEnvCards(FIELDS, 'production')).toEqual([])
    })
})

describe('isEnvConfigured', () => {
    it('is true when any field of that env is set, false otherwise', () => {
        expect(isEnvConfigured(FIELDS, 'qa')).toBe(true)
        expect(isEnvConfigured(FIELDS, 'staging')).toBe(false)
    })
})

// The panel picks the selected env's fields by exact match, so a selection that
// isn't in the loaded set yields nothing — this is why useSettings falls back to
// the first available env rather than trusting a hardcoded default.
describe('env selection fallback', () => {
    const envsOf = (all: SettingField[]) => [...new Set(all.filter(x => x.env).map(x => x.env))]

    it('lists the envs present in the fields, in first-seen order', () => {
        expect(envsOf(FIELDS)).toEqual(['qa', 'staging'])
    })

    it('an env outside that list renders no cards', () => {
        expect(toEnvCards(FIELDS, 'nope')).toEqual([])
    })
})
