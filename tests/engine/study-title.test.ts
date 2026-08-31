import { describe, expect, it } from 'vitest'
import {
    fitStudyTitle,
    generateStudyContent,
    STUDY_TITLE_MAX,
    taggedTitle,
} from '@/engine/flows/study'

// A realistic ctx.tag: `qa-<suite>-<startedAt>`, 33 characters.
const TAG = 'qa-study-happy-path-1787861935050'

const hasLoneSurrogate = (s: string) =>
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)

describe('taggedTitle', () => {
    it('keeps the tag whole and gives way on the descriptive half', () => {
        const title = taggedTitle('a very long descriptive study subject that will not fit', TAG)
        expect(title.length).toBeLessThanOrEqual(STUDY_TITLE_MAX)
        expect(title).toContain(`(QA ${TAG})`)
    })

    it('leaves a title that already fits untouched', () => {
        expect(taggedTitle('short', TAG)).toBe(`short (QA ${TAG})`)
    })

    // The suffix opens with a space, so an empty descriptive half would otherwise
    // leave a leading one. Forms often trim on save, which would make the stored
    // value differ from the value the row is later looked up by.
    it('does not leave a leading space when the subject trims away entirely', () => {
        expect(taggedTitle('', TAG)).toBe(`(QA ${TAG})`)
        // A single word longer than the room left over also trims to nothing.
        const room = STUDY_TITLE_MAX - ` (QA ${TAG})`.length
        const title = taggedTitle('W'.repeat(room + 10), TAG)
        expect(title).toBe(title.trim())
    })

    // A tag longer than the whole budget has to be cut somewhere. Cutting the
    // finished "(QA <tag>)" group from the left would take the marker off first,
    // leaving an orphaned ")" that identifies nothing.
    it('keeps the "(QA " marker and the tag tail when the tag exceeds the budget', () => {
        const longTag = 'qa-a-really-extremely-long-suite-name-goes-here-1787861935050'
        expect(longTag.length).toBeGreaterThan(STUDY_TITLE_MAX)
        const title = taggedTitle('Subject here', longTag)
        expect(title.length).toBeLessThanOrEqual(STUDY_TITLE_MAX)
        expect(title.startsWith('(QA ')).toBe(true)
        expect(title.endsWith(')')).toBe(true)
        // The per-run timestamp is the part that distinguishes one run from another.
        expect(title).toContain('1787861935050')
    })

    // length/slice count UTF-16 code units, so a cut with no space in the window
    // can land between the halves of a surrogate pair.
    it('cuts on character boundaries rather than mid-surrogate-pair', () => {
        const title = taggedTitle('😀'.repeat(30), TAG)
        expect(hasLoneSurrogate(title)).toBe(false)
        expect(title).toContain(`(QA ${TAG})`)
    })
})

describe('fitStudyTitle', () => {
    it('passes a title that already fits straight through', () => {
        const title = `short (QA ${TAG})`
        expect(fitStudyTitle(title)).toBe(title)
    })

    // This is the RETRY path: a single-step retry re-uses the title the first
    // attempt wrote to ctx.state.
    it('trims the descriptive half and keeps a trailing tag group whole', () => {
        const fitted = fitStudyTitle(`${'x'.repeat(80)} (QA ${TAG})`)
        expect(fitted.length).toBeLessThanOrEqual(STUDY_TITLE_MAX)
        expect(fitted).toContain(`(QA ${TAG})`)
    })

    it('never returns more than the cap', () => {
        for (const input of [
            'x'.repeat(200),
            `${'x'.repeat(200)} (QA ${TAG})`,
            `(QA ${'y'.repeat(120)})`,
        ]) {
            expect(fitStudyTitle(input).length).toBeLessThanOrEqual(STUDY_TITLE_MAX)
        }
    })
})

describe('generateStudyContent', () => {
    it('builds a title that fits the cap with the tag intact', () => {
        for (let i = 0; i < 25; i++) {
            const { title } = generateStudyContent(TAG)
            expect(title.length).toBeLessThanOrEqual(STUDY_TITLE_MAX)
            expect(title).toContain(`(QA ${TAG})`)
        }
    })
})
