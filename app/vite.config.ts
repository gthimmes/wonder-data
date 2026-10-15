/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { assistantPlugin } from './server/assistant.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), assistantPlugin()],
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
