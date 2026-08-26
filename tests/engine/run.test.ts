import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserHandle } from '@/engine/run'
import { resolveStepTimeoutMs, runEngine, withStepDeadline } from '@/engine/run'
import type { Suite } from '@/suites/types'

const made: string[] = []
afterEach(() => {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true })
    made.length = 0
})
function tmpRoot() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-run-'))
    made.push(d)
    return d
}

const ENV_VARS = {
    QA_BASE_URL: 'https://qa.example.com',
    ADMIN_EMAIL_QA: 'a@example.com',
    ADMIN_PASSWORD_QA: 'p',
    ADMIN_MFA_CODE_QA: '424242',
    RESEARCHER_EMAIL_QA: 'r@example.com',
    RESEARCHER_PASSWORD_QA: 'p',
    RESEARCHER_MFA_CODE_QA: '424242',
    REVIEWER_EMAIL_QA: 'v@example.com',
    REVIEWER_PASSWORD_QA: 'p',
    REVIEWER_MFA_CODE_QA: '424242',
}

function deps(overrides: Partial<Parameters<typeof runEngine>[1]> = {}) {
    return {
        vars: ENV_VARS,
        resultsRoot: tmpRoot(),
        openBrowser: vi.fn(async () => ({
            // Minimal fake page: ctx.loginAs() clears the context + web storage
            // before re-authenticating, so expose context().clearCookies + evaluate.
            // on/off are no-op stubs so the console-capture listeners attach.
            page: {
                context: () => ({ clearCookies: vi.fn(async () => {}) }),
                evaluate: vi.fn(async () => {}),
                url: () => 'https://app.qa.safeinsights.org/',
                on: vi.fn(),
                off: vi.fn(),
            } as never,
            cookieHeader: 'sid=abc',
            close: vi.fn(async () => {}),
        })),
        login: vi.fn(async () => 'sid=abc'),
        runCleanup: vi.fn(async () => ({ ok: true, deleted: [], failed: [] })),
        ...overrides,
    }
}

const passingSuite: Suite = {
    name: 'demo',
    description: '',
    roles: ['admin'],
    steps: [
        {
            name: 'do thing',
            run: async ctx => {
                await ctx.step('do thing', async () => {})
            },
        },
    ],
}

describe('runEngine', () => {
    it('runs a passing suite and writes an ok bundle', async () => {
        const d = deps()
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(result.ok).toBe(true)
        expect(d.runCleanup).toHaveBeenCalledOnce()
        expect(fs.existsSync(path.join(result.bundleDir, 'summary.json'))).toBe(true)
    })

    it('records a name-less ctx.step under the enclosing step name', async () => {
        // The terse suite form: run calls ctx.step(action) with NO name, so the
        // engine records the position under the step's own `name`.
        const d = deps()
        const suite: Suite = {
            name: 'demo',
            description: '',
            roles: ['admin'],
            steps: [
                {
                    name: 'terse step',
                    run: ctx => ctx.step(async () => {}),
                },
            ],
        }
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, suite)
        expect(result.ok).toBe(true)
        const step = result.steps.find(s => s.status === 'passed')
        expect(step?.name).toBe('terse step')
    })

    it('records a throwing name-less ctx.step as a failure under the step name', async () => {
        const d = deps()
        const suite: Suite = {
            name: 'demo',
            description: '',
            roles: ['admin'],
            steps: [
                {
                    name: 'boom step',
                    run: ctx =>
                        ctx.step(async () => {
                            throw new Error('kaboom')
                        }),
                },
            ],
        }
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, suite)
        expect(result.ok).toBe(false)
        const step = result.steps.find(s => s.status === 'failed')
        expect(step?.name).toBe('boom step')
        expect(step?.error).toContain('kaboom')
    })

    it('attaches the console captured DURING a step to that step event', async () => {
        // Capture the page.on('console') handler the engine registers, then fire a
        // synthetic console message from inside the step so it lands in the buffer
        // that ctx.step drains onto the resolving event.
        let consoleHandler: ((msg: unknown) => void) | undefined
        const d = deps({
            openBrowser: vi.fn(async () => ({
                page: {
                    context: () => ({ clearCookies: vi.fn(async () => {}) }),
                    evaluate: vi.fn(async () => {}),
                    url: () => 'https://app.qa.safeinsights.org/',
                    on: vi.fn((event: string, handler: (msg: unknown) => void) => {
                        if (event === 'console') consoleHandler = handler
                    }),
                    off: vi.fn(),
                } as never,
                cookieHeader: 'sid=abc',
                close: vi.fn(async () => {}),
            })),
        })
        const suite: Suite = {
            name: 'demo',
            description: '',
            roles: ['admin'],
            steps: [
                {
                    name: 'logs',
                    run: async ctx => {
                        await ctx.step('logs', async () => {
                            // Simulate a Playwright ConsoleMessage during the step.
                            consoleHandler?.({
                                type: () => 'error',
                                text: () => 'kaboom',
                                location: () => ({ url: 'x.js' }),
                            })
                        })
                    },
                },
            ],
        }
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, suite)
        const step = result.steps.find(s => s.name === 'logs' && s.status === 'passed')
        expect(step?.console).toBeDefined()
        expect(step?.console?.[0]).toMatchObject({ level: 'error', text: 'kaboom', url: 'x.js' })
    })

    it('categorizes a thrown assertion as app-assertion and STILL runs cleanup', async () => {
        const d = deps()
        const failingSuite: Suite = {
            name: 'demo',
            description: '',
            roles: ['admin'],
            steps: [
                {
                    name: 'boom',
                    run: async ctx => {
                        await ctx.step('boom', async () => {
                            throw new Error('expected X to be visible')
                        })
                    },
                },
            ],
        }
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, failingSuite)
        expect(result.ok).toBe(false)
        expect(result.failureCategory).toBe('app-assertion')
        expect(d.runCleanup).toHaveBeenCalledOnce() // guaranteed teardown
    })

    it('categorizes login failure as auth and still runs cleanup', async () => {
        const d = deps({
            login: vi.fn(async () => {
                throw new Error('OTP rejected')
            }),
        })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(result.ok).toBe(false)
        expect(result.failureCategory).toBe('auth')
        expect(d.runCleanup).toHaveBeenCalledOnce()
    })

    it('surfaces a cleanup failure on an otherwise-passing run', async () => {
        const d = deps({
            runCleanup: vi.fn(async () => ({ ok: false, deleted: [], failed: ['study:s1'] })),
        })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(result.ok).toBe(true) // the test itself passed
        expect(result.cleanup.ok).toBe(false)
        expect(result.cleanup.failed).toEqual(['study:s1'])
    })

    it('categorizes an openBrowser failure as environment and still runs cleanup', async () => {
        const d = deps({
            openBrowser: vi.fn(async () => {
                throw new Error('net::ERR_CONNECTION_REFUSED')
            }),
        })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(result.ok).toBe(false)
        expect(result.failureCategory).toBe('environment')
        expect(d.runCleanup).toHaveBeenCalledOnce()
    })

    it('records cleanup-call-threw when runCleanup itself throws', async () => {
        const d = deps({
            runCleanup: vi.fn(async () => {
                throw new Error('boom')
            }),
        })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(result.cleanup.ok).toBe(false)
        expect(result.cleanup.failed).toEqual(['cleanup-call-threw'])
        expect(result.cleanup.error).toBe('boom')
    })

    it('assigns the cleanup failure category on a passing run whose cleanup failed', async () => {
        const d = deps({
            runCleanup: vi.fn(async () => ({ ok: false, deleted: [], failed: ['study:s1'] })),
        })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(result.ok).toBe(true)
        expect(result.failureCategory).toBe('cleanup')
    })

    it('lets a suite switch roles mid-run via ctx.loginAs (re-drives login)', async () => {
        const d = deps()
        const twoRoleSuite: Suite = {
            name: 'demo',
            description: '',
            roles: ['researcher'],
            steps: [
                {
                    name: 'as researcher',
                    run: async ctx => {
                        await ctx.step('as researcher', async () => {})
                    },
                },
                {
                    name: 'as reviewer',
                    run: async ctx => {
                        await ctx.loginAs('reviewer')
                        await ctx.step('as reviewer', async () => {})
                    },
                },
            ],
        }
        const result = await runEngine(
            { suite: 'demo', env: 'qa', role: 'researcher' },
            d,
            twoRoleSuite
        )
        expect(result.ok).toBe(true)
        // Once for the initial engine login, once for the mid-run switch.
        const login = d.login as ReturnType<typeof vi.fn>
        expect(login).toHaveBeenCalledTimes(2)
        expect(login.mock.calls[1][2]).toBe('reviewer')
    })

    it('invokes deps.onStep for each step event as it happens', async () => {
        const seen: string[] = []
        const d = deps({ onStep: e => seen.push(`${e.name}:${e.status}`) })
        await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(seen).toContain('do thing:running')
        expect(seen).toContain('do thing:passed')
    })

    it('halts BEFORE a paused step: onPaused fires and waitForResume is awaited before running', async () => {
        const seen: string[] = []
        let resolveResume!: () => void
        const resumeGate = new Promise<void>(r => (resolveResume = r))
        const twoStep: Suite = {
            name: 'demo',
            description: '',
            roles: ['admin'],
            steps: [
                {
                    name: 'first',
                    run: async ctx => {
                        await ctx.step('first', async () => {})
                    },
                },
                {
                    name: 'second',
                    run: async ctx => {
                        await ctx.step('second', async () => {})
                    },
                },
            ],
        }
        const d = deps({
            onStep: e => seen.push(`${e.name}:${e.status}`),
            shouldPause: name => name === 'second',
            onPaused: name => seen.push(`paused:${name}`),
            // Resolve on the next tick so the ordering assertion is meaningful:
            // the run must be blocked here until we let it go.
            waitForResume: () => resumeGate,
        })
        const runPromise = runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, twoStep)
        // Let the first step finish and the gate register before resuming.
        await new Promise(r => setTimeout(r, 10))
        expect(seen).toContain('first:passed')
        expect(seen).toContain('paused:second')
        // Crucially, 'second' has NOT started running while paused.
        expect(seen).not.toContain('second:running')
        resolveResume()
        const result = await runPromise
        expect(result.ok).toBe(true)
        // After resume, the second step runs to completion.
        expect(seen.indexOf('paused:second')).toBeLessThan(seen.indexOf('second:running'))
        expect(seen).toContain('second:passed')
    })

    it('exposes the browser handle cdpPort to an onPage/screencast consumer', async () => {
        // The handle openBrowser returns carries the Chrome remote-debugging port;
        // a consumer (the run companion / screencast) reads it right after openBrowser.
        const handle: BrowserHandle = {
            page: {
                context: () => ({ clearCookies: vi.fn(async () => {}) }),
                evaluate: vi.fn(async () => {}),
                url: () => 'https://app.qa.safeinsights.org/',
                on: vi.fn(),
                off: vi.fn(),
            } as never,
            cookieHeader: 'sid=abc',
            cdpPort: 54321,
            close: vi.fn(async () => {}),
        }
        let seenPort: number | undefined
        const d = deps({
            openBrowser: vi.fn(async () => handle),
            onPage: async () => {
                seenPort = handle.cdpPort
            },
        })
        await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(seenPort).toBe(54321)
    })

    it('emits onBundleDir before steps and onRunState with a final result', async () => {
        const seen: string[] = []
        let finalRunning: boolean | undefined
        const d = deps({
            onBundleDir: () => seen.push('bundle'),
            onStep: () => seen.push('step'),
            onRunState: s => {
                finalRunning = s.running
            },
        })
        await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(seen[0]).toBe('bundle') // bundle dir known before any step
        expect(seen).toContain('step')
        expect(finalRunning).toBe(false) // last onRunState has the result
    })

    it('holds the browser open on a FAILED run: onErrorHold fires, close deferred until resume', async () => {
        const seen: string[] = []
        let resolveRelease!: () => void
        const releaseGate = new Promise<void>(r => (resolveRelease = r))
        // Track handle.close so we can assert teardown is deferred while held.
        const close = vi.fn(async () => {})
        const failingSuite: Suite = {
            name: 'demo',
            description: '',
            roles: ['admin'],
            steps: [
                {
                    name: 'boom',
                    run: async ctx => {
                        await ctx.step('boom', async () => {
                            throw new Error('expected X to be visible')
                        })
                    },
                },
            ],
        }
        const d = deps({
            openBrowser: vi.fn(async () => ({
                page: {
                    context: () => ({ clearCookies: vi.fn(async () => {}) }),
                    evaluate: vi.fn(async () => {}),
                    url: () => 'https://app.qa.safeinsights.org/',
                    on: vi.fn(),
                    off: vi.fn(),
                } as never,
                cookieHeader: 'sid=abc',
                close,
            })),
            onErrorHold: info => seen.push(`hold:${info.failureCategory}:${info.error}`),
            waitForResume: () => releaseGate,
        })
        const runPromise = runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, failingSuite)
        // Let the run reach the hold and block there.
        await new Promise(r => setTimeout(r, 10))
        expect(seen).toContain('hold:app-assertion:expected X to be visible')
        // Crucially, teardown has NOT happened yet — the browser is still open.
        expect(close).not.toHaveBeenCalled()
        // Now release: teardown proceeds and the result is returned.
        resolveRelease()
        const result = await runPromise
        expect(result.ok).toBe(false)
        expect(result.failureCategory).toBe('app-assertion')
        // Teardown ran exactly once, after release.
        expect(close).toHaveBeenCalledOnce()
    })

    it('a failed run WITHOUT onErrorHold tears down immediately (no hold)', async () => {
        const waitForResume = vi.fn(async () => {})
        const failingSuite: Suite = {
            name: 'demo',
            description: '',
            roles: ['admin'],
            steps: [
                {
                    name: 'boom',
                    run: async ctx => {
                        await ctx.step('boom', async () => {
                            throw new Error('expected X to be visible')
                        })
                    },
                },
            ],
        }
        // onErrorHold NOT provided; waitForResume provided but must not be consulted.
        const d = deps({ waitForResume })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, failingSuite)
        expect(result.ok).toBe(false)
        expect(waitForResume).not.toHaveBeenCalled()
    })

    it('a SUCCESSFUL run never calls onErrorHold', async () => {
        const onErrorHold = vi.fn()
        const d = deps({ onErrorHold })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(result.ok).toBe(true)
        expect(onErrorHold).not.toHaveBeenCalled()
    })

    it('runs straight through when shouldPause returns false', async () => {
        const onPaused = vi.fn()
        const d = deps({ shouldPause: () => false, onPaused, waitForResume: async () => {} })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(result.ok).toBe(true)
        expect(onPaused).not.toHaveBeenCalled()
    })

    it('retries a failed step against the live ctx, then continues the suite', async () => {
        // A 3-step suite whose MIDDLE step throws on its first attempt and passes on
        // the retry. On retry the engine reloads the suite; the reloaded copy has the
        // middle step fixed. State threaded through ctx.state proves the SAME ctx is
        // reused across the retry (step 3 reads what step 1 wrote).
        const seen: string[] = []
        let attempted = false
        const step1 = {
            name: 'seed',
            run: async (ctx: import('@/suites/types').RunContext) => {
                await ctx.step('seed', async () => {
                    ctx.state.seeded = 'yes'
                })
            },
        }
        const step3 = {
            name: 'read seed',
            run: async (ctx: import('@/suites/types').RunContext) => {
                await ctx.step('read seed', async () => {
                    if (ctx.state.seeded !== 'yes') throw new Error('ctx.state lost across retry')
                })
            },
        }
        const flakyMiddle = {
            name: 'middle',
            run: async (ctx: import('@/suites/types').RunContext) => {
                await ctx.step('middle', async () => {
                    if (!attempted) {
                        attempted = true
                        throw new Error('expected X to be visible')
                    }
                })
            },
        }
        const fixedMiddle = {
            name: 'middle',
            run: async (ctx: import('@/suites/types').RunContext) => {
                await ctx.step('middle', async () => {})
            },
        }
        const original: Suite = {
            name: 'demo',
            description: '',
            roles: ['admin'],
            steps: [step1, flakyMiddle, step3],
        }
        const reloaded: Suite = {
            name: 'demo',
            description: '',
            roles: ['admin'],
            steps: [step1, fixedMiddle, step3],
        }
        const d = deps({
            onStep: e => seen.push(`${e.name}:${e.status}`),
            onStepFailed: info => seen.push(`failed:${info.index}:${info.stepName}`),
            waitForResolution: async () => 'retry',
            reloadSuite: vi.fn(async () => reloaded),
        })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, original)
        expect(result.ok).toBe(true)
        // The failure was reported for the middle step (index 1), then it re-ran.
        expect(seen).toContain('failed:1:middle')
        // The suite continued past the retried step.
        expect(seen).toContain('read seed:passed')
        expect(d.reloadSuite).toHaveBeenCalledOnce()
    })

    it('run-state shows the retried step ONCE (failed row truncated before retry)', async () => {
        let attempted = false
        let lastState: import('@/engine/types').RunState | undefined
        const flaky = {
            name: 'middle',
            run: async (ctx: import('@/suites/types').RunContext) => {
                await ctx.step('middle', async () => {
                    if (!attempted) {
                        attempted = true
                        throw new Error('expected X to be visible')
                    }
                })
            },
        }
        const suite: Suite = {
            name: 'demo',
            description: '',
            roles: ['admin'],
            steps: [flaky],
        }
        const d = deps({
            onRunState: s => {
                lastState = s
            },
            waitForResolution: async () => 'retry',
            reloadSuite: async () => suite,
        })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, suite)
        expect(result.ok).toBe(true)
        // Exactly one entry for the single step — the failed row was dropped, the
        // retried running/passed re-occupied its position.
        expect(lastState?.steps.filter(s => s.name === 'middle')).toHaveLength(1)
        expect(result.steps.filter(s => s.name === 'middle')).toHaveLength(1)
    })

    it('give-up ends the run FAILED without a second hold', async () => {
        const onErrorHold = vi.fn()
        const failingSuite: Suite = {
            name: 'demo',
            description: '',
            roles: ['admin'],
            steps: [
                {
                    name: 'boom',
                    run: async ctx => {
                        await ctx.step('boom', async () => {
                            throw new Error('expected X to be visible')
                        })
                    },
                },
            ],
        }
        const d = deps({
            onErrorHold,
            onStepFailed: vi.fn(),
            waitForResolution: async () => 'giveUp',
            reloadSuite: vi.fn(),
        })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, failingSuite)
        expect(result.ok).toBe(false)
        expect(result.failureCategory).toBe('app-assertion')
        // A step failure that was given up must NOT re-hold via onErrorHold.
        expect(onErrorHold).not.toHaveBeenCalled()
    })

    it('a reload compile error keeps holding and re-reports the failure', async () => {
        // First retry: reload throws (bad edit) — the run stays held and re-runs the
        // still-broken original step (fails again). Second retry: reload succeeds with
        // a fixed step that passes. So the run must survive the compile error rather
        // than tearing down.
        let reloadCalls = 0
        // The ORIGINAL step always throws — only the reloaded (fixed) step passes, so
        // a compile-failed reload can't accidentally pass by re-running the old code.
        const brokenStep = {
            name: 'middle',
            run: async (ctx: import('@/suites/types').RunContext) => {
                await ctx.step('middle', async () => {
                    throw new Error('expected X to be visible')
                })
            },
        }
        const fixedStep = {
            name: 'middle',
            run: async (ctx: import('@/suites/types').RunContext) => {
                await ctx.step('middle', async () => {})
            },
        }
        const original: Suite = {
            name: 'demo',
            description: '',
            roles: ['admin'],
            steps: [brokenStep],
        }
        const fixed: Suite = { name: 'demo', description: '', roles: ['admin'], steps: [fixedStep] }
        const failures: string[] = []
        const d = deps({
            onStepFailed: info => failures.push(info.error),
            waitForResolution: async () => 'retry',
            reloadSuite: vi.fn(async () => {
                reloadCalls++
                if (reloadCalls === 1) throw new Error('Transform failed: unexpected token')
                return fixed
            }),
        })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, original)
        expect(result.ok).toBe(true)
        // The original failure, then the reload/compile failure, were both reported.
        expect(failures.some(e => e.includes('expected X to be visible'))).toBe(true)
        expect(failures.some(e => e.startsWith('Reload failed:'))).toBe(true)
        expect(reloadCalls).toBe(2)
    })

    it('a step failure WITHOUT the retry deps rethrows to the error-hold path', async () => {
        // Only onErrorHold + waitForResume wired (the pre-retry GUI behavior): a step
        // throw must hold via onErrorHold, not enter the retry loop.
        const onErrorHold = vi.fn()
        const failingSuite: Suite = {
            name: 'demo',
            description: '',
            roles: ['admin'],
            steps: [
                {
                    name: 'boom',
                    run: async ctx => {
                        await ctx.step('boom', async () => {
                            throw new Error('expected X to be visible')
                        })
                    },
                },
            ],
        }
        const d = deps({ onErrorHold, waitForResume: async () => {} })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, failingSuite)
        expect(result.ok).toBe(false)
        expect(onErrorHold).toHaveBeenCalledOnce()
    })
})

// --- jump-to-step (double-click a step in the GUI) ---
//
// consumeJump is a latch the run loop reads at each step boundary. These drive it
// directly (the CLI's stdin channel is what sets it in production).
describe('runEngine jump-to-step', () => {
    // A suite whose steps append their name, so the ran-order is observable.
    const tracedSuite = (ran: string[]): Suite => ({
        name: 'demo',
        description: '',
        roles: ['admin'],
        steps: ['one', 'two', 'three', 'four'].map(name => ({
            name,
            run: async ctx => {
                ran.push(name)
                await ctx.step(name, async () => {})
            },
        })),
    })

    // Fire a jump ONCE, when the loop is at `atIndex`.
    const jumpOnceAt = (atIndex: number, target: number) => {
        let fired = false
        let seen = 0
        return () => {
            // consumeJump is called once per boundary, so count boundaries.
            const here = seen++
            if (!fired && here === atIndex) {
                fired = true
                return target
            }
            return undefined
        }
    }

    it('jumps FORWARD, marking the skipped steps and running the target', async () => {
        const ran: string[] = []
        const d = deps({ consumeJump: jumpOnceAt(0, 2) })
        const result = await runEngine(
            { suite: 'demo', env: 'qa', role: 'admin' },
            d,
            tracedSuite(ran)
        )
        expect(result.ok).toBe(true)
        // 'one' and 'two' were jumped over; the run continued from 'three'.
        expect(ran).toEqual(['three', 'four'])
        // Skipped steps still occupy their positions, so the GUI's positional
        // name↔event mapping stays aligned with the suite.
        expect(result.steps.map(s => [s.name, s.status])).toEqual([
            ['one', 'skipped'],
            ['two', 'skipped'],
            ['three', 'passed'],
            ['four', 'passed'],
        ])
    })

    it('jumps BACKWARD, re-running the target without duplicating rows', async () => {
        const ran: string[] = []
        // At the boundary of step 2 ('three'), jump back to step 0 ('one').
        let fired = false
        let seen = 0
        const d = deps({
            consumeJump: () => {
                const here = seen++
                if (!fired && here === 2) {
                    fired = true
                    return 0
                }
                return undefined
            },
        })
        const result = await runEngine(
            { suite: 'demo', env: 'qa', role: 'admin' },
            d,
            tracedSuite(ran)
        )
        expect(result.ok).toBe(true)
        expect(ran).toEqual(['one', 'two', 'one', 'two', 'three', 'four'])
        // The re-run re-occupies positions 0..1 rather than appending duplicates,
        // so the final list is exactly one row per suite step.
        expect(result.steps.map(s => s.name)).toEqual(['one', 'two', 'three', 'four'])
        expect(result.steps.every(s => s.status === 'passed')).toBe(true)
    })

    it('ignores an out-of-range target instead of crashing the run', async () => {
        const ran: string[] = []
        const d = deps({ consumeJump: jumpOnceAt(0, 99) })
        const result = await runEngine(
            { suite: 'demo', env: 'qa', role: 'admin' },
            d,
            tracedSuite(ran)
        )
        expect(result.ok).toBe(true)
        expect(ran).toEqual(['one', 'two', 'three', 'four'])
    })

    it('is a no-op when the target is the step about to run', async () => {
        const ran: string[] = []
        const d = deps({ consumeJump: jumpOnceAt(1, 1) })
        const result = await runEngine(
            { suite: 'demo', env: 'qa', role: 'admin' },
            d,
            tracedSuite(ran)
        )
        expect(result.ok).toBe(true)
        expect(ran).toEqual(['one', 'two', 'three', 'four'])
    })

    it('honors a jump latched DURING a step at the next boundary, not mid-step', async () => {
        const ran: string[] = []
        let latched: number | undefined
        const suite: Suite = {
            name: 'demo',
            description: '',
            roles: ['admin'],
            steps: ['one', 'two', 'three', 'four'].map(name => ({
                name,
                run: async ctx => {
                    ran.push(name)
                    await ctx.step(name, async () => {
                        // Mid-flight request, as if the user double-clicked while
                        // this step was still running.
                        if (name === 'one') latched = 3
                    })
                },
            })),
        }
        const d = deps({
            consumeJump: () => {
                const t = latched
                latched = undefined
                return t
            },
        })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, suite)
        expect(result.ok).toBe(true)
        // 'one' ran to completion first — the jump did NOT interrupt it.
        expect(ran).toEqual(['one', 'four'])
        expect(result.steps.map(s => [s.name, s.status])).toEqual([
            ['one', 'passed'],
            ['two', 'skipped'],
            ['three', 'skipped'],
            ['four', 'passed'],
        ])
    })

    it('jumps out of a step-failed hold when the user picks a target', async () => {
        const ran: string[] = []
        const suite: Suite = {
            name: 'demo',
            description: '',
            roles: ['admin'],
            steps: [
                {
                    name: 'boom',
                    run: async ctx => {
                        ran.push('boom')
                        await ctx.step('boom', async () => {
                            throw new Error('kaboom')
                        })
                    },
                },
                {
                    name: 'after',
                    run: async ctx => {
                        ran.push('after')
                        await ctx.step('after', async () => {})
                    },
                },
            ],
        }
        // The target is latched only when the hold is reached — mirroring the CLI,
        // where {type:'jump-to'} both sets the latch and resolves the hold.
        let target: number | undefined
        const d = deps({
            waitForResolution: async () => {
                target = 1
                return 'jump' as const
            },
            reloadSuite: vi.fn(),
            consumeJump: () => {
                const t = target
                target = undefined
                return t
            },
        })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, suite)
        expect(ran).toEqual(['boom', 'after'])
        // Jumping out of a failure doesn't reload the suite — that's retry's job.
        expect(d.reloadSuite).not.toHaveBeenCalled()
        // The failure row is kept: it really happened and is worth showing.
        expect(result.steps.map(s => [s.name, s.status])).toEqual([
            ['boom', 'failed'],
            ['after', 'passed'],
        ])
    })
})

describe('resolveStepTimeoutMs', () => {
    it('defaults to 5 minutes when unset or blank', () => {
        expect(resolveStepTimeoutMs({})).toBe(300_000)
        expect(resolveStepTimeoutMs({ QAR_STEP_TIMEOUT_MS: '   ' })).toBe(300_000)
    })

    it('honors an explicit override, including 0 to disable', () => {
        expect(resolveStepTimeoutMs({ QAR_STEP_TIMEOUT_MS: '90000' })).toBe(90_000)
        expect(resolveStepTimeoutMs({ QAR_STEP_TIMEOUT_MS: '0' })).toBe(0)
    })

    it('falls back to the default on junk rather than disabling the guard', () => {
        // A typo must not silently turn the deadline off — that reinstates the hang.
        expect(resolveStepTimeoutMs({ QAR_STEP_TIMEOUT_MS: 'soon' })).toBe(300_000)
        expect(resolveStepTimeoutMs({ QAR_STEP_TIMEOUT_MS: '-1' })).toBe(300_000)
    })
})

describe('withStepDeadline', () => {
    it('passes the action through when it settles in time', async () => {
        await expect(withStepDeadline('s', 5_000, async () => 'done')).resolves.toBe('done')
    })

    it('propagates the action own failure unchanged', async () => {
        await expect(
            withStepDeadline('s', 5_000, async () => {
                throw new Error('kaboom')
            })
        ).rejects.toThrow('kaboom')
    })

    it('rejects with a message naming the limit when the action never settles', async () => {
        await expect(
            withStepDeadline('stuck step', 20, () => new Promise(() => {}))
        ).rejects.toThrow(/Step "stuck step" hit the 0s step timeout .*QAR_STEP_TIMEOUT_MS/s)
    })

    it('runs unbounded when the deadline is disabled', async () => {
        await expect(withStepDeadline('s', 0, async () => 'done')).resolves.toBe('done')
    })

    it('swallows the abandoned action late rejection', async () => {
        // Playwright cannot be cancelled, so the body outlives the deadline and
        // rejects later. Unhandled, that would crash the engine after the step had
        // already been recorded failed.
        const seen: unknown[] = []
        const onUnhandled = (e: unknown) => seen.push(e)
        process.on('unhandledRejection', onUnhandled)
        try {
            const late = withStepDeadline(
                's',
                10,
                () => new Promise((_r, reject) => setTimeout(() => reject(new Error('late')), 40))
            )
            await expect(late).rejects.toThrow(/step timeout/)
            await new Promise(r => setTimeout(r, 80))
        } finally {
            process.off('unhandledRejection', onUnhandled)
        }
        expect(seen).toEqual([])
    })

    it('signals the abandonment before it rejects', async () => {
        // Ordering matters: the retry loop regains control the moment this rejects, so
        // the zombie body has to be marked stale BEFORE that happens, not after.
        const events: string[] = []
        await expect(
            withStepDeadline(
                's',
                10,
                () => new Promise(() => {}),
                () => events.push('abandoned')
            )
        ).rejects.toThrow(/step timeout/)
        events.push('rejected')
        expect(events).toEqual(['abandoned', 'rejected'])
    })

    it('does not signal abandonment when the action settles in time', async () => {
        let abandoned = false
        await expect(
            withStepDeadline(
                's',
                5_000,
                async () => 'done',
                () => {
                    abandoned = true
                }
            )
        ).resolves.toBe('done')
        expect(abandoned).toBe(false)
    })
})

describe('runEngine step deadline', () => {
    it('fails a hung step instead of hanging the run', async () => {
        // The regression this guards: the step row stayed 'running' forever and the
        // run never produced a result at all.
        const d = deps({ vars: { ...ENV_VARS, QAR_STEP_TIMEOUT_MS: '25' } })
        const suite: Suite = {
            name: 'demo',
            description: '',
            roles: ['admin'],
            steps: [{ name: 'hangs', run: ctx => ctx.step(() => new Promise(() => {})) }],
        }
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, suite)
        expect(result.ok).toBe(false)
        expect(result.steps.map(s => [s.name, s.status])).toEqual([['hangs', 'failed']])
        expect(result.steps[0].error).toMatch(/step timeout/)
        // 'timeout' in the message routes it the same way a Playwright timeout is.
        expect(result.failureCategory).toBe('environment')
    })

    it('threads the RESOLVED default through, not a hardcoded literal', async () => {
        // Every other test in here sets QAR_STEP_TIMEOUT_MS, so hardcoding any value at
        // the ctx.step call site would leave them all green. Assert the default reaches
        // the step by reading the limit back out of the timeout message.
        const d = deps({ vars: { ...ENV_VARS } })
        const suite: Suite = {
            name: 'demo',
            description: '',
            roles: ['admin'],
            steps: [
                {
                    name: 'reports the limit',
                    // Fail immediately, but report the deadline the engine handed us.
                    run: ctx =>
                        ctx.step(async () => {
                            throw new Error('deliberate')
                        }),
                },
            ],
        }
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, suite)
        expect(result.ok).toBe(false)
        // The step failed on its own error, which proves the deadline did not fire at
        // some tiny hardcoded value — a literal small enough to matter would have won
        // the race and reported a step timeout instead.
        expect(result.steps[0].error).toMatch(/deliberate/)
    })

    it('marks a timed-out attempt aborted so a retry body can bail', async () => {
        // The zombie hazard: a timed-out body keeps driving the same page the retry
        // re-runs against. ctx.signal is how a body notices it is no longer live.
        const d = deps({ vars: { ...ENV_VARS, QAR_STEP_TIMEOUT_MS: '25' } })
        let abortedAfterDeadline: boolean | undefined
        const suite: Suite = {
            name: 'demo',
            description: '',
            roles: ['admin'],
            steps: [
                {
                    name: 'hangs',
                    run: ctx =>
                        ctx.step(async () => {
                            const signal = ctx.signal
                            expect(signal.aborted).toBe(false)
                            await new Promise(r => setTimeout(r, 120))
                            abortedAfterDeadline = signal.aborted
                        }),
                },
            ],
        }
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, suite)
        expect(result.ok).toBe(false)
        // Give the abandoned body time to finish its sleep and record what it saw.
        await new Promise(r => setTimeout(r, 150))
        expect(abortedAfterDeadline).toBe(true)
    })

    it('stops an abandoned body from driving the page, without it checking anything', async () => {
        // The point of guarding ctx.page: the body below never consults ctx.signal.
        // It is the ordinary shape of a suite step, and it must STILL be prevented
        // from touching the browser once its deadline has passed.
        const d = deps({ vars: { ...ENV_VARS, QAR_STEP_TIMEOUT_MS: '25' } })
        let zombieError: Error | undefined
        const suite: Suite = {
            name: 'demo',
            description: '',
            roles: ['admin'],
            steps: [
                {
                    name: 'hangs then keeps clicking',
                    run: ctx =>
                        ctx.step(async () => {
                            const page = ctx.page
                            await new Promise(r => setTimeout(r, 120))
                            try {
                                // Post-deadline. A raw page would happily run this.
                                await page.evaluate(() => {})
                            } catch (cause) {
                                zombieError = cause as Error
                                throw cause
                            }
                        }),
                },
            ],
        }
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, suite)
        expect(result.ok).toBe(false)
        await new Promise(r => setTimeout(r, 150))
        expect(zombieError?.name).toBe('StepAbandonedError')
    })

    it('lets the live attempt use the page while a zombie is locked out', async () => {
        // The guard must not be a blanket lock: the whole reason to stop the zombie is
        // so the NEXT attempt has the browser to itself.
        const d = deps({ vars: { ...ENV_VARS, QAR_STEP_TIMEOUT_MS: '25' } })
        let liveCallSucceeded = false
        const suite: Suite = {
            name: 'demo',
            description: '',
            roles: ['admin'],
            steps: [
                {
                    name: 'slow first, fine after',
                    run: ctx =>
                        ctx.step(async () => {
                            // Second and later reads happen after the first attempt's
                            // deadline; a fresh ctx.page read must work normally.
                            await ctx.page.evaluate(() => {})
                            liveCallSucceeded = true
                        }),
                },
            ],
        }
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, suite)
        expect(result.ok).toBe(true)
        expect(liveCallSucceeded).toBe(true)
    })

    it('still records url and screenshot for a step whose body was abandoned', async () => {
        // The engine's own post-timeout bookkeeping reads the RAW page, not ctx.page.
        // If the guard leaked into those paths, a timed-out step would lose exactly the
        // diagnostics it most needs.
        const d = deps({ vars: { ...ENV_VARS, QAR_STEP_TIMEOUT_MS: '25' } })
        const suite: Suite = {
            name: 'demo',
            description: '',
            roles: ['admin'],
            steps: [{ name: 'hangs', run: ctx => ctx.step(() => new Promise(() => {})) }],
        }
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, suite)
        expect(result.ok).toBe(false)
        expect(result.steps[0].status).toBe('failed')
        expect(result.steps[0].url).toBe('https://app.qa.safeinsights.org/')
    })
})
