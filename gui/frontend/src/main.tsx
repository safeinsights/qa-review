import React from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import '@mantine/core/styles.css'
import './editorial.css'
import { editorialTheme } from './theme'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <MantineProvider theme={editorialTheme} forceColorScheme="light">
            <App />
        </MantineProvider>
    </React.StrictMode>,
)
