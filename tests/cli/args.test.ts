import { describe, expect, it } from 'vitest'
import { parseArgs } from '@/cli/args'

describe('parseArgs', () => {
    it('parses --key value pairs', () => {
        const out = parseArgs(['--suite', 'signin', '--env', 'pr839'], { booleans: [] })
        expect(out).toEqual({ suite: 'signin', env: 'pr839' })
    })

    it('treats known booleans as true with no value', () => {
        const out = parseArgs(['--json', '--suite', 'signin'], { booleans: ['json'] })
        expect(out).toEqual({ json: 'true', suite: 'signin' })
    })

    it('ignores a leading positional (the subcommand is sliced off by caller)', () => {
        const out = parseArgs(['--env', 'qa'], { booleans: [] })
        expect(out.env).toBe('qa')
    })
})
