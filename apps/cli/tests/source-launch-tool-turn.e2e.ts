import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { scanZstdFrames } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

/**
 * Source-vector tool dispatch regression: `pnpm dsh` runs
 * `node --import tsx/esm apps/cli/src/bin.ts`, whose module universe resolves from
 * workspace `src` trees through the tsconfig `paths` map. Enforcing the installation's
 * disk generation over profile plugin imports (runtime resolution as the omitted-mode
 * default) loads a second, `lib` copy of every workspace package into the same
 * process; the symbol-keyed `TOOL_RUNTIME_SCHEDULER` contract then fails to
 * identify across copies, and the first tool call dies reading `prepare` off the
 * other copy's scheduler. This suite boots the real source entry through a real
 * profile and drives one bash tool call through the mock LLM, so any mode that
 * splits the module universe fails here instead of in every developer's turn.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const dshSourceBin = 'apps/cli/src/bin.ts'
const SPAWN_TIMEOUT_MS = 120_000
const TOOL_MARKER = 'dsh-source-tool-round-trip'
const SUCCESS_TEXT = 'source vector tool round trip complete'

describe('dsh source launcher profile turn (node --import tsx/esm)', () => {
  it('executes a profile tool call in the launcher process and completes the turn', async () => {
    const apiKey = 'dsh-source-launch-key'
    const server = await startMockLlmServer({
      sequence: ['tool_call_success', 'success'],
      apiKey,
      toolName: 'bash',
      toolArguments: JSON.stringify({
        command: `printf ${TOOL_MARKER}`,
        description: 'Print the source-vector round-trip marker',
      }),
      successText: SUCCESS_TEXT,
    })
    const home = mkdtempSync(join(tmpdir(), 'dsh-source-launch-turn-'))
    writeFileSync(join(home, 'settings.yaml'), 'llm-deepseek:\n  protocol: chat-completions\n')
    // The title LLM would race the turn for mock script entries; the fallback
    // titler keeps this suite's request sequence deterministic.
    writeFileSync(join(home, 'cordis.patch.yml'), '- id: session-title-llm\n  disabled: true\n')
    try {
      const result = await execa(
        process.execPath,
        ['--import', 'tsx/esm', dshSourceBin, '--profile', 'headless', 'prove', 'the', 'source', 'tool', 'path'],
        {
          cwd: repoRoot,
          input: '',
          timeout: SPAWN_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          reject: false,
          env: {
            DSH_HOME: home,
            DSH_TELEMETRY_DISABLED: '1',
            DEEPSEEK_API_KEY: apiKey,
            DEEPSEEK_BASE_URL: server.baseURL,
          },
        },
      )
      if (result.timedOut) {
        throw new Error(`dsh source turn did not exit within ${SPAWN_TIMEOUT_MS / 1_000}s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
      }
      expect(result.exitCode, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0)
      expect(result.stderr).not.toContain("Cannot read properties of undefined (reading 'prepare')")
      expect(result.stdout).toBe(SUCCESS_TEXT)
      expect(server.requests.map(request => request.path)).toEqual(['/chat/completions', '/chat/completions'])

      // The persisted session proves the bash tool call was prepared, dispatched, and
      // committed through the profile's ToolRuntime before the loop continued.
      const sessionFiles = readdirSync(join(home, 'sessions'), { recursive: true })
        .filter(file => typeof file === 'string' && file.endsWith('.jsonl.zstd')) as string[]
      expect(sessionFiles.length, `session files: ${sessionFiles.join(', ')}`).toBe(1)
      const compressed = readFileSync(join(home, 'sessions', sessionFiles[0]!))
      const frames = scanZstdFrames(compressed).frames
      const events = frames.flatMap(({ start, end }) =>
        zstdDecompressSync(compressed.subarray(start, end)).toString().trim().split('\n'))
        .map(line => JSON.parse(line) as SessionEvent)
      const toolCall = events.find(event => event.type === 'tool/call')
      expect(toolCall?.data.name).toBe('bash')
      const toolResult = events.find(event => event.type === 'tool/result')
      expect(JSON.stringify(toolResult)).toContain(TOOL_MARKER)
    } finally {
      await server.close()
      rmSync(home, { recursive: true, force: true })
    }
  }, SPAWN_TIMEOUT_MS + 60_000)
})
