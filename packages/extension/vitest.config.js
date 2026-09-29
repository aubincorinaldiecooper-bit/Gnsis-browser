import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	// The same `@/` alias WXT gives the extension build, so tests import the
	// modules they cover the way the extension does.
	resolve: {
		alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
	},
	test: {
		name: 'ext',
		include: ['src/**/*.test.ts'],
		silent: 'passed-only',
	},
})
