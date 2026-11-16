import { describe, expect, it } from 'vitest'
import { chromeLaunchOptions } from '@/engine/chrome-launch'

describe('chromeLaunchOptions', () => {
    it('drops the automation flags Cloudflare reads as a bot', () => {
        const opts = chromeLaunchOptions()
        expect(opts.channel).toBe('chrome')
        expect(opts.ignoreDefaultArgs).toEqual(['--enable-automation'])
        expect(opts.args).toContain('--disable-blink-features=AutomationControlled')
    })

    it('keeps caller args and options alongside the anti-bot flags', () => {
        const opts = chromeLaunchOptions({
            headless: false,
            args: ['--remote-debugging-port=9222'],
        })
        expect(opts.headless).toBe(false)
        expect(opts.args).toEqual([
            '--disable-blink-features=AutomationControlled',
            '--remote-debugging-port=9222',
        ])
    })
})
