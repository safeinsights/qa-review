import { MantineProvider } from '@mantine/core'
import React from 'react'
import { createRoot } from 'react-dom/client'
import '@mantine/core/styles.css'
import './editorial.css'
import { App } from './App'
import { editorialTheme } from './theme'

const root = document.getElementById('root')
if (!root) throw new Error('root element not found')

createRoot(root).render(
    <React.StrictMode>
        <MantineProvider theme={editorialTheme} forceColorScheme="light">
            <App />
        </MantineProvider>
    </React.StrictMode>
)
