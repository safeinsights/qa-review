import { describe, expect, it } from 'vitest'
import { type StepEnvelope, stepsByIndex } from '@/gui/lib/stepStream'

const ev = (name: string, status: string, at = 1): StepEnvelope =>
    ({ type: 'step', name, status, at }) as StepEnvelope

// The checklist maps the suite's STATIC step names onto executed positions BY INDEX.
// A jumped-over step must therefore still occupy its position — otherwise every later
// row shifts up and the UI lights up the wrong steps.
describe('stepsByIndex with skipped steps (jump-to)', () => {
    it('keeps positions aligned after a forward jump', () => {
        const byIndex = stepsByIndex([
            ev('one', 'running'),
            ev('one', 'passed'),
            ev('two', 'skipped'),
            ev('three', 'skipped'),
            ev('four', 'running'),
            ev('four', 'passed'),
        ])
        const stepNames = ['one', 'two', 'three', 'four']
        // This is exactly what StepChecklist does to build its rows.
        const rows = stepNames.map((name, i) => ({ name, status: byIndex[i]?.status }))
        expect(rows).toEqual([
            { name: 'one', status: 'passed' },
            { name: 'two', status: 'skipped' },
            { name: 'three', status: 'skipped' },
            { name: 'four', status: 'passed' },
        ])
    })

    it('does not let a skipped step overwrite the previous row', () => {
        const byIndex = stepsByIndex([
            ev('one', 'running'),
            ev('one', 'passed'),
            ev('two', 'skipped'),
        ])
        expect(byIndex.map(s => [s.name, s.status])).toEqual([
            ['one', 'passed'],
            ['two', 'skipped'],
        ])
    })
})
