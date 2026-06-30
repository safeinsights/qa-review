import { createTheme, type MantineColorsTuple } from '@mantine/core'

// Deep-teal accent ramp (light editorial palette). Mantine needs a 10-shade
// tuple; shade 8 is our primary "ink teal".
const teal: MantineColorsTuple = [
    '#e7f3f0',
    '#c8e4dd',
    '#9fd0c5',
    '#71bcab',
    '#4ba894',
    '#2c9580',
    '#1c8270',
    '#136b5c', // primary
    '#0c574a',
    '#053f35',
]

export const editorialTheme = createTheme({
    fontFamily: '"Newsreader", Georgia, "Times New Roman", serif',
    fontFamilyMonospace: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    headings: {
        fontFamily: '"Fraunces", Georgia, serif',
        fontWeight: '600',
    },
    primaryColor: 'teal',
    primaryShade: 7,
    colors: { teal },
    defaultRadius: 'md',
    white: '#fffdf8',
    black: '#1a1a17',
})
