import { CleanupClient } from '@/engine/cleanup'
import { resolveEnv, resolvePrEnv } from '@/engine/env'
import type { Vars } from '@/engine/settings'

// Delete tracked ids via the QA cleanup endpoints, authorized by a Clerk session
// JWT (Bearer). Usage flags:
//   --env/--pr, --token <clerk-jwt>, --studies a,b,c  --users d,e
// (--cookie is accepted as a legacy alias for --token.)
export async function cleanupCommand(opts: Record<string, string>, vars: Vars): Promise<void> {
    const env = opts.pr ? resolvePrEnv(Number(opts.pr), vars) : resolveEnv(opts.env ?? 'qa', vars)
    const client = new CleanupClient(env.baseURL, opts.token ?? opts.cookie ?? '')
    for (const id of (opts.studies ?? '').split(',').filter(Boolean)) client.trackStudy(id)
    for (const id of (opts.users ?? '').split(',').filter(Boolean)) client.trackUser(id)
    const result = await client.run()
    console.log(JSON.stringify(result))
    if (!result.ok) process.exitCode = 1
}
