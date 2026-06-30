import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Recorder } from '@/engine/recorder'

const made: string[] = []
afterEach(() => {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true })
    made.length = 0
})

function tmpRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-'))
    made.push(dir)
    return dir
}

describe('Recorder', () => {
    it('records step events and writes a summary.json + report.html bundle', async () => {
        const root = tmpRoot()
        const rec = new Recorder({ root, suite: 'signin', env: 'qa', role: 'admin', mode: 'suite', startedAt: 1000 })

        rec.step('Logged in', 'passed')
        rec.step('Opened dashboard', 'failed', { error: 'not visible' })

        const result = rec.finish({ ok: false, failureCategory: 'app-assertion', cleanup: { ok: true, deleted: [], failed: [] } })

        expect(fs.existsSync(path.join(result.bundleDir, 'summary.json'))).toBe(true)
        expect(fs.existsSync(path.join(result.bundleDir, 'report.html'))).toBe(true)
        const summary = JSON.parse(fs.readFileSync(path.join(result.bundleDir, 'summary.json'), 'utf8'))
        expect(summary.ok).toBe(false)
        expect(summary.failureCategory).toBe('app-assertion')
        expect(summary.steps).toHaveLength(2)
        expect(summary.steps[1].status).toBe('failed')
    })

    it('streams step events to an optional listener as they happen', () => {
        const root = tmpRoot()
        const seen: string[] = []
        const rec = new Recorder(
            { root, suite: 's', env: 'qa', role: 'admin', mode: 'suite', startedAt: 1 },
            (e) => seen.push(`${e.name}:${e.status}`),
        )
        rec.step('A', 'running')
        rec.step('A', 'passed')
        expect(seen).toEqual(['A:running', 'A:passed'])
    })

    it('coalesces a running step into its resolved status (one entry, not two)', () => {
        const root = tmpRoot()
        const rec = new Recorder({ root, suite: 's', env: 'qa', role: 'admin', mode: 'suite', startedAt: 1 })
        rec.step('Create study', 'running')
        rec.step('Create study', 'passed')
        const result = rec.finish({ ok: true, cleanup: { ok: true, deleted: [], failed: [] } })
        expect(result.steps).toHaveLength(1)
        expect(result.steps[0].status).toBe('passed')
    })

    it('escapes app-controlled text in report.html', () => {
        const root = tmpRoot()
        const rec = new Recorder({ root, suite: 's', env: 'qa', role: 'admin', mode: 'suite', startedAt: 1 })
        rec.step('Open <script>alert(1)</script>', 'failed', { error: 'bad & <tag>' })
        const result = rec.finish({ ok: false, failureCategory: 'app-assertion', cleanup: { ok: true, deleted: [], failed: [] } })
        const html = fs.readFileSync(path.join(result.bundleDir, 'report.html'), 'utf8')
        expect(html).not.toContain('<script>alert(1)</script>')
        expect(html).toContain('&lt;script&gt;')
        expect(html).toContain('bad &amp; &lt;tag&gt;')
    })

    it('records per-step screenshot paths in summary and report', () => {
        const root = tmpRoot()
        const rec = new Recorder({ root, suite: 's', env: 'qa', role: 'admin', mode: 'suite', startedAt: 1 })
        rec.step('Open page', 'passed', { screenshot: 'screenshots/01-open-page.png' })
        const result = rec.finish({ ok: true, cleanup: { ok: true, deleted: [], failed: [] } })
        expect(result.steps[0].screenshot).toBe('screenshots/01-open-page.png')
        const html = fs.readFileSync(path.join(result.bundleDir, 'report.html'), 'utf8')
        expect(html).toContain('screenshots/01-open-page.png')
    })
})
