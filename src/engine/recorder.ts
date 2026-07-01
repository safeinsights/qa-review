import fs from 'node:fs'
import path from 'node:path'
import type { RunMode, Role, StepEvent, StepStatus, FailureCategory, RunResult } from '@/engine/types'

export interface RecorderInit {
    root: string // base results dir, e.g. <repo>/results
    suite: string
    env: string
    role: Role
    mode: RunMode
    startedAt: number
}

type FinishInput = {
    ok: boolean
    failureCategory?: FailureCategory
    cleanup: RunResult['cleanup']
}

type Listener = (event: StepEvent) => void

// Owns step events + bundle assembly. Playwright captures video/screenshots into
// `screenshots/` and `video.webm` under bundleDir (wired in run.ts); this class
// records the step timeline and writes summary.json + report.html.
export class Recorder {
    readonly bundleDir: string
    private steps: StepEvent[] = []

    constructor(
        private init: RecorderInit,
        private listener?: Listener,
    ) {
        const stamp = stampFor(init.startedAt)
        this.bundleDir = path.join(init.root, `${stamp}_${init.suite}_${init.env}`)
        fs.mkdirSync(path.join(this.bundleDir, 'screenshots'), { recursive: true })
    }

    step(name: string, status: StepStatus, extra?: { error?: string; screenshot?: string; url?: string }) {
        const event: StepEvent = { name, status, at: Date.now(), ...extra }
        // Replace the prior 'running' entry for the same step name when it resolves.
        const idx = this.steps.findIndex((s) => s.name === name && s.status === 'running')
        if (idx >= 0 && status !== 'running') this.steps[idx] = event
        else this.steps.push(event)
        this.listener?.(event)
    }

    finish(input: FinishInput): RunResult {
        const finishedAt = Date.now()
        const result: RunResult = {
            ok: input.ok,
            failureCategory: input.failureCategory,
            steps: this.steps,
            bundleDir: this.bundleDir,
            cleanup: input.cleanup,
            env: this.init.env,
            role: this.init.role,
            mode: this.init.mode,
            suite: this.init.suite,
            startedAt: this.init.startedAt,
            finishedAt,
        }
        fs.writeFileSync(path.join(this.bundleDir, 'summary.json'), JSON.stringify(result, null, 2))
        fs.writeFileSync(path.join(this.bundleDir, 'report.html'), renderReport(result))
        return result
    }
}

function stampFor(epoch: number): string {
    const d = new Date(epoch)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function renderReport(r: RunResult): string {
    const rows = r.steps
        .map((s) => {
            const mark = s.status === 'passed' ? '✓' : s.status === 'failed' ? '✗' : '…'
            const err = s.error ? ` — <em>${escapeHtml(s.error)}</em>` : ''
            const shot = s.screenshot
                ? ` <a href="${escapeHtml(s.screenshot)}"><img src="${escapeHtml(s.screenshot)}" class="thumb" alt="screenshot"></a>`
                : ''
            return `<li class="${s.status}">${mark} ${escapeHtml(s.name)}${err}${shot}</li>`
        })
        .join('\n')
    const banner = r.ok ? 'PASSED' : `FAILED (${escapeHtml(r.failureCategory ?? 'unknown')})`
    const cleanupWarn = r.cleanup.ok
        ? ''
        : `<p class="warn">⚠ Cleanup failed: ${r.cleanup.failed.map(escapeHtml).join(', ')} — leftover data may need manual removal.</p>`
    return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(r.suite)} ${escapeHtml(r.env)}</title>
<style>body{font:14px system-ui;margin:2rem}.passed{color:#137333}.failed{color:#c5221f}.warn{color:#b06000}video{max-width:100%}.thumb{max-height:60px;vertical-align:middle;margin-left:.5rem;border:1px solid #ccc}</style>
<h1>${banner}</h1><p>${escapeHtml(r.env)} · ${escapeHtml(r.role)} · ${escapeHtml(r.mode)}</p>${cleanupWarn}
<ul>${rows}</ul>
<video src="video.webm" controls></video>`
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
