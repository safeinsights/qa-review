import { describe, it, expect } from 'vitest'
import { type ActionTrace, parseTrace } from '@/codegen/action-trace'

describe('action-trace', () => {
    it('parses a valid trace JSON into typed actions', () => {
        const raw = JSON.stringify({
            name: 'admin-invites-user',
            description: 'Admin invites a user',
            role: 'admin',
            actions: [
                { step: 'Open members', kind: 'goto', url: '/openstax/members' },
                { step: 'Invite', kind: 'click', selector: 'role=button[name="Invite"]' },
                { step: 'Invite', kind: 'fill', selector: 'label=Email', value: 'x@y.com' },
                { step: 'Confirm', kind: 'expectVisible', selector: 'text=x@y.com' },
            ],
        })
        const trace: ActionTrace = parseTrace(raw)
        expect(trace.name).toBe('admin-invites-user')
        expect(trace.actions).toHaveLength(4)
        expect(trace.actions[1]).toEqual({ step: 'Invite', kind: 'click', selector: 'role=button[name="Invite"]' })
    })

    it('throws on an unknown action kind', () => {
        const raw = JSON.stringify({
            name: 'x', description: 'x', role: 'admin',
            actions: [{ step: 's', kind: 'teleport', selector: 'a' }],
        })
        expect(() => parseTrace(raw)).toThrow(/unknown action kind "teleport"/i)
    })
})
