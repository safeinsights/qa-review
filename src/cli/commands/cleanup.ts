import { resolveEnv, resolvePrEnv } from '@/engine/env'
import { CleanupClient } from '@/engine/cleanup'

// Delete tracked ids via the QA cleanup endpoints, authorized by the cookie
// passed in (e.g. from `qatest login`). Usage flags:
//   --env/--pr, --cookie <header>, --studies a,b,c  --users d,e
export async function cleanupCommand(opts: Record<string, string>): Promise<void> {
    const env = opts.pr ? resolvePrEnv(Number(opts.pr)) : resolveEnv(opts.env ?? 'qa')
    const client = new CleanupClient(env.baseURL, opts.cookie ?? '')
    for (const id of (opts.studies ?? '').split(',').filter(Boolean)) client.trackStudy(id)
    for (const id of (opts.users ?? '').split(',').filter(Boolean)) client.trackUser(id)
    const result = await client.run()
    console.log(JSON.stringify(result))
    if (!result.ok) process.exitCode = 1
}
