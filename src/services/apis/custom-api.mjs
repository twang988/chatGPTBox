import { getUserConfig } from '../../config/index.mjs'
import { fetchSSE } from '../../utils/fetch-sse.mjs'
import { getConversationPairs } from '../../utils/get-conversation-pairs.mjs'
import { isEmpty } from 'lodash-es'
import { pushRecord, setAbortController } from './shared.mjs'

/**
 * @param {Browser.Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 * @param {string} apiUrl
 * @param {string} apiKey
 * @param {string} modelName
 */
export async function generateAnswersWithCustomApi(
  port,
  question,
  session,
  apiUrl,
  apiKey,
  modelName,
) {
  const { controller, messageListener, disconnectListener } = setAbortController(port)

  const config = await getUserConfig()
  const prompt = getConversationPairs(
    session.conversationRecords.slice(-config.maxConversationContextLength),
    false,
  )
  prompt.push({ role: 'user', content: question })

  let answer = ''
  let finished = false
  const finish = () => {
    finished = true
    pushRecord(session, question, answer)
    console.debug('conversation history', { content: session.conversationRecords })
    port.postMessage({ answer: null, done: true, session: session })
  }

  // Determine which token parameter to use based on modelName
  const tokenParameter = modelName.startsWith('o1') ? 'max_completion_tokens' : 'max_tokens'

  await fetchSSE(apiUrl, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      messages: prompt,
      model: modelName,
      stream: true,
      [tokenParameter]: config.maxResponseTokenLength, // Use the correct token parameter
      temperature: config.temperature,
    }),
    onMessage(message) {
      console.debug('sse message', message)
      if (finished) return
      if (message.trim() === '[DONE]') {
        finish()
        return
      }
      let data
      try {
        data = JSON.parse(message)
      } catch (error) {
        console.debug('json error', error)
        return
      }

      if (data.response) answer = data.response
      else {
        const delta = data.choices[0]?.delta?.content
        const content = data.choices[0]?.message?.content
        const text = data.choices[0]?.text
        if (delta !== undefined) {
          answer += delta
        } else if (content) {
          answer = content
        } else if (text) {
          answer += text
        }
      }
      port.postMessage({ answer: answer, done: false, session: null })

      if (data.choices[0]?.finish_reason) {
        finish()
        return
      }
    },
    async onStart() {},
    async onEnd() {
      port.postMessage({ done: true })
      port.onMessage.removeListener(messageListener)
      port.onDisconnect.removeListener(disconnectListener)
    },
    async onError(resp) {
      port.onMessage.removeListener(messageListener)
      port.onDisconnect.removeListener(disconnectListener)
      if (resp instanceof Error) throw resp
      const error = await resp.json().catch(() => ({}))
      throw new Error(!isEmpty(error) ? JSON.stringify(error) : `${resp.status} ${resp.statusText}`)
    },
  })
}
