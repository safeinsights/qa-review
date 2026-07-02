import { describe, expect, it } from 'vitest'
import { createStudySuite } from '@/suites/create-study'
import { signinSuite } from '@/suites/signin'
import { studyHappyPathSuite } from '@/suites/study-happy-path'
import type { Suite } from '@/suites/types'

// The step names shown in the GUI before a run come straight from suite.steps —
// there is no separate list to drift. These tests pin the intended order so an
// accidental reorder/rename during a suite edit is caught. If you deliberately
// change a suite's steps, update the expected array here.

function names(s: Suite): string[] {
    return s.steps.map(st => st.name)
}

describe('built-in suite step names', () => {
    it('signin', () => {
        expect(names(signinSuite)).toEqual(['Confirm dashboard is visible'])
    })

    it('create-study', () => {
        expect(names(createStudySuite)).toEqual([
            'Open the researcher org dashboard',
            'Start a new study proposal',
            'Step 1: choose org and language',
            'Reach Step 2 and capture the study id',
            'Step 2: fill the proposal',
            'Submit the initial request',
        ])
    })

    it('study-happy-path (repeated account-switch names are intentional)', () => {
        const n = names(studyHappyPathSuite)
        expect(n[0]).toBe('Open the researcher org dashboard')
        expect(n[n.length - 1]).toBe('Switch to the admin account for cleanup authority')
        // The account-switch steps recur across the lifecycle; positional steps
        // handle the duplicates (no coalescing by name).
        expect(n.filter(x => x === 'Switch to the reviewer account')).toHaveLength(3)
        expect(n.filter(x => x === 'Switch back to the researcher account')).toHaveLength(3)
    })

    it('every step has a non-empty name and a run function', () => {
        for (const s of [signinSuite, createStudySuite, studyHappyPathSuite]) {
            for (const step of s.steps) {
                expect(step.name.length).toBeGreaterThan(0)
                expect(typeof step.run).toBe('function')
            }
        }
    })
})
