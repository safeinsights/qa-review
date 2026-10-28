import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onGuiGone, pidAlive } from '@/engine/gui-parent'

describe('onGuiGone', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('stops the child once the GUI process is gone, and only once', () => {
        let alive = true
        const gone = vi.fn()
        onGuiGone(gone, { QAR_GUI_PID: '4242' }, () => alive, 1_000)
        vi.advanceTimersByTime(3_000)
        expect(gone).not.toHaveBeenCalled()
        alive = false
        vi.advanceTimersByTime(5_000)
        expect(gone).toHaveBeenCalledTimes(1)
    })

    it('does nothing for a session started by hand, with no GUI pid', () => {
        const isAlive = vi.fn(() => false)
        const gone = vi.fn()
        onGuiGone(gone, {}, isAlive, 1_000)
        onGuiGone(gone, { QAR_GUI_PID: 'not-a-pid' }, isAlive, 1_000)
        vi.advanceTimersByTime(5_000)
        expect(isAlive).not.toHaveBeenCalled()
        expect(gone).not.toHaveBeenCalled()
    })

    it('can be stopped before the GUI exits', () => {
        const gone = vi.fn()
        const unwatch = onGuiGone(gone, { QAR_GUI_PID: '4242' }, () => false, 1_000)
        unwatch()
        vi.advanceTimersByTime(5_000)
        expect(gone).not.toHaveBeenCalled()
    })
})

describe('pidAlive', () => {
    it('sees this process and not a pid that cannot exist', () => {
        expect(pidAlive(process.pid)).toBe(true)
        expect(pidAlive(2 ** 30)).toBe(false)
    })
})
