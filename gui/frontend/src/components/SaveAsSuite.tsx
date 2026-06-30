import { useState } from 'react'
import { promoteSuite } from '../lib/ipc'
import type { ResultEnvelope } from '../lib/stepStream'

// After a green exploratory run, let the tester name + promote it. The skill is
// expected to have written the action trace to <bundleDir>/trace.json.
export function SaveAsSuite({ cwd, result }: { cwd: string; result: ResultEnvelope }) {
    const [name, setName] = useState('')
    const [status, setStatus] = useState('')
    const bundleDir = result.bundleDir as string | undefined

    const promote = async () => {
        if (!bundleDir) { setStatus('No bundle dir on result.'); return }
        setStatus('Generating suite + opening PR…')
        try {
            const pr = await promoteSuite(cwd, name, `${bundleDir}/trace.json`)
            setStatus('PR opened: ' + pr)
        } catch (e) {
            setStatus('Promote failed: ' + String(e))
        }
    }

    return (
        <div className="save-as-suite">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="suite-name (kebab-case)" />
            <button onClick={promote} disabled={!name}>Save as suite → PR</button>
            <div>{status}</div>
        </div>
    )
}
