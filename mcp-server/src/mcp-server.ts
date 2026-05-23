/**
 * MCP Server 核心 - 注册所有工具并配置传输方式
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { startWebSocketServer, sendCommand, logMcpActivityToFrontend } from './ws-bridge.js'
import { registerExpressionTools } from './tools/expression.js'
import { registerMotionTools } from './tools/motion.js'
import { registerParameterTools } from './tools/parameter.js'
import { registerQueryTools } from './tools/query.js'
import { registerTTSTools } from './tools/tts.js'
import { initDb, getAllSettings, setSetting, saveChatMessage, getRecentChatHistory, clearChatHistory } from './db.js'
import { buildIndex, searchDocs } from './rag.js'

// Resolve path ke folder model di root proyek (models/)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODEL_DIR = path.resolve(__dirname, '../../models')

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

  // Boot persistent RVC service (python src/voice-engine/rvc_service.py)
  const rvcServiceScript = path.resolve(__dirname, 'voice-engine/rvc_service.py')
  const standardPython312 = 'M:\\Users\\ahmad\\AppData\\Local\\Programs\\Python\\Python312\\python.exe'
  const pythonCmd = fs.existsSync(standardPython312) ? standardPython312 : 'python'
  
  console.error(`[RVC Service] Spawning RVC FastAPI service: ${pythonCmd} "${rvcServiceScript}"`)
  logMcpActivityToFrontend('rvc', `[System] Menghidupkan persistent RVC service via ${pythonCmd}...`)
  
  const pyProcess = spawn(pythonCmd, ['-u', rvcServiceScript])
  
  let pyStdoutBuffer = ''
  pyProcess.stdout.on('data', (data) => {
    pyStdoutBuffer += data.toString()
    const lines = pyStdoutBuffer.split('\n')
    pyStdoutBuffer = lines.pop() || ''
    for (const line of lines) {
      const cleanLine = line.trim()
      if (cleanLine) {
        logMcpActivityToFrontend('rvc', cleanLine)
        console.error(`[RVC Service] ${cleanLine}`)
      }
    }
  })

  let pyStderrBuffer = ''
  pyProcess.stderr.on('data', (data) => {
    pyStderrBuffer += data.toString()
    const lines = pyStderrBuffer.split('\n')
    pyStderrBuffer = lines.pop() || ''
    for (const line of lines) {
      const cleanLine = line.trim()
      if (cleanLine) {
        logMcpActivityToFrontend('rvc', `[Error/Stderr] ${cleanLine}`)
        console.error(`[RVC Service Error] ${cleanLine}`)
      }
    }
  })

  pyProcess.on('close', (code) => {
    console.error(`[RVC Service] Process exited with code ${code}`)
    logMcpActivityToFrontend('rvc', `[System] RVC Service dihentikan (exit code: ${code})`)
  })

  const killPyProcess = () => {
    if (pyProcess) {
      console.error('[RVC Service] Killing RVC service process...')
      pyProcess.kill('SIGTERM')
    }
  }

  process.on('SIGINT', killPyProcess)
  process.on('SIGTERM', killPyProcess)
  process.on('exit', killPyProcess)

  const app = express()
  
  // Robust CORS configuration supporting all origins, methods, and key headers
  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'anthropic-version'],
    credentials: true,
    optionsSuccessStatus: 204
  }))
  
  app.use(express.json())

  // Sajikan folder models/ sebagai static assets di URL /models/*
  app.use('/models', express.static(MODEL_DIR, { maxAge: '1h' }))

  // API Route: Get Settings
  app.get('/api/settings', async (_req, res) => {
    try {
      logMcpActivityToFrontend('api', 'GET /api/settings - Memuat setelan AI...')
      const settings = await getAllSettings()
      if (settings.api_key) {
        settings.api_key = '••••••••'
      }
      logMcpActivityToFrontend('api', `GET /api/settings - Sukses! Provider: ${settings.provider || 'groq'}, Model: ${settings.model || ''}`)
      return res.json(settings)
    } catch (err: any) {
      logMcpActivityToFrontend('error', `GET /api/settings - Eror: ${err.message}`)
      return res.status(500).json({ error: err.message || 'Failed to fetch settings' })
    }
  })

  // API Route: List Available Models
  app.get('/api/models', (_req, res) => {
    try {
      if (!fs.existsSync(MODEL_DIR)) {
        return res.json([])
      }

      const entries = fs.readdirSync(MODEL_DIR, { withFileTypes: true })
      const models = []

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const folderName = entry.name
        const folderPath = path.join(MODEL_DIR, folderName)

        // Cari file model3.json di dalam folder
        const files = fs.readdirSync(folderPath)
        const model3File = files.find(f => f.endsWith('.model3.json'))
        if (!model3File) continue

        const modelPath = `http://localhost:3000/models/${encodeURIComponent(folderName)}/${encodeURIComponent(model3File)}`

        // Baca meta.json opsional untuk nama tampilan dan deskripsi
        let displayName = folderName
        let description = ''
        let thumbnail = ''

        const metaPath = path.join(folderPath, 'meta.json')
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
            displayName = meta.name || folderName
            description = meta.description || ''
            thumbnail = meta.thumbnail || ''
          } catch {}
        }

        // Auto-detect thumbnail — PRIORITASKAN icon kecil, HINDARI texture subfolder besar
        if (!thumbnail) {
          // 1. Cari file ikon yang namanya eksplisit (paling ringan)
          const iconNames = ['icon.png', 'Icon.png', 'preview.png', 'Preview.png', 'thumb.png', 'thumbnail.png', 'cover.png']
          const iconFile = files.find(f => iconNames.includes(f))
          if (iconFile) {
            thumbnail = `http://localhost:3000/models/${encodeURIComponent(folderName)}/${encodeURIComponent(iconFile)}`
          }

          // 2. Cari PNG di root folder yang ukurannya < 2 MB (bukan texture besar)
          // Hindari subfolder bertipe resolution: .8192, .4096, .2048, .1024, textures, texture
          if (!thumbnail) {
            const TEXTURE_SUBFOLDER_PATTERN = /\.(8192|4096|2048|1024|512)$/i
            const smallPngs = files.filter(f => {
              if (!f.toLowerCase().endsWith('.png')) return false
              const filePath = path.join(folderPath, f)
              try {
                const stat = fs.statSync(filePath)
                return stat.size < 2 * 1024 * 1024 // < 2MB
              } catch { return false }
            })
            if (smallPngs.length > 0) {
              thumbnail = `http://localhost:3000/models/${encodeURIComponent(folderName)}/${encodeURIComponent(smallPngs[0])}`
            }

            // 3. Hanya jika tidak ada PNG kecil sama sekali di root, ambil dari subfolder texture
            // tapi filter hanya yang kecil juga
            if (!thumbnail) {
              outer: for (const sub of files) {
                if (TEXTURE_SUBFOLDER_PATTERN.test(sub)) continue // lewati subfolder texture besar
                const subPath = path.join(folderPath, sub)
                try {
                  if (!fs.statSync(subPath).isDirectory()) continue
                } catch { continue }
                const subFiles = fs.readdirSync(subPath)
                for (const subFile of subFiles) {
                  if (!subFile.toLowerCase().endsWith('.png')) continue
                  const subFilePath = path.join(subPath, subFile)
                  try {
                    const stat = fs.statSync(subFilePath)
                    if (stat.size < 2 * 1024 * 1024) {
                      thumbnail = `http://localhost:3000/models/${encodeURIComponent(folderName)}/${encodeURIComponent(sub)}/${encodeURIComponent(subFile)}`
                      break outer
                    }
                  } catch {}
                }
              }
            }
          }
        }

        models.push({
          id: folderName,
          name: displayName,
          description,
          modelPath,
          thumbnail,
        })
      }

      logMcpActivityToFrontend('api', `GET /api/models - Ditemukan ${models.length} model.`)
      return res.json(models)
    } catch (err: any) {
      return res.status(500).json({ error: err.message })
    }
  })

  // API Route: Save Settings
  app.post('/api/settings', async (req, res) => {
    try {
      const { provider, api_key, endpoint, model, system_prompt } = req.body
      logMcpActivityToFrontend('api', `POST /api/settings - Menyimpan setelan AI... Provider: ${provider}, Model: ${model}`)

      if (provider !== undefined) await setSetting('provider', provider)
      if (endpoint !== undefined) await setSetting('endpoint', endpoint)
      if (model !== undefined) await setSetting('model', model)
      if (system_prompt !== undefined) await setSetting('system_prompt', system_prompt)

      if (api_key !== undefined && api_key !== '••••••••' && api_key.trim() !== '') {
        await setSetting('api_key', api_key)
      }

      logMcpActivityToFrontend('api', 'POST /api/settings - Sukses menyimpan setelan.')
      return res.json({ success: true })
    } catch (err: any) {
      logMcpActivityToFrontend('error', `POST /api/settings - Eror: ${err.message}`)
      return res.status(500).json({ error: err.message || 'Failed to save settings' })
    }
  })

  // API Route: Clear Chat History
  app.post('/api/chat/clear', async (_req, res) => {
    try {
      logMcpActivityToFrontend('api', 'POST /api/chat/clear - Menghapus semua riwayat obrolan...')
      await clearChatHistory()
      logMcpActivityToFrontend('api', 'POST /api/chat/clear - Sukses menghapus riwayat obrolan.')
      return res.json({ success: true })
    } catch (err: any) {
      logMcpActivityToFrontend('error', `POST /api/chat/clear - Eror: ${err.message}`)
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

      logMcpActivityToFrontend('api', `POST /api/chat - Menerima pesan: "${message}"`)

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

      logMcpActivityToFrontend('api', `AI Settings - Menggunakan Provider: ${provider}, Model: ${model}`)

      const DEFAULT_SYSTEM_PROMPT = 'Anda adalah Hiyori, asisten virtual Live2D yang ramah, sopan, dan ekspresif. Jawab pertanyaan pengguna dalam bahasa Indonesia yang natural, hangat, dan menyenangkan. Selalu jawab dengan format JSON terstruktur yang berisi teks respon Anda ("text"), emosi ekspresi wajah ("expression": salah satu dari: happy/sad/angry/surprised/neutral/shy/wink/excited), dan gerakan animasi tubuh ("motion": salah satu dari: Tap@Body/Flick@Body/Idle/Flick/FlickDown/FlickUp/Tap/Dance/Jump/Shake/Nod). Contoh format respons:\n{\n  "text": "Halo! Ada yang bisa saya bantu hari ini?",\n  "expression": "happy",\n  "motion": "Tap@Body"\n}';

      let systemPrompt = settings.system_prompt || ''
      if (!systemPrompt) {
        systemPrompt = DEFAULT_SYSTEM_PROMPT
      }

      if (!apiKey) {
        logMcpActivityToFrontend('error', 'AI Settings Error - API Key belum dikonfigurasi.')
        return res.status(400).json({ error: 'API Key belum dikonfigurasi. Silakan masuk ke Setelan.' })
      }

      // 2. Pencarian Dokumen (RAG)
      logMcpActivityToFrontend('api', `RAG Search - Mencari dokumen untuk kata kunci: "${message.substring(0, 30)}..."`)
      const ragContext = searchDocs(message, 2)
      let fullSystemPrompt = systemPrompt
      if (ragContext) {
        logMcpActivityToFrontend('api', `RAG Search - Menemukan dokumen relevan untuk konteks tambahan.`)
        fullSystemPrompt += `\n\n[INFORMASI PENDUKUNG RESMI (RAG)]\nGunakan data berikut jika relevan untuk menjawab pertanyaan:\n${ragContext}`
      } else {
        logMcpActivityToFrontend('api', 'RAG Search - Tidak ditemukan dokumen pendukung yang cocok.')
      }

      // Wajibkan model menggunakan format JSON Live2D dengan tabel keputusan kata kunci yang sangat eksplisit
      const MANDATORY_LIVE2D_INSTRUCTION = `\n\n[INSTRUKSI WAJIB SISTEM KONTROL LIVE2D - PRIORITAS TERTINGGI - JANGAN DIABAIKAN]\nAnda WAJIB selalu menjawab HANYA dalam format JSON valid. JANGAN PERNAH menulis teks biasa di luar JSON.\n\n## FORMAT WAJIB:\n{\n  "text": "Jawaban Anda dalam bahasa Indonesia yang ramah dan natural.",\n  "expression": "PILIH SATU DARI DAFTAR EKSPRESI",\n  "motion": "PILIH SATU DARI DAFTAR GERAKAN"\n}\n\n## DAFTAR EKSPRESI (field "expression"):\n- "excited"   → Sangat antusias/bersemangat/euforia\n- "happy"     → Senang/ceria/gembira biasa\n- "shy"       → Malu/tersipu/dipuji\n- "wink"      → Menggoda/bercanda/bermain-main\n- "sad"       → Sedih/kecewa/simpati\n- "angry"     → Marah/kesal/frustrasi\n- "surprised" → Kaget/terkejut/tidak menyangka\n- "neutral"   → Santai/netral/informatif\n\n## DAFTAR GERAKAN (field "motion") - TABEL KEPUTUSAN WAJIB:\nIKUTI ATURAN BERIKUT SECARA KETAT. Cek secara berurutan:\n\n### RULE 1 → motion: "Shake" (GEMETAR/PANIK/TAKUT)\nGunakan "Shake" JIKA pesan pengguna atau konteks respons Anda mengandung salah satu dari:\n  ketakutan, hantu, setan, monster, horror, mengerikan, menakutkan, kaget, panik, pusing, gemetar,\n  takut, horor, creepy, ngeri, merinding, jijik, shock berat, gemetaran, serem, menyeramkan\nContoh: "ada hantu" → Shake. "aku takut" → Shake. "itu mengerikan" → Shake.\n\n### RULE 2 → motion: "Dance" (MENARI/PERAYAAN RIANG)\nGunakan "Dance" JIKA pesan pengguna atau konteks respons Anda mengandung:\n  menari, dance, tari, joget, goyang, musik, lagu, perayaan, pesta, yay, hore, asyik, seru, celebrate,\n  nyanyi, festival, ulang tahun, happy birthday, party\nContoh: "ayok menari" → Dance. "kita pesta!" → Dance.\n\n### RULE 3 → motion: "Jump" (LOMPAT/EUFORIA PUNCAK)\nGunakan "Jump" JIKA pesan pengguna atau konteks respons Anda mengandung:\n  lompat, loncat, jump, melompat, meloncat, euforia, hore, kabar gembira, menang, berhasil, sukses,\n  juara, lulus, selamat, horee, yeay, berhasil\nContoh: "kita menang!" → Jump. "lompat yuk!" → Jump.\n\n### RULE 4 → motion: "Nod" (SETUJU/KONFIRMASI/SEMANGAT)\nGunakan "Nod" JIKA pesan pengguna atau konteks respons Anda mengandung:\n  setuju, benar, tepat, oke, ya ya, bisa, siap, semangat, angguk, konfirmasi, tentu saja, pasti,\n  aku setuju, betul sekali, mantap, lanjutkan\nContoh: "setujukah kamu?" → Nod. "berikan semangat" → Nod.\n\n### RULE 5 → motion: "Flick@Body" (DEFAULT AKTIF/ENERGIK)\nGunakan "Flick@Body" untuk percakapan umum aktif (sapaan, penjelasan, salam, pertanyaan normal).\n\n### RULE 6 → motion: "Idle"\nGunakan "Idle" HANYA untuk respons santai/diam/mendengarkan biasa.\n\n### RULE 7 → motion lain (FlickDown, FlickUp, Tap, Flick, Tap@Body)\nGunakan sesuai konteks yang sangat spesifik (menunduk hormat=FlickDown, menengadah=FlickUp, dll).\n\n## CONTOH YANG BENAR:\nInput: "ada hantu di sini!"\n→ { "text": "Hii! Jangan bilang hantu dong, aku takut!", "expression": "surprised", "motion": "Shake" }\n\nInput: "ayok menari bersama!"\n→ { "text": "Ayo! Aku suka menari!", "expression": "excited", "motion": "Dance" }\n\nInput: "kita berhasil menang!"\n→ { "text": "Horeee! Kita menang! Yeay!", "expression": "excited", "motion": "Jump" }\n\nInput: "setujukah kamu?"\n→ { "text": "Tentu saja aku setuju!", "expression": "happy", "motion": "Nod" }\n\nInput: "kamu sangat cantik"\n→ { "text": "Eh... makasih, aku jadi malu...", "expression": "shy", "motion": "FlickDown" }\n\nINGAT: "Shake" HANYA untuk ketakutan/panik/horor. "Dance" HANYA untuk tarian/pesta. "Jump" HANYA untuk lompatan/euforia. JANGAN tukar-tukar gerakan ini!`;
      
      fullSystemPrompt += MANDATORY_LIVE2D_INSTRUCTION

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
      logMcpActivityToFrontend('api', `AI Request - Mengirim permintaan API ke ${provider} (${model})...`)
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

      logMcpActivityToFrontend('api', `AI Response - Sukses menerima respons. Panjang: ${replyText.length} karakter.`)
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
        logMcpActivityToFrontend('error', 'AI Parsing Warning - Respon AI bukan JSON valid, menggunakan fallback.')
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
          logMcpActivityToFrontend('ws_send', `WS Send - Menyetel ekspresi wajah ke: "${parsedResponse.expression}"`)
          sendCommand('setExpression', { expression: parsedResponse.expression }).catch(console.error)
        }
        if (parsedResponse.motion) {
          logMcpActivityToFrontend('ws_send', `WS Send - Memainkan gerakan tubuh: "${parsedResponse.motion}"`)
          sendCommand('playMotion', { group: parsedResponse.motion }).catch(console.error)
        }
      } catch (e: any) {
        logMcpActivityToFrontend('error', `WS Command Error - Gagal mengirim aksi: ${e.message}`)
        console.error('[Chat API] Failed to trigger Live2D actions via ws:', e)
      }

      return res.json({
        text: plainText,
        expression: parsedResponse.expression || 'neutral',
        motion: parsedResponse.motion || 'Tap@Body'
      })

    } catch (err: any) {
      logMcpActivityToFrontend('error', `API Chat Error - Terjadi kesalahan: ${err.message}`)
      console.error('[Chat API] Error:', err)
      return res.status(500).json({ error: err.message || 'Internal Server Error' })
    }
  })

  // Helper to find RVC model and index dynamically in voice/<characterName> folder
  function findRvcModelAndIndex(characterName: string) {
    if (!characterName) return { modelPath: null, indexPath: null }
    const norm = characterName.replace(/\s+/g, '').toLowerCase()
    const voiceDir = path.resolve(__dirname, '../../voice')
    if (!fs.existsSync(voiceDir)) return { modelPath: null, indexPath: null }
    try {
      const dirs = fs.readdirSync(voiceDir)
      const matchedDir = dirs.find(d => d.replace(/\s+/g, '').toLowerCase() === norm)
      if (!matchedDir) return { modelPath: null, indexPath: null }
      
      const charDir = path.join(voiceDir, matchedDir)
      const files = fs.readdirSync(charDir)
      const pthFile = files.find(f => f.endsWith('.pth'))
      const indexFile = files.find(f => f.endsWith('.index'))
      
      return {
        modelPath: pthFile ? path.join(charDir, pthFile) : null,
        indexPath: indexFile ? path.join(charDir, indexFile) : null
      }
    } catch {
      return { modelPath: null, indexPath: null }
    }
  }

  // API Route: Local RVC TTS Engine (Hu Tao & Huo Huo with Edge-TTS Fallback)
  app.post('/api/tts', async (req, res) => {
    let tempOutputWav = ''
    try {
      const { text, character, pitch_change, index_rate, rms_mix_rate, protect, filter_radius } = req.body
      if (!text) {
        return res.status(400).json({ error: 'Teks wajib diisi untuk TTS' })
      }

      logMcpActivityToFrontend('api', `POST /api/tts - Permintaan TTS: "${text.substring(0, 30)}..." untuk karakter "${character || 'default'}"`)

      const { modelPath, indexPath } = findRvcModelAndIndex(character)
      tempOutputWav = path.resolve(__dirname, `voice-engine/temp_out_${Date.now()}_${Math.floor(Math.random() * 1000)}.wav`)

      logMcpActivityToFrontend('api', `POST /api/tts - Mengirim request ke RVC Persistent Service (port 5001)`)
      if (modelPath) {
        logMcpActivityToFrontend('api', `POST /api/tts - RVC Model: ${path.basename(modelPath)}, Index: ${indexPath ? path.basename(indexPath) : 'Tidak ada'}`)
      } else {
        logMcpActivityToFrontend('api', `POST /api/tts - Model RVC tidak ditemukan. Menggunakan fallback Edge-TTS murni.`)
      }

      let finalPitchChange = pitch_change !== undefined ? pitch_change : 0

      // Kirim request POST ke FastAPI service
      const rvcResponse = await fetch('http://localhost:5001/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text,
          model_path: modelPath || 'none',
          index_path: indexPath || null,
          output_wav: tempOutputWav,
          pitch_change: finalPitchChange,
          index_rate: index_rate !== undefined ? index_rate : 0.4,
          rms_mix_rate: rms_mix_rate !== undefined ? rms_mix_rate : 0.5,
          protect: protect !== undefined ? protect : 0.33,
          filter_radius: filter_radius !== undefined ? filter_radius : 3
        })
      })

      if (!rvcResponse.ok) {
        const errText = await rvcResponse.text()
        throw new Error(`RVC FastAPI Service Error: ${rvcResponse.status} - ${errText}`)
      }

      const rvcResult: any = await rvcResponse.json()

      // Baca file WAV hasil konversi, ubah ke base64
      if (!fs.existsSync(tempOutputWav)) {
        throw new Error('File hasil audio tidak ditemukan oleh server.')
      }

      const buffer = fs.readFileSync(tempOutputWav)
      const base64Audio = `data:audio/wav;base64,${buffer.toString('base64')}`

      logMcpActivityToFrontend('api', `POST /api/tts - Sukses sintesis audio untuk ${character || 'default'} (fallback=${rvcResult.fallback})`)

      return res.json({
        success: true,
        audio: base64Audio
      })

    } catch (err: any) {
      logMcpActivityToFrontend('error', `POST /api/tts - Eror: ${err.message}`)
      console.error('[TTS API] Error:', err)
      return res.status(500).json({ error: err.message || 'Gagal memproses TTS' })
    } finally {
      // Bersihkan berkas WAV sementara
      if (tempOutputWav && fs.existsSync(tempOutputWav)) {
        try {
          fs.unlinkSync(tempOutputWav)
        } catch (e: any) {
          console.error('[TTS API Cleanup] Gagal menghapus file temp:', e.message)
        }
      }
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

  // Global Error Handler to guarantee JSON responses and CORS headers under all failure conditions
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[Global Error Handler] Caught error:', err)
    
    // Explicit CORS headers for fallback safety
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization')
    
    res.status(err.status || 500).json({
      error: err.message || 'Internal Server Error'
    })
  })

  app.listen(HTTP_PORT, () => {
    console.error(`[MCP] HTTP server listening on http://localhost:${HTTP_PORT}/mcp`)
    console.error(`[MCP] Health check: http://localhost:${HTTP_PORT}/health`)
  })
}
