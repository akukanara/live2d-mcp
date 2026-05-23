/**
 * 渲染器入口
 * 1. 初始化 Live2D 应用
 * 2. 建立 WebSocket 连接
 * 3. 绑定命令处理器
 * 4. 更新状态栏 UI
 */

import { Live2DApp } from './live2d-app.js'
import { WsClient } from './ws-client.js'
import { createCommandHandler } from './command-handler.js'

const canvas = document.getElementById('live2d-canvas') as HTMLCanvasElement
const wsDot = document.getElementById('ws-dot') as HTMLDivElement
const wsStatus = document.getElementById('ws-status') as HTMLSpanElement
const modelDot = document.getElementById('model-dot') as HTMLDivElement
const modelStatus = document.getElementById('model-status') as HTMLSpanElement
const currentStateEl = document.getElementById('current-state') as HTMLDivElement
const debugPanel = document.getElementById('debug-panel') as HTMLDivElement
const debugHeader = debugPanel.querySelector('.debug-header') as HTMLDivElement
const debugToggleBtn = document.getElementById('debug-toggle-btn') as HTMLButtonElement
const debugExpressionsEl = document.getElementById('debug-expressions') as HTMLDivElement
const debugMotionsEl = document.getElementById('debug-motions') as HTMLDivElement
const lookXInput = document.getElementById('look-x') as HTMLInputElement
const lookXVal = document.getElementById('look-x-val') as HTMLSpanElement
const lookYInput = document.getElementById('look-y') as HTMLInputElement
const lookYVal = document.getElementById('look-y-val') as HTMLSpanElement
const debugResetBtn = document.getElementById('debug-reset') as HTMLButtonElement
const debugClickLog = document.getElementById('debug-click-log') as HTMLDivElement
const hitareaToggle = document.getElementById('hitarea-toggle') as HTMLInputElement
const mouseFollowCheckbox = document.getElementById('mouse-follow') as HTMLInputElement
const chatStatusDot = document.getElementById('chat-status-dot') as HTMLSpanElement


let currentExpression = '-'
let currentMotion = '-'

const MOTION_NAMES: Record<string, string> = {
  'Idle:0': 'Siaga',
  'Idle:1': 'Siaga 2',
  'Idle:2': 'Siaga 3',
  'Flick:0': 'Kibas',
  'FlickDown:0': 'Menunduk',
  'FlickUp:0': 'Menengadah',
  'Tap:0': 'Ketukan',
  'Tap:1': 'Reaksi Ketuk',
  'Tap@Body:0': 'Sentuh Tubuh',
  'Flick@Body:0': 'Melambaikan Tangan (wave)',
  'Dance:0': '🕺 Menari Heboh (Dance)',
  'Jump:0': '🚀 Melompat Riang (Jump)',
  'Shake:0': '🌀 Gemetar/Panik Heboh (Shake)',
  'Nod:0': '👍 Mengangguk Mantap (Nod)',
}

function motionLabel(group: string, index?: number): string {
  const key = `${group}:${index ?? 0}`
  return MOTION_NAMES[key] ?? `${group}[${index ?? 'rand'}]`
}

function updateStateBar() {
  currentStateEl.textContent = `Ekspresi: ${currentExpression} | Gerakan: ${currentMotion}`
}

// 点击区域 → 动作分组映射
const HIT_AREA_MOTIONS: Record<string, string> = {
  Body: 'Tap@Body',
}

function appendClickLog(px: number, py: number, hitAreas: string[], action: string | null) {
  const entry = document.createElement('div')
  entry.className = 'click-log-entry'
  const coord = `(${Math.round(px)}, ${Math.round(py)})`
  if (action) {
    entry.innerHTML =
      `${coord} hit: <span class="log-hit">[${hitAreas.join(', ')}]</span>` +
      ` → <span class="log-action">${action}</span>`
  } else {
    entry.innerHTML =
      `${coord} <span class="log-miss">miss (no hit area)</span>`
  }
  debugClickLog.appendChild(entry)
  // 最多保留 30 条
  while (debugClickLog.children.length > 30) {
    debugClickLog.firstElementChild?.remove()
  }
  // 自动滚到最新
  const logPane = document.getElementById('pane-log')
  if (logPane) logPane.scrollTop = logPane.scrollHeight
}

function initClickInteraction(app: Live2DApp) {
  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect()
    // 转换为 canvas 物理像素坐标（考虑 devicePixelRatio 缩放）
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    const x = (e.clientX - rect.left) * scaleX
    const y = (e.clientY - rect.top) * scaleY

    const hitAreas = app.hitTest(x, y)

    if (hitAreas.length === 0) {
      appendClickLog(x, y, [], null)
      return
    }

    let group = 'Tap'
    for (const area of hitAreas) {
      if (HIT_AREA_MOTIONS[area]) {
        group = HIT_AREA_MOTIONS[area]
        break
      }
    }

    app.playMotion(group, undefined, 2)
    currentMotion = group
    updateStateBar()
    appendClickLog(x, y, hitAreas, group)
  })
}

function initMouseFollow(app: Live2DApp) {
  function setSliderDisabled(disabled: boolean) {
    lookXInput.disabled = disabled
    lookYInput.disabled = disabled
  }

  // 默认开启，禁用手动滑块
  setSliderDisabled(true)

  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (!mouseFollowCheckbox.checked) return
    const rect = canvas.getBoundingClientRect()
    const x = Math.max(-1, Math.min(1, (e.clientX - rect.left - rect.width / 2) / (rect.width / 2)))
    const y = Math.max(-1, Math.min(1, -((e.clientY - rect.top - rect.height / 2) / (rect.height / 2))))
    app.lookAt(x, y)
  })

  mouseFollowCheckbox.addEventListener('change', () => {
    const following = mouseFollowCheckbox.checked
    setSliderDisabled(following)
    if (!following) {
      // 关闭时重置视线到滑块当前值
      app.lookAt(parseFloat(lookXInput.value), parseFloat(lookYInput.value))
    }
  })
}

let debugPanelInitialized = false

function initDebugPanel(app: Live2DApp) {
  if (!debugPanelInitialized) {
    debugPanelInitialized = true
    // Buka/Tutup: Hanya dipicu oleh tombol toggle
    debugToggleBtn.addEventListener('click', () => {
      const expanded = debugPanel.classList.toggle('expanded')
      debugToggleBtn.textContent = expanded ? '▼ Tutup' : '▲ Buka'
    })

    // Perpindahan Tab
    const tabs = debugHeader.querySelectorAll<HTMLButtonElement>('.debug-tab')
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.remove('active'))
        tab.classList.add('active')
        const paneId = `pane-${tab.dataset.tab}`
        debugPanel.querySelectorAll<HTMLDivElement>('.debug-pane').forEach((p) => {
          p.classList.toggle('active', p.id === paneId)
        })
        // Buka panel secara otomatis jika belum terbuka saat berpindah tab
        if (!debugPanel.classList.contains('expanded')) {
          debugPanel.classList.add('expanded')
          debugToggleBtn.textContent = '▼ Tutup'
        }
      })
    })

    // 视线控制
    function applyLookAt() {
      const x = parseFloat(lookXInput.value)
      const y = parseFloat(lookYInput.value)
      lookXVal.textContent = x.toFixed(2)
      lookYVal.textContent = y.toFixed(2)
      app.lookAt(x, y)
    }
    lookXInput.addEventListener('input', applyLookAt)
    lookYInput.addEventListener('input', applyLookAt)

    // 重置
    debugResetBtn.addEventListener('click', () => {
      app.reset()
      lookXInput.value = '0'
      lookYInput.value = '0'
      lookXVal.textContent = '0.00'
      lookYVal.textContent = '0.00'
      if (!mouseFollowCheckbox.checked) app.lookAt(0, 0)
      
      // Reset active states of dynamic buttons
      debugExpressionsEl.querySelectorAll('.motion-btn').forEach(btn => btn.classList.remove('active'))
      debugMotionsEl.querySelectorAll('.motion-btn').forEach(btn => btn.classList.remove('active'))
      
      currentExpression = '-'
      currentMotion = '-'
      updateStateBar()
    })
  }

  // Clear existing buttons to avoid duplicate list on hot-swap
  debugExpressionsEl.innerHTML = ''
  debugMotionsEl.innerHTML = ''

  const info = app.getModelInfo()
  let activeExprBtn: HTMLButtonElement | null = null
  let activeBtn: HTMLButtonElement | null = null

  // 动态生成表情按钮
  if (info && info.expressions.length > 0) {
    for (const name of info.expressions) {
      const btn = document.createElement('button')
      btn.className = 'motion-btn'
      btn.textContent = name
      btn.addEventListener('click', () => {
        app.setExpression(name)
        currentExpression = name
        updateStateBar()
        activeExprBtn?.classList.remove('active')
        btn.classList.add('active')
        activeExprBtn = btn
      })
      debugExpressionsEl.appendChild(btn)
    }
  } else {
    debugExpressionsEl.textContent = 'Tidak ada ekspresi tersedia'
    debugExpressionsEl.style.color = '#555'
    debugExpressionsEl.style.fontSize = '11px'
  }

  // 动态生成动作按钮
  if (info) {
    for (const [group, count] of Object.entries(info.motionGroups)) {
      for (let i = 0; i < count; i++) {
        const btn = document.createElement('button')
        btn.className = 'motion-btn'
        btn.textContent = motionLabel(group, i)
        btn.dataset.group = group
        btn.dataset.index = String(i)
        btn.addEventListener('click', () => {
          app.playMotion(group, i, 3)
          currentMotion = motionLabel(group, i)
          updateStateBar()
          activeBtn?.classList.remove('active')
          btn.classList.add('active')
          activeBtn = btn
        })
        debugMotionsEl.appendChild(btn)
      }
    }
  }
}

// 解锁浏览器 autoplay 限制：首次用户交互时播放一段静音音频
function setupAudioUnlock() {
  const unlock = () => {
    const ctx = new AudioContext()
    const buf = ctx.createBuffer(1, 1, 22050)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    src.start(0)
    ctx.resume().then(() => ctx.close())
    document.removeEventListener('pointerdown', unlock)
    document.removeEventListener('keydown', unlock)
  }
  document.addEventListener('pointerdown', unlock)
  document.addEventListener('keydown', unlock)
}

function logMcpActivity(type: 'error' | 'ws_recv' | 'ws_send' | 'api' | 'rvc', message: string) {
  const mcpLogEl = document.getElementById('debug-mcp-log')
  if (!mcpLogEl) return
  
  const entry = document.createElement('div')
  entry.className = 'mcp-log-entry'
  
  const timestamp = new Date().toLocaleTimeString()
  let color = '#88ffaa' // Green for success / info
  if (type === 'error') {
    color = '#ff5555' // Red for error
  } else if (type === 'ws_recv') {
    color = '#64b4ff' // Blue for WS received
  } else if (type === 'ws_send') {
    color = '#ffaa64' // Orange for WS sent
  } else if (type === 'api') {
    color = '#e264ff' // Purple for API requests
  } else if (type === 'rvc') {
    color = '#00ffff' // Neon Cyan for RVC logs
  }
  
  entry.innerHTML = `<span style="color: #666;">[${timestamp}]</span> <span style="color: ${color}; font-weight: bold;">[${type.toUpperCase()}]</span> ${message}`
  mcpLogEl.appendChild(entry)
  
  // Keep last 50 logs
  while (mcpLogEl.children.length > 50) {
    mcpLogEl.firstElementChild?.remove()
  }
  
  // Auto-scroll if log pane is active
  const mcpPane = document.getElementById('pane-mcp')
  if (mcpPane) mcpPane.scrollTop = mcpPane.scrollHeight
}

function initChatPanel(app: Live2DApp) {
  const API_BASE = 'http://localhost:3000/api'

  const DEFAULT_SYSTEM_PROMPT = 'Anda adalah Hiyori, asisten virtual Live2D yang ramah, sopan, dan ekspresif. Jawab pertanyaan pengguna dalam bahasa Indonesia yang natural, hangat, dan menyenangkan. Selalu jawab dengan format JSON terstruktur yang berisi teks respon Anda ("text"), emosi ekspresi wajah ("expression": salah satu dari: happy/sad/angry/surprised/neutral/shy/wink/excited), dan gerakan animasi tubuh ("motion": salah satu dari: Tap@Body/Flick@Body/Idle/Flick/FlickDown/FlickUp/Tap/Dance/Jump/Shake/Nod). Contoh format respons:\n{\n  "text": "Halo! Ada yang bisa saya bantu hari ini?",\n  "expression": "happy",\n  "motion": "Tap@Body"\n}';

  const PROVIDER_PRESETS: Record<string, { endpoint: string; model: string }> = {
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

  const chatMessages = document.getElementById('chat-messages') as HTMLDivElement
  const chatInput = document.getElementById('chat-input') as HTMLInputElement
  const chatSend = document.getElementById('chat-send') as HTMLButtonElement
  const clearChatBtn = document.getElementById('clear-chat-btn') as HTMLButtonElement
  const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement
  const settingsDrawer = document.getElementById('settings-drawer') as HTMLDivElement
  const closeSettingsBtn = document.getElementById('close-settings-btn') as HTMLButtonElement
  const saveSettingsBtn = document.getElementById('save-settings-btn') as HTMLButtonElement

  const settingsProvider = document.getElementById('settings-provider') as HTMLSelectElement
  const settingsKey = document.getElementById('settings-key') as HTMLInputElement
  const settingsEndpoint = document.getElementById('settings-endpoint') as HTMLInputElement
  const settingsModel = document.getElementById('settings-model') as HTMLInputElement
  const settingsPrompt = document.getElementById('settings-prompt') as HTMLTextAreaElement

  const settingsPitch = document.getElementById('settings-pitch') as HTMLInputElement
  const settingsPitchVal = document.getElementById('settings-pitch-val') as HTMLSpanElement
  const settingsIndexRate = document.getElementById('settings-index-rate') as HTMLInputElement
  const settingsIndexRateVal = document.getElementById('settings-index-rate-val') as HTMLSpanElement

  // Hubungkan event input slider agar label nilainya bergeser secara real-time
  settingsPitch.addEventListener('input', () => {
    settingsPitchVal.textContent = settingsPitch.value
  })
  settingsIndexRate.addEventListener('input', () => {
    settingsIndexRateVal.textContent = parseFloat(settingsIndexRate.value).toFixed(2)
  })

  // Load existing settings
  async function loadSettings() {
    try {
      logMcpActivity('api', 'GET /api/settings - Memuat setelan AI...');
      const res = await fetch(`${API_BASE}/settings`)
      if (!res.ok) throw new Error('Gagal mengambil setelan')
      const settings = await res.json()
      
      settingsProvider.value = settings.provider || 'groq'
      settingsKey.value = settings.api_key || ''
      
      const rawEndpoint = settings.endpoint || ''
      settingsEndpoint.value = rawEndpoint === 'https://api.groq.com/openai/v1' 
        ? 'https://api.groq.com/openai/v1/chat/completions' 
        : rawEndpoint
        
      settingsModel.value = settings.model || ''
      settingsPrompt.value = settings.system_prompt || DEFAULT_SYSTEM_PROMPT
      
      // Load setelan RVC dari localStorage
      const savedPitch = localStorage.getItem('rvc_pitch_change') || '0'
      const savedIndexRate = localStorage.getItem('rvc_index_rate') || '0.4'
      settingsPitch.value = savedPitch
      settingsPitchVal.textContent = savedPitch
      settingsIndexRate.value = savedIndexRate
      settingsIndexRateVal.textContent = parseFloat(savedIndexRate).toFixed(2)

      logMcpActivity('api', `GET /api/settings - Sukses! Provider: ${settingsProvider.value}, Model: ${settingsModel.value}`);
    } catch (err: any) {
      console.error('[Settings] Error loading settings:', err)
      logMcpActivity('error', `GET /api/settings - Eror: ${err.message}`);
    }
  }

  // Load settings on startup
  loadSettings()

  // Auto-populate on provider change
  settingsProvider.addEventListener('change', () => {
    const provider = settingsProvider.value
    const preset = PROVIDER_PRESETS[provider]
    if (preset) {
      settingsEndpoint.value = preset.endpoint
      settingsModel.value = preset.model
      if (!settingsPrompt.value.trim()) {
        settingsPrompt.value = DEFAULT_SYSTEM_PROMPT
      }
    }
  })

  // Open settings
  settingsBtn.addEventListener('click', () => {
    settingsDrawer.classList.add('open')
    loadSettings()
  })

  // Close settings
  closeSettingsBtn.addEventListener('click', () => {
    settingsDrawer.classList.remove('open')
  })

  // Save settings
  saveSettingsBtn.addEventListener('click', async () => {
    const provider = settingsProvider.value
    const api_key = settingsKey.value.trim()
    const endpoint = settingsEndpoint.value.trim()
    const model = settingsModel.value.trim()
    const system_prompt = settingsPrompt.value.trim()

    saveSettingsBtn.disabled = true
    saveSettingsBtn.textContent = 'Menyimpan...'
    logMcpActivity('api', `POST /api/settings - Menyimpan setelan AI... Provider: ${provider}, Model: ${model}`);

    try {
      const res = await fetch(`${API_BASE}/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider,
          api_key,
          endpoint,
          model,
          system_prompt,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Gagal menyimpan setelan')
      }

      // Simpan setelan RVC ke localStorage
      localStorage.setItem('rvc_pitch_change', settingsPitch.value)
      localStorage.setItem('rvc_index_rate', settingsIndexRate.value)

      logMcpActivity('api', 'POST /api/settings - Sukses menyimpan setelan.');
      await loadSettings()
      settingsDrawer.classList.remove('open')
    } catch (err: any) {
      logMcpActivity('error', `POST /api/settings - Eror: ${err.message}`);
      alert(`Gagal menyimpan setelan: ${err.message}`)
    } finally {
      saveSettingsBtn.disabled = false
      saveSettingsBtn.textContent = 'Simpan Setelan'
    }
  })

  // Clear chat history
  clearChatBtn.addEventListener('click', async () => {
    if (!confirm('Apakah Anda yakin ingin menghapus semua riwayat obrolan?')) return

    logMcpActivity('api', 'POST /api/chat/clear - Menghapus semua riwayat obrolan...');
    try {
      const res = await fetch(`${API_BASE}/chat/clear`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error('Gagal menghapus riwayat')

      logMcpActivity('api', 'POST /api/chat/clear - Sukses menghapus riwayat obrolan.');
      chatMessages.innerHTML = `
        <div class="message assistant">
          <div class="msg-bubble">Halo! Saya Hiyori. Senang bertemu denganmu! Ada yang ingin kamu tanyakan padaku? 😊</div>
        </div>
      `
    } catch (err: any) {
      logMcpActivity('error', `POST /api/chat/clear - Eror: ${err.message}`);
      alert(`Gagal menghapus obrolan: ${err.message}`)
    }
  })

  // Message UI Helpers
  function appendMessage(sender: 'user' | 'assistant', text: string) {
    const msgDiv = document.createElement('div')
    msgDiv.className = `message ${sender}`
    
    const bubbleDiv = document.createElement('div')
    bubbleDiv.className = 'msg-bubble'
    bubbleDiv.textContent = text
    
    msgDiv.appendChild(bubbleDiv)
    chatMessages.appendChild(msgDiv)
    chatMessages.scrollTop = chatMessages.scrollHeight
  }

  function appendTypingIndicator() {
    const msgDiv = document.createElement('div')
    msgDiv.className = 'message assistant'
    
    const bubbleDiv = document.createElement('div')
    bubbleDiv.className = 'msg-bubble'
    bubbleDiv.innerHTML = '<span style="opacity: 0.6">Hiyori sedang mengetik...</span>'
    
    msgDiv.appendChild(bubbleDiv)
    chatMessages.appendChild(msgDiv)
    chatMessages.scrollTop = chatMessages.scrollHeight
    return msgDiv
  }

  // Web Speech Fallback TTS playing
  function playWebSpeechFallback(text: string, emotion: string) {
    if (!('speechSynthesis' in window)) {
      console.warn('Speech synthesis not supported')
      return
    }

    window.speechSynthesis.cancel()

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'id-ID'

    const voices = window.speechSynthesis.getVoices()
    const idVoice = voices.find(v => v.lang.startsWith('id') || v.lang.includes('id-ID'))
    if (idVoice) {
      utterance.voice = idVoice
    }

    utterance.pitch = 1.1
    utterance.rate = 1.05

    // Indonesian speech speed is about 12-15 characters per second
    const estimatedDuration = (text.length * 80) + 500

    utterance.onstart = () => {
      app.startLipSyncOnly(estimatedDuration, emotion)
    }

    utterance.onend = () => {
      app.stopSpeaking()
    }

    utterance.onerror = () => {
      app.stopSpeaking()
    }

    window.speechSynthesis.speak(utterance)
  }

  // Main RVC TTS with Web Speech Fallback
  function playTTS(text: string, emotion: string) {
    logMcpActivity('api', `POST /api/tts - Sintesis RVC untuk "${text.substring(0, 30)}..." (Karakter: ${activeModelId})`)
    
    const currentPitch = parseInt(localStorage.getItem('rvc_pitch_change') || '0', 10)
    const currentIndexRate = parseFloat(localStorage.getItem('rvc_index_rate') || '0.4')
    logMcpActivity('api', `POST /api/tts - Parameter RVC dinamis: pitch_change=${currentPitch}, index_rate=${currentIndexRate}`)
    
    fetch(`${API_BASE}/tts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        character: activeModelId,
        pitch_change: currentPitch,
        index_rate: currentIndexRate
      }),
    })
    .then(async (res) => {
      if (!res.ok) {
        throw new Error(`API returned status ${res.status}`)
      }
      const data = await res.json()
      if (data && data.success && data.audio) {
        logMcpActivity('api', `POST /api/tts - Memutar audio RVC untuk ${activeModelId}`)
        app.setExpression(emotion)
        app.lipSync(undefined, data.audio)
      } else {
        throw new Error('Respons API tidak valid')
      }
    })
    .catch((err) => {
      logMcpActivity('error', `POST /api/tts - Gagal RVC TTS (${err.message}). Menggunakan fallback Web Speech API.`)
      playWebSpeechFallback(text, emotion)
    })
  }

  // Send message
  async function sendMessage() {
    const message = chatInput.value.trim()
    if (!message) return

    chatInput.value = ''
    appendMessage('user', message)

    chatInput.disabled = true
    chatSend.disabled = true
    const typingBubble = appendTypingIndicator()
    logMcpActivity('api', `POST /api/chat - Mengirim pesan: "${message}"`);

    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message }),
      })

      typingBubble.remove()

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Gagal mengirim pesan')
      }

      const reply = await res.json()
      appendMessage('assistant', reply.text)
      logMcpActivity('api', `POST /api/chat - Sukses! Respons: text="${reply.text.substring(0, 30)}...", expression="${reply.expression}", motion="${reply.motion}"`);
      playTTS(reply.text, reply.expression || 'neutral')
    } catch (err: any) {
      typingBubble.remove()
      logMcpActivity('error', `POST /api/chat - Eror: ${err.message}`);
      appendMessage('assistant', `Maaf, terjadi kesalahan: ${err.message}`)
    } finally {
      chatInput.disabled = false
      chatSend.disabled = false
      chatInput.focus()
    }
  }

  // Send events
  chatSend.addEventListener('click', sendMessage)
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      sendMessage()
    }
  })
}


const API_BASE_GLOBAL = 'http://localhost:3000/api'

interface ModelEntry {
  id: string
  name: string
  description: string
  modelPath: string
  thumbnail: string
}

let activeModelId = 'HiyoriPro'

function initModelCatalog(app: Live2DApp) {
  const overlay = document.getElementById('catalog-overlay') as HTMLDivElement
  const catalogBtn = document.getElementById('catalog-btn') as HTMLButtonElement
  const closeCatalogBtn = document.getElementById('close-catalog-btn') as HTMLButtonElement
  const catalogGrid = document.getElementById('catalog-grid') as HTMLDivElement
  const catalogLoading = document.getElementById('catalog-loading') as HTMLDivElement
  const catalogEmpty = document.getElementById('catalog-empty') as HTMLDivElement
  const catalogCount = document.getElementById('catalog-count') as HTMLSpanElement
  const canvasContainer = document.getElementById('canvas-container') as HTMLDivElement

  // Overlay loading saat ganti model
  const modelLoadingOverlay = document.createElement('div')
  modelLoadingOverlay.id = 'catalog-model-loading-overlay'
  modelLoadingOverlay.innerHTML = `<div class="catalog-spinner"></div><span>Memuat model...</span>`
  canvasContainer.style.position = 'relative'
  canvasContainer.appendChild(modelLoadingOverlay)

  async function loadCatalog() {
    catalogLoading.style.display = 'flex'
    catalogGrid.style.display = 'none'
    catalogEmpty.style.display = 'none'
    catalogGrid.innerHTML = ''

    try {
      const res = await fetch(`${API_BASE_GLOBAL}/models`)
      if (!res.ok) throw new Error('Gagal memuat katalog')
      const models: ModelEntry[] = await res.json()

      catalogLoading.style.display = 'none'

      if (models.length === 0) {
        catalogEmpty.style.display = 'block'
        catalogCount.textContent = '0 model'
        return
      }

      catalogCount.textContent = `${models.length} model`
      catalogGrid.style.display = 'grid'

      for (const model of models) {
        const card = document.createElement('div')
        card.className = 'catalog-card' + (model.id === activeModelId ? ' active' : '')
        card.dataset.modelId = model.id
        card.dataset.modelPath = model.modelPath

        // Thumbnail atau placeholder
        const initials = model.name.slice(0, 2).toUpperCase()
        const placeholderHtml = `<div class="catalog-thumb-placeholder"><span style="font-size:28px;z-index:1">${initials}</span></div>`
        let thumbHtml = ''
        if (model.thumbnail) {
          thumbHtml = `<img class="catalog-thumb" src="${model.thumbnail}" alt="${model.name}" loading="lazy" decoding="async" width="160" height="160" onerror="this.parentElement.querySelector('.catalog-thumb-placeholder').style.display='flex';this.style.display='none'">`
          thumbHtml += `<div class="catalog-thumb-placeholder" style="display:none"><span style="font-size:28px;z-index:1">${initials}</span></div>`
        } else {
          thumbHtml = placeholderHtml
        }

        card.innerHTML = `
          ${thumbHtml}
          <div class="catalog-info">
            <div class="catalog-name">${model.name}</div>
            <div class="catalog-desc">${model.description || model.id}</div>
          </div>
        `

        card.addEventListener('click', async () => {
          if (card.classList.contains('active') || card.classList.contains('loading')) return

          // Mark loading
          card.classList.add('loading')
          modelLoadingOverlay.classList.add('visible')

          try {
            await app.loadModelFromPath(model.modelPath)
            activeModelId = model.id

            // Update active state on all cards
            catalogGrid.querySelectorAll('.catalog-card').forEach(c => c.classList.remove('active'))
            card.classList.add('active')

            // Update model status bar
            modelStatus.textContent = `Model: ${model.name}`
            modelDot.classList.add('connected')

            // Update debug panel buttons
            initDebugPanel(app)
            logMcpActivity('api', `Katalog - Berhasil memuat model: ${model.name}`)

            // Tutup modal setelah sukses
            setTimeout(() => { overlay.classList.remove('open') }, 300)
          } catch (err: any) {
            logMcpActivity('error', `Katalog - Gagal memuat model ${model.name}: ${err.message}`)
            alert(`Gagal memuat model ${model.name}:\n${err.message}`)
          } finally {
            card.classList.remove('loading')
            modelLoadingOverlay.classList.remove('visible')
          }
        })

        catalogGrid.appendChild(card)
      }
    } catch (err: any) {
      catalogLoading.style.display = 'none'
      catalogEmpty.style.display = 'block'
      catalogEmpty.textContent = `Gagal memuat katalog: ${err.message}`
      logMcpActivity('error', `Katalog - ${err.message}`)
    }
  }

  // Buka katalog
  catalogBtn.addEventListener('click', () => {
    overlay.classList.add('open')
    loadCatalog()
  })

  // Tutup katalog
  closeCatalogBtn.addEventListener('click', () => overlay.classList.remove('open'))
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('open')
  })

  // Tutup dengan Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) {
      overlay.classList.remove('open')
    }
  })
}

async function main() {

  setupAudioUnlock()

  // 初始化 Live2D
  const app = new Live2DApp()

  try {
    await app.init(canvas)
    modelDot.classList.add('connected')
    modelStatus.textContent = 'Model Telah Dimuat'
    console.log('[Main] Live2D app initialized')
    initDebugPanel(app)
    initMouseFollow(app)
    initClickInteraction(app)
    initChatPanel(app)
    initModelCatalog(app)

    hitareaToggle.addEventListener('change', () => {
      app.showHitAreaOverlay(hitareaToggle.checked)
    })
  } catch (e) {
    modelStatus.textContent = 'Gagal Memuat Model'
    console.error('[Main] Failed to initialize Live2D:', e)
    // Walaupun gagal memuat model, tetap coba hubungkan WS (untuk kemudahan debugging)
  }

  // 初始化 WebSocket 客户端
  const wsClient = new WsClient()

  // 绑定命令处理器（包装一层，同时更新 UI）
  const rawHandler = createCommandHandler(app)
  wsClient.setCommandHandler(async (command) => {
    logMcpActivity('ws_recv', `WS Command - Tipe: ${command.type}, Parameter: ${JSON.stringify(command.params)}`);
    const response = await rawHandler(command)

    // 更新状态栏
    if (response.success) {
      if (command.type === 'setExpression') {
        currentExpression = command.params.expression as string
      } else if (command.type === 'playMotion') {
        currentMotion = motionLabel(command.params.group as string, command.params.index as number | undefined)
      } else if (command.type === 'reset') {
        currentExpression = '-'
        currentMotion = '-'
      }
      updateStateBar()
      logMcpActivity('ws_recv', `WS Command - Sukses menjalankan aksi: ${command.type}`);
    } else {
      logMcpActivity('error', `WS Command - Gagal menjalankan aksi ${command.type}: ${response.error || 'Unknown error'}`);
    }

    return response
  })

  wsClient.onConnect(() => {
    wsDot.classList.add('connected')
    chatStatusDot.classList.add('connected')
    wsStatus.textContent = 'WebSocket Terhubung'
    logMcpActivity('ws_send', 'WS Bridge - Terhubung ke WebSocket bridge!');

    const modelInfo = app.getModelInfo()
    if (modelInfo) {
      wsClient.sendReady(modelInfo)
      logMcpActivity('ws_send', `WS Bridge - sendReady -> modelInfo: ${modelInfo.expressions.length} ekspresi, ${Object.keys(modelInfo.motionGroups).length} gerakan`);
    }
  })

  wsClient.onDisconnect(() => {
    wsDot.classList.remove('connected')
    chatStatusDot.classList.remove('connected')
    wsStatus.textContent = 'WebSocket Terputus (Mencoba menghubungkan kembali...)'
    logMcpActivity('error', 'WS Bridge - Terputus dari WebSocket bridge!');
  })

  // Tangkap log real-time dari backend dan tampilkan di panel
  wsClient.onLog((logType, message) => {
    logMcpActivity(logType, message)
  })

  wsClient.connect()
}

main().catch(console.error)
