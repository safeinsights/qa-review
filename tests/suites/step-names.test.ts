import { describe, expect, it } from 'vitest'
import { lighthouseSuite } from '@/suites/lighthouse'
import { releaseHappyPathSuite } from '@/suites/release-happy-path'
import { signinSuite } from '@/suites/signin'
import { studyHappyPathSuite } from '@/suites/study-happy-path'
import { studyReadyToRunSuite } from '@/suites/study-ready-to-run'
import type { Suite } from '@/suites/types'

// The step names shown in the GUI before a run come straight from suite.steps —
// there is no separate list to drift. These tests pin the intended order so an
// accidental reorder/rename during a suite edit is caught. If you deliberately
// change a suite's steps, update the expected array here.

function names(s: Suite): string[] {
    return s.steps.map(st => st.name)
}

describe('built-in suite step names', () => {
    it('release-happy-path = three sign-ins, then the full study lifecycle', () => {
        const n = names(releaseHappyPathSuite)
        expect(n.slice(0, 3)).toEqual([
            'Sign in as admin: dashboard visible',
            'Sign in as reviewer: dashboard visible',
            'Sign in as researcher: dashboard visible',
        ])
        expect(n.slice(3)).toEqual(names(studyHappyPathSuite))
        expect(releaseHappyPathSuite.roles).toEqual(['researcher'])
    })

    it('signin', () => {
        expect(names(signinSuite)).toEqual(['Confirm dashboard is visible'])
    })

    it('study-happy-path (repeated account-switch names are intentional)', () => {
        const n = names(studyHappyPathSuite)
        expect(n[0]).toBe('Open the researcher org dashboard')
        expect(n[n.length - 1]).toBe('Verify the study is deleted')
        // The account-switch steps recur across the lifecycle; positional steps
        // handle the duplicates (no coalescing by name).
        expect(n.filter(x => x === 'Switch to the reviewer account')).toHaveLength(3)
        expect(n.filter(x => x === 'Switch back to the researcher account')).toHaveLength(3)
    })

    it('study-ready-to-run stops at code approval and deletes nothing', () => {
        expect(names(studyReadyToRunSuite)).toEqual([
            'Choose the data partner',
            'Open the researcher org dashboard',
            'Start a new study proposal',
            'Step 1: name the study, choose org and language, then capture the study id',
            'Step 2: fill the proposal',
            'Submit the initial request',
            'Switch to the reviewer account',
            'Reviewer approves the proposal',
            'Switch back to the researcher account',
            'Route to the code upload page',
            'Researcher is not held at the agreement gate',
            'Upload main.r',
            'Submit the study code',
            'Switch to the reviewer account',
            'Reviewer approves the code',
            'Report the ready-to-run study',
        ])
        expect(studyReadyToRunSuite.roles).toEqual(['researcher'])
    })

    it('lighthouse', () => {
        expect(names(lighthouseSuite)).toEqual([
            'Audit my dashboard',
            'Audit the org dashboard',
            'Audit admin settings',
            'Audit admin team',
            'Record the overall score',
        ])
    })

    it('every step has a non-empty name and a run function', () => {
        for (const s of [
            signinSuite,
            studyHappyPathSuite,
            studyReadyToRunSuite,
            lighthouseSuite,
            releaseHappyPathSuite,
        ]) {
            for (const step of s.steps) {
                expect(step.name.length).toBeGreaterThan(0)
                expect(typeof step.run).toBe('function')
            }
        }
    })
})
