import { describe, expect, it, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { logClaudeUsage } from './claudeUsageLogger.js'

function response(usage?: Partial<Anthropic.Usage>): Anthropic.Message {
  return {
    model: 'claude-sonnet-5',
    usage: usage as Anthropic.Usage,
  } as Anthropic.Message
}

describe('logClaudeUsage', () => {
  it('logs a structured JSON line with token/search counts', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    logClaudeUsage({
      callType: 'highlights',
      tripId: 'trip-1',
      attempt: 0,
      elapsedMs: 1234,
      response: response({
        input_tokens: 100,
        output_tokens: 200,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 20,
        server_tool_use: { web_search_requests: 3, web_fetch_requests: 0 },
      }),
    })

    expect(logSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect(logged).toEqual({
      event: 'claude_usage',
      callType: 'highlights',
      tripId: 'trip-1',
      model: 'claude-sonnet-5',
      attempt: 0,
      elapsedMs: 1234,
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationTokens: 10,
      cacheReadTokens: 20,
      webSearchRequests: 3,
    })

    logSpy.mockRestore()
  })

  it('degrades to zeros rather than throwing when usage is missing', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(() =>
      logClaudeUsage({
        callType: 'rescan',
        attempt: 1,
      elapsedMs: 1234,
        response: response(undefined),
      }),
    ).not.toThrow()

    const logged = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect(logged.inputTokens).toBe(0)
    expect(logged.webSearchRequests).toBe(0)
    expect(logged.tripId).toBeUndefined()

    logSpy.mockRestore()
  })
})
