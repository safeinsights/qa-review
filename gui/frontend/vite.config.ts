import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// One chunk per heavy vendor family, so no single bundle crosses Vite's 500 kB warning.
const VENDOR_CHUNKS: Record<string, RegExp> = {
    react: /node_modules\/(react|react-dom|scheduler)\//,
    mantine: /node_modules\/@mantine\//,
    xterm: /node_modules\/@xterm\//,
    markdown: /node_modules\/(react-markdown|remark-|rehype-|micromark|mdast-|hast-|unified|vfile)/,
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
