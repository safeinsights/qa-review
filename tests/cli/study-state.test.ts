import { describe, expect, it } from 'vitest'
import { studyStateCommand } from '@/cli/commands/study-state'

describe('qar study-state --job-status', () => {
    // An unknown env fails right after validation, so reaching that error proves the status passed.
    it.each(['CODE-REJECTED', 'RESULTS-VIEWED'])('accepts %s', async status => {
        await expect(
            studyStateCommand({ study: 's1', 'job-status': status, env: 'no-such-env' }, {})
        ).rejects.toThrow(/Unknown environment "no-such-env"/)
    })

    // Validation runs before the admin browser launches, so a typo fails instantly.
    it('rejects an unknown status before doing anything else', async () => {
        await expect(
            studyStateCommand({ study: 's1', 'job-status': 'CODE-DECLINED' }, {})
        ).rejects.toThrow(/--job-status must be one of .*CODE-REJECTED.* \(got "CODE-DECLINED"\)/)
    })
})
