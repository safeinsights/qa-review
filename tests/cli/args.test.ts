import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { booleansFor, parseArgs } from '@/cli/args'
import { commandNames } from '@/cli/help'

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

// Boolean sets are per-subcommand. The regression this guards: `password` was added
// globally for fix-account's valueless switch, which silently turned
// `session-signin --password <value>` into `{password:'true'}` — Clerk then answered
// 422 form_password_incorrect and the CLI blamed the credentials.
describe('booleansFor', () => {
    it('gives every command --help', () => {
        for (const command of ['run', 'session-signin', 'set-secret', 'nonsense', undefined]) {
            expect(booleansFor(command)).toContain('help')
        }
    })

    it('keeps session-signin --password a value flag', () => {
        const out = parseArgs(['--email', 'a@b.c', '--password', 'p@ssw0rd!'], {
            booleans: booleansFor('session-signin'),
        })
        expect(out.password).toBe('p@ssw0rd!')
        expect(out.email).toBe('a@b.c')
    })

    it('keeps fix-account --password a valueless switch', () => {
        const out = parseArgs(['--role', 'reviewer', '--password', '--yes'], {
            booleans: booleansFor('fix-account'),
        })
        expect(out.password).toBe('true')
        expect(out.yes).toBe('true')
        expect(out.role).toBe('reviewer')
    })

    it('does not leak one command switches into another', () => {
        expect(booleansFor('run')).not.toContain('password')
        expect(booleansFor('session-signin')).not.toContain('password')
        expect(booleansFor('invite')).not.toContain('yes')
        expect(booleansFor('cleanup')).toEqual(['help'])
    })

    it('still treats --key as valueless on both secret commands', () => {
        for (const command of ['get-secret', 'set-secret']) {
            const out = parseArgs(['--key', 'REVIEWER_PASSWORD_QA'], {
                booleans: booleansFor(command),
            })
            expect(out.key).toBe('true')
            expect(out.name).toBeUndefined()
        }
    })
})

// COMMAND_BOOLEANS keys are typed as CommandName, so a typo there is a compile error
// rather than a switch set that silently applies to nothing. That only holds while
// CommandName describes the commands the CLI actually dispatches, which the type
// system cannot see — bin/qar.ts's switch is control flow, not data. These two pin
// the ends the type cannot reach.
describe('command names stay in sync', () => {
    const qar = fs.readFileSync(path.join(__dirname, '../../bin/qar.ts'), 'utf8')
    const dispatched = [...qar.matchAll(/^\s*case '([^']+)':/gm)].map(m => m[1])

    it('dispatches every command the help list advertises', () => {
        expect(dispatched.sort()).toEqual(commandNames().sort())
    })

    // The failure this catches: renaming a command in bin/qar.ts and COMMANDS but not
    // in COMMAND_BOOLEANS is a compile error, whereas renaming it ONLY in bin/qar.ts
    // leaves both lists agreeing with each other and disagreeing with the CLI.
    it('declares switches only for commands that are dispatched', () => {
        for (const command of commandNames()) {
            expect(dispatched).toContain(command)
        }
    })
})
