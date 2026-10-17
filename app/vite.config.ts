/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { assistantPlugin } from './server/assistant.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), assistantPlugin()],
  // exceljs is loaded lazily on export; pre-bundle it so the first export never triggers a dev-server reload.
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'], include: ['exceljs'] },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
