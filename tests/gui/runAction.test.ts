import { describe, expect, it } from 'vitest'
import { runActionKind, teardownLabel } from '@/gui/components/runAction'

// The run control bar offers ONE primary action, and which one it offers is the
// whole contract — a wrong choice here either strands the user with no way forward
// or hands them a destructive button at the worst moment.
describe('runActionKind', () => {
    it('offers Run when nothing is happening', () => {
        expect(runActionKind({})).toBe('run')
    })

    it('offers Stop while a run is in flight', () => {
        expect(runActionKind({ running: true })).toBe('stop')
    })

    it('offers Resume at a pause, over Stop', () => {
        expect(runActionKind({ running: true, paused: true })).toBe('resume')
    })

    it('offers Retry step on a held step failure, over Resume and Stop', () => {
        expect(runActionKind({ running: true, paused: true, stepFailed: true })).toBe('retryStep')
    })

    // The regression this module exists for. Give up leaves `running` true — the
    // engine has not emitted its result yet — and teardown is not instant (test data
    // cleanup, trace/video save, then the screencast's viewing grace). Falling
    // through to a live Stop reads as "give up did nothing", and pressing it exits
    // the process before the result line, losing the verdict the run already reached.
    it('shows teardown after give up, not a live Stop', () => {
        expect(runActionKind({ running: true, stopping: true })).toBe('teardown')
    })

    // A step-failed envelope already in flight when give up is sent must not put an
    // actionable Retry step back under the cursor mid-teardown.
    it('keeps teardown when a stale step-failed arrives during it', () => {
        expect(runActionKind({ running: true, stopping: true, stepFailed: true })).toBe('teardown')
    })

    it('keeps teardown over a pause', () => {
        expect(runActionKind({ running: true, stopping: true, paused: true })).toBe('teardown')
    })
})

describe('teardownLabel', () => {
    it('names a stop', () => {
        expect(teardownLabel('stop')).toBe('Stopping…')
    })

    // Give up is not a stop; calling it one invites the same doubt the disabled
    // state exists to remove.
    it('names giving up as finishing, not stopping', () => {
        expect(teardownLabel('giveUp')).toBe('Finishing…')
    })
})
