import { useState } from 'react'
import { SuitesTab } from './components/SuitesTab'

export function App() {
    const [tab, setTab] = useState<'suites' | 'exploratory'>('suites')
    return (
        <div style={{ padding: '1rem', fontFamily: 'system-ui' }}>
            <h1>SafeInsights QA Runner</h1>
            <nav>
                <button onClick={() => setTab('suites')} disabled={tab === 'suites'}>Suites</button>
                <button onClick={() => setTab('exploratory')} disabled={tab === 'exploratory'}>Exploratory</button>
            </nav>
            {tab === 'suites' ? <SuitesTab /> : <p>Exploratory tab — see next task.</p>}
        </div>
    )
}
