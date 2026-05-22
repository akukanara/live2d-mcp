/**
 * MCP Server 核心 - 注册所有工具并配置传输方式
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express from 'express'
import cors from 'cors'
import { startWebSocketServer, sendCommand } from './ws-bridge.js'
import { registerExpressionTools } from './tools/expression.js'
import { registerMotionTools } from './tools/motion.js'
import { registerParameterTools } from './tools/parameter.js'
import { registerQueryTools } from './tools/query.js'
import { registerTTSTools } from './tools/tts.js'
import { initDb, getAllSettings, setSetting, saveChatMessage, getRecentChatHistory, clearChatHistory } from './db.js'
import { buildIndex, searchDocs } from './rag.js'

const HTTP_PORT = parseInt(process.env.HTTP_PORT ?? '3000', 10)

function createServer(): McpServer {
  const server = new McpServer({
    name: 'live2d-controller',
    version: '0.1.0',
  })

  // 注册所有工具
  registerExpressionTools(server)
  registerMotionTools(server)
  registerParameterTools(server)
  registerQueryTools(server)
  registerTTSTools(server)

  return server
}

export async function runStdio(): Promise<void> {
  console.error('[MCP] Starting in stdio mode...')
  startWebSocketServer()

  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[MCP] Server running on stdio')
}

export async function runHttp(): Promise<void> {
  console.error(`[MCP] Starting in HTTP mode on port ${HTTP_PORT}...`)
  
  // Inisialisasi Database SQLite & RAG Index
  initDb().catch(console.error)
  buildIndex()
  
  startWebSocketServer()

  const app = express()
  app.use(cors())
  app.use(express.json())

  // API Route: Get Settings
  app.get('/api/settings', async (_req, res) => {
    try {
      const settings = await getAllSettings()
      if (settings.api_key) {
        settings.api_key = '••••••••'
      }
      return res.json(settings)
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to fetch settings' })
    }
  })

  // API Route: Save Settings
  app.post('/api/settings', async (req, res) => {
    try {
      const { provider, api_key, endpoint, model, system_prompt } = req.body

      if (provider !== undefined) await setSetting('provider', provider)
      if (endpoint !== undefined) await setSetting('endpoint', endpoint)
      if (model !== undefined) await setSetting('model', model)
      if (system_prompt !== undefined) await setSetting('system_prompt', system_prompt)

      if (api_key !== undefined && api_key !== '••••••••' && api_key.trim() !== '') {
        await setSetting('api_key', api_key)
      }

      return res.json({ success: true })
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to save settings' })
    }
  })

  // API Route: Clear Chat History
  app.post('/api/chat/clear', async (_req, res) => {
    try {
      await clearChatHistory()
      return res.json({ success: true })
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to clear chat history' })
    }
  })

  // API Route: Chat with AI Agent
  app.post('/api/chat', async (req, res) => {
    try {
      const { message } = req.body
      if (!message) {
        return res.status(400).json({ error: 'Message is required' })
      }

      // 1. Ambil setelan dari SQLite
      const settings = await getAllSettings()
      const provider = settings.provider || 'groq'
      const apiKey = settings.api_key || ''

      const PROVIDER_DEFAULTS: Record<string, { endpoint: string; model: string }> = {
        groq: {
          endpoint: 'https://api.groq.com/openai/v1/chat/completions',
          model: 'llama3-8b-8192',
        },
        openai: {
          endpoint: 'https://api.openai.com/v1/chat/completions',
          model: 'gpt-4o-mini',
        },
        gemini: {
          endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
          model: 'gemini-1.5-flash',
        },
        anthropic: {
          endpoint: 'https://api.anthropic.com/v1/messages',
          model: 'claude-3-5-sonnet-20241022',
        },
        alibaba: {
          endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
          model: 'qwen-turbo',
        },
      }

      const defaultPreset = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.groq

      let endpoint = settings.endpoint || ''
      if (!endpoint || endpoint === 'https://api.groq.com/openai/v1') {
        endpoint = defaultPreset.endpoint
      }

      let model = settings.model || ''
      if (!model) {
        model = defaultPreset.model
      }

      const DEFAULT_SYSTEM_PROMPT = 'Anda adalah Hiyori, asisten virtual Live2D yang ramah, sopan, dan ekspresif. Jawab pertanyaan pengguna dalam bahasa Indonesia yang natural, hangat, dan menyenangkan. Selalu jawab dengan format JSON terstruktur yang berisi teks respon Anda ("text"), emosi ekspresi wajah ("expression": salah satu dari: happy/sad/angry/surprised/neutral), dan gerakan animasi tubuh ("motion": salah satu dari: TapBody/Idle/Flick/dsb, default adalah TapBody atau Idle). Contoh format respons:\n{\n  "text": "Halo! Ada yang bisa saya bantu hari ini?",\n  "expression": "happy",\n  "motion": "Tap@Body"\n}';

      let systemPrompt = settings.system_prompt || ''
      if (!systemPrompt) {
        systemPrompt = DEFAULT_SYSTEM_PROMPT
      }

      if (!apiKey) {
        return res.status(400).json({ error: 'API Key belum dikonfigurasi. Silakan masuk ke Setelan.' })
      }

      // 2. Pencarian Dokumen (RAG)
      const ragContext = searchDocs(message, 2)
      let fullSystemPrompt = systemPrompt
      if (ragContext) {
        fullSystemPrompt += `\n\n[INFORMASI PENDUKUNG RESMI (RAG)]\nGunakan data berikut jika relevan untuk menjawab pertanyaan:\n${ragContext}`
      }

      // 3. Ambil riwayat chat sebelumnya (maksimal 8 pesan terakhir)
      const history = await getRecentChatHistory(8)

      // Simpan chat User ke database
      await saveChatMessage('user', message)

      // Susun pesan untuk API
      const messages = [
        { role: 'system', content: fullSystemPrompt },
        ...history.map(h => ({ role: h.sender === 'user' ? 'user' : 'assistant', content: h.message })),
        { role: 'user', content: message }
      ]

      let replyText = ''
      let parsedResponse: any = null

      // 4. Request ke API AI masing-masing Provider
      if (provider === 'anthropic') {
        const response = await fetch(endpoint || 'https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: model || 'claude-3-5-sonnet-20241022',
            max_tokens: 1024,
            system: fullSystemPrompt,
            messages: messages.filter(m => m.role !== 'system')
          })
        })

        if (!response.ok) {
          const errText = await response.text()
          throw new Error(`Anthropic API Error: ${response.status} - ${errText}`)
        }

        const data: any = await response.json()
        replyText = data.content?.[0]?.text || ''
      } else {
        // OpenAI-Compatible, Groq, Gemini, Alibaba
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: model,
            messages: messages,
            response_format: systemPrompt.toLowerCase().includes('json') ? { type: 'json_object' } : undefined
          })
        })

        if (!response.ok) {
          const errText = await response.text()
          throw new Error(`${provider.toUpperCase()} API Error: ${response.status} - ${errText}`)
        }

        const data: any = await response.json()
        replyText = data.choices?.[0]?.message?.content || ''
      }

      console.error('[Chat API] AI response:', replyText)

      // 5. Ekstraksi format JSON dari respon AI secara aman
      try {
        let cleanText = replyText.trim()
        if (cleanText.startsWith('```')) {
          const lines = cleanText.split('\n')
          if (lines[0].toLowerCase().includes('json')) {
            lines.shift()
          } else {
            lines.shift()
          }
          if (lines[lines.length - 1] === '```') {
            lines.pop()
          }
          cleanText = lines.join('\n').trim()
        }

        const firstBrace = cleanText.indexOf('{')
        const lastBrace = cleanText.lastIndexOf('}')
        if (firstBrace >= 0 && lastBrace > firstBrace) {
          cleanText = cleanText.substring(firstBrace, lastBrace + 1)
        }

        parsedResponse = JSON.parse(cleanText)
      } catch (err) {
        console.error('[Chat API] AI did not return valid JSON, falling back:', err)
        parsedResponse = {
          text: replyText,
          expression: 'neutral',
          motion: 'Tap@Body'
        }
      }

      const plainText = parsedResponse.text || replyText
      
      // Simpan chat asisten ke database
      await saveChatMessage('assistant', plainText)

      // 6. Jalankan aksi Live2D (ekspresi & gerakan) secara paralel lewat WebSocket
      try {
        if (parsedResponse.expression) {
          sendCommand('setExpression', { expression: parsedResponse.expression }).catch(console.error)
        }
        if (parsedResponse.motion) {
          sendCommand('playMotion', { group: parsedResponse.motion }).catch(console.error)
        }
      } catch (e) {
        console.error('[Chat API] Failed to trigger Live2D actions via ws:', e)
      }

      return res.json({
        text: plainText,
        expression: parsedResponse.expression || 'neutral',
        motion: parsedResponse.motion || 'Tap@Body'
      })

    } catch (err: any) {
      console.error('[Chat API] Error:', err)
      return res.status(500).json({ error: err.message || 'Internal Server Error' })
    }
  })

  // 每个连接创建独立的 MCP Server 实例
  app.all('/mcp', async (req, res) => {
    const server = createServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,  // stateless
    })
    res.on('close', () => {
      transport.close().catch(console.error)
      server.close().catch(console.error)
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })

  // 健康检查
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', mode: 'http', wsPort: process.env.WS_PORT ?? '8765' })
  })

  app.listen(HTTP_PORT, () => {
    console.error(`[MCP] HTTP server listening on http://localhost:${HTTP_PORT}/mcp`)
    console.error(`[MCP] Health check: http://localhost:${HTTP_PORT}/health`)
  })
}
