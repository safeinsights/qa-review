import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// One chunk per heavy vendor family, so no single bundle crosses Vite's 500 kB warning.
const VENDOR_CHUNKS: Record<string, RegExp> = {
    react: /node_modules\/(react|react-dom|scheduler)\//,
    mantine: /node_modules\/@mantine\//,
    xterm: /node_modules\/@xterm\//,
    markdown: /node_modules\/(react-markdown|remark-|rehype-|micromark|mdast-|hast-|unified|vfile)/,
    // The editor core (view, state and their helpers) and everything built on it go
    // in separate chunks; together they cross the limit. The split is by dependency
    // direction: commands, the theme and the grammars all import @codemirror/language,
    // so they must share its chunk or the two chunks import each other.
    'codemirror-core':
        /node_modules\/(@codemirror\/(view|state)\/|@marijn\/|style-mod|w3c-keyname|crelt)/,
    codemirror: /node_modules\/(@codemirror|@lezer)\//,
}

function vendorChunk(id: string): string | undefined {
    return Object.keys(VENDOR_CHUNKS).find(name => VENDOR_CHUNKS[name].test(id))
}

export default defineConfig({
    plugins: [react()],
    clearScreen: false,
    server: { port: 1420, strictPort: true },
    build: { rollupOptions: { output: { manualChunks: vendorChunk } } },
})
