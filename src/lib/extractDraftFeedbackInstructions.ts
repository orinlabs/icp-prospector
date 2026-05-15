const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_MODEL = 'openai/gpt-4o-mini'

type ChatResponse = {
  choices?: Array<{ message?: { content?: string | null } }>
  error?: { message?: string }
}

/**
 * Turn freeform draft feedback into short imperative lines suitable for a standing-instructions field.
 */
export async function extractDraftFeedbackInstructionLines(reviewNotes: string): Promise<string[]> {
  const trimmed = reviewNotes.trim()
  if (!trimmed) return []

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    return [trimmed.length > 500 ? trimmed.slice(0, 500) + '…' : trimmed]
  }

  const model = process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://api.flash.orinlabs.ai',
      'X-Title': 'Flash draft feedback extraction'
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'You convert operator feedback on a cold email draft into 1–6 concise standing instructions for future drafts. ' +
            'Output ONLY a JSON array of strings. Each string is one imperative rule (no numbering prefix). ' +
            'No markdown, no prose outside JSON. If feedback is vague, still distill the clearest possible rules.'
        },
        { role: 'user', content: trimmed }
      ]
    })
  })

  if (!res.ok) {
    throw new Error('OpenRouter extract failed: ' + (await res.text()).slice(0, 400))
  }
  const payload = (await res.json()) as ChatResponse
  if (payload.error?.message) {
    throw new Error('OpenRouter extract error: ' + payload.error.message)
  }
  const raw = payload.choices?.[0]?.message?.content?.trim()
  if (!raw) {
    return [trimmed.length > 500 ? trimmed.slice(0, 500) + '…' : trimmed]
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return [trimmed.length > 500 ? trimmed.slice(0, 500) + '…' : trimmed]
  }
  if (!Array.isArray(parsed)) {
    return [trimmed.length > 500 ? trimmed.slice(0, 500) + '…' : trimmed]
  }
  const lines = parsed
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8)
  return lines.length > 0 ? lines : [trimmed.length > 500 ? trimmed.slice(0, 500) + '…' : trimmed]
}
