import { describe, expect, it } from 'vitest'
import { parseArgs } from '@/cli/args'
import { commandHelp, commandNames, topLevelHelp, unknownCommandMessage } from '@/cli/help'

describe('topLevelHelp', () => {
    it('lists every command with a summary', () => {
        const text = topLevelHelp()
        for (const name of commandNames()) {
            expect(text).toContain(name)
        }
    })
})

describe('commandHelp', () => {
    it('returns a usage line for a known command', () => {
        expect(commandHelp('session-login')).toContain('qar session-login --role')
    })

    it('returns null for an unknown command so the caller can error', () => {
        expect(commandHelp('nope')).toBeNull()
    })

    it('warns that only one session may run, since that failure is otherwise silent', () => {
        const text = commandHelp('session') ?? ''
        expect(text).toMatch(/ONLY ONE session/i)
    })
})

describe('--help parsing', () => {
    // The original bug: `help` was not a boolean, so `qar session --help` parsed
    // --help as a key awaiting a value and launched a real session instead.
    it('treats --help as a boolean flag, consuming no following token', () => {
        const opts = parseArgs(['--help'], { booleans: ['help'] })
        expect(opts.help).toBe('true')
    })

    it('does not swallow a following argument', () => {
        const opts = parseArgs(['--help', '--env', 'qa'], { booleans: ['help'] })
        expect(opts.help).toBe('true')
        expect(opts.env).toBe('qa')
    })
})

describe('unknownCommandMessage', () => {
    it('names the offending command and points at --help', () => {
        const text = unknownCommandMessage('bogus')
        expect(text).toContain('bogus')
        expect(text).toContain('qar --help')
    })
})
