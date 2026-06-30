import { describe, it, expect } from 'vitest'
import { generateSuite } from '@/codegen/generate-suite'
import type { ActionTrace } from '@/codegen/action-trace'

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
    it('emits a Suite with one ctx.step per distinct step label', () => {
        const src = generateSuite(trace)
        expect(src).toContain("name: 'admin-invites-user'")
        expect(src).toContain("description: 'Admin invites a user and confirms they appear'")
        expect(src).toContain("roles: ['admin']")
        expect(src).toContain("await ctx.step('Open members page'")
        expect(src).toContain("await ctx.step('Invite a user'")
        expect(src).toContain("await ctx.step('Confirm they appear'")
        // Two actions under the same label go in ONE step block.
        expect(src.match(/ctx\.step\('Invite a user'/g)).toHaveLength(1)
    })

    it('maps actions to Playwright calls', () => {
        const src = generateSuite(trace)
        expect(src).toContain('await ctx.page.goto(`${ctx.baseURL}/openstax/members`')
        expect(src).toContain("ctx.page.locator('role=button[name=\"Invite\"]').click()")
        expect(src).toContain("ctx.page.locator('label=Email').fill('x@y.com')")
        expect(src).toContain("ctx.page.locator('text=x@y.com').waitFor({ state: 'visible' })")
    })

    it('exports a camelCase suite const derived from the name', () => {
        const src = generateSuite(trace)
        expect(src).toContain('export const adminInvitesUserSuite: Suite =')
    })
})
