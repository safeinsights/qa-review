import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ActionTrace } from '@/codegen/action-trace'
import { generateSuite } from '@/codegen/generate-suite'

const trace: ActionTrace = {
    name: 'admin-invites-user',
    description: 'Admin invites a user and confirms they appear',
    role: 'admin',
    actions: [
        { step: 'Open members page', kind: 'goto', url: '/openstax/members' },
        { step: 'Invite a user', kind: 'click', selector: 'role=button[name="Invite"]' },
        { step: 'Invite a user', kind: 'fill', selector: 'label=Email', value: 'x@y.com' },
        { step: 'Confirm they appear', kind: 'expectVisible', selector: 'text=x@y.com' },
    ],
}

describe('generateSuite', () => {
    it('emits a Suite with one name-less step block per distinct step label', () => {
        const src = generateSuite(trace)
        expect(src).toContain("name: 'admin-invites-user'")
        expect(src).toContain("description: 'Admin invites a user and confirms they appear'")
        expect(src).toContain("roles: ['admin']")
        // Each distinct label appears once, as a step's `name:` field.
        expect(src).toContain("name: 'Open members page'")
        expect(src).toContain("name: 'Invite a user'")
        expect(src).toContain("name: 'Confirm they appear'")
        // Two actions under the same label go in ONE step block.
        expect(src.match(/name: 'Invite a user'/g)).toHaveLength(1)
        // The body uses ctx.step() with NO repeated label — the name lives only in
        // the `name:` field.
        expect(src).toContain('ctx.step(async () => {')
        expect(src).not.toContain("ctx.step('")
    })

    it('maps actions to Playwright calls', () => {
        const src = generateSuite(trace)
        // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting generated source contains a literal template expression
        expect(src).toContain('await ctx.page.goto(`${ctx.baseURL}/openstax/members`')
        expect(src).toContain('ctx.page.locator(\'role=button[name="Invite"]\').click()')
        expect(src).toContain("ctx.page.locator('label=Email').fill('x@y.com')")
        expect(src).toContain("ctx.page.locator('text=x@y.com').waitFor({ state: 'visible' })")
    })

    it('exports a camelCase suite const derived from the name', () => {
        const src = generateSuite(trace)
        expect(src).toContain('export const adminInvitesUserSuite: Suite =')
    })
})

describe('generateSuite escaping + identifier safety', () => {
    it('produces compilable TS when strings contain apostrophes', () => {
        const tricky: ActionTrace = {
            name: 'admin-cant-invite',
            description: "Admin can't invite a user named O'Brien",
            role: 'admin',
            actions: [
                { step: "It's step one", kind: 'goto', url: '/x' },
                { step: "It's step one", kind: 'fill', selector: 'label=Name', value: "O'Brien" },
                { step: 'Check', kind: 'expectVisible', selector: "text=O'Brien" },
            ],
        }
        const out = 'src/suites/_escape-smoke.ts'
        fs.writeFileSync(out, generateSuite(tricky))
        try {
            execFileSync('pnpm', ['typecheck'], { stdio: 'pipe' })
        } finally {
            fs.rmSync(out, { force: true })
        }
        // If typecheck threw, the test fails before reaching here.
        expect(true).toBe(true)
    })

    it('escapes backslashes/backticks in a goto URL so it cannot break out of the template', () => {
        const t: ActionTrace = {
            name: 'tricky-url',
            description: 'x',
            role: 'admin',
            // A backslash immediately before a backtick + a ${ sequence: naive
            // backtick-only escaping would let the input backslash consume the
            // escape and break out of the template literal.
            // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal ${ is the payload under test
            actions: [{ step: 'Go', kind: 'goto', url: '/x\\`${process.env}/y' }],
        }
        const src = generateSuite(t)
        // The backslash is doubled, the backtick and ${ are escaped.
        // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the escaped ${ appears in generated source
        expect(src).toContain('/x\\\\\\`\\${process.env}/y')
    })

    it('produces a valid identifier for a name with a leading digit', () => {
        const t: ActionTrace = {
            name: '2fa-login',
            description: 'x',
            role: 'admin',
            actions: [{ step: 'Go', kind: 'goto', url: '/x' }],
        }
        const src = generateSuite(t)
        expect(src).toContain('export const _2faLoginSuite: Suite =')
    })
})
