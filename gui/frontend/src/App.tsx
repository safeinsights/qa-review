import { useState } from 'react'
import { SuitesTab } from './components/SuitesTab'
import { ExploratoryTab } from './components/ExploratoryTab'
import { SyncButton } from './components/SyncButton'

export function App() {
    const [tab, setTab] = useState<'suites' | 'exploratory'>('suites')
    return (
        <div style={{ padding: '1rem', fontFamily: 'system-ui' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <h1>SafeInsights QA Runner</h1>
                <SyncButton cwd=".." />
            </div>
            <nav>
                <button onClick={() => setTab('suites')} disabled={tab === 'suites'}>Suites</button>
                <button onClick={() => setTab('exploratory')} disabled={tab === 'exploratory'}>Exploratory</button>
            </nav>
            {tab === 'suites' ? <SuitesTab /> : <ExploratoryTab />}
        </div>
    )
}
