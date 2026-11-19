import { describe, expect, it } from 'vitest'
import { withRunOverrides } from '@/cli/commands/run'
import {
    DATA_ORG_SETTING,
    DATA_ORGS,
    DEFAULT_DATA_ORG,
    dataOrgOptionName,
    resolveDataOrg,
} from '@/engine/flows/study'

describe('resolveDataOrg', () => {
    it('defaults to OpenStax when unset or blank', () => {
        expect(DEFAULT_DATA_ORG).toBe('openstax')
        expect(resolveDataOrg(undefined)).toBe('openstax')
        expect(resolveDataOrg('  ')).toBe('openstax')
    })

    it('accepts each known slug, ignoring case and padding', () => {
        expect(resolveDataOrg('mars-u')).toBe('mars-u')
        expect(resolveDataOrg(' Mars-U ')).toBe('mars-u')
        expect(resolveDataOrg('openstax')).toBe('openstax')
    })

    it('rejects an unknown slug, naming the known ones', () => {
        expect(() => resolveDataOrg('mars')).toThrow(/Unknown data org "mars".*openstax, mars-u/)
        // An inherited Object key must not pass as a slug.
        expect(() => resolveDataOrg('constructor')).toThrow(/Unknown data org/)
    })
})

describe('dataOrgOptionName', () => {
    it('maps each slug to its picker display name', () => {
        expect(DATA_ORGS['mars-u']).toBe('Mars University')
        expect(DATA_ORGS.openstax).toBe('OpenStax')
    })

    it('matches OpenStax options exactly as the old /openstax/i did', () => {
        const re = dataOrgOptionName('openstax')
        expect(re.source).toBe('OpenStax')
        expect(re.flags).toBe('i')
        expect(re.test('Openstax')).toBe(true)
    })

    it('matches Mars University and not OpenStax', () => {
        const re = dataOrgOptionName('mars-u')
        expect(re.test('Mars University')).toBe(true)
        expect(re.test('Openstax')).toBe(false)
    })
})

describe('withRunOverrides', () => {
    it('leaves the settings alone without --data-org', () => {
        const vars = { QA_BASE_URL: 'https://qa.example.com' }
        expect(withRunOverrides({}, vars)).toBe(vars)
    })

    it('puts a validated --data-org into the setting suites read', () => {
        const vars = { [DATA_ORG_SETTING]: 'openstax' }
        expect(withRunOverrides({ 'data-org': 'Mars-U' }, vars)[DATA_ORG_SETTING]).toBe('mars-u')
    })

    it('fails on an unknown --data-org before any run starts', () => {
        expect(() => withRunOverrides({ 'data-org': 'nope' }, {})).toThrow(/Unknown data org/)
    })
})
