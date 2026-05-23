/**
 * Live2D 应用核心 - 基于 pixi-live2d-display
 *
 * 需要 Live2D Cubism Core 已通过 <script> 标签加载
 */

import * as PIXI from 'pixi.js'
import { Live2DModel } from 'pixi-live2d-display/cubism4'

// pixi-live2d-display 需要访问全局 PIXI
;(window as unknown as Record<string, unknown>).PIXI = PIXI

export interface ModelInfo {
  expressions: string[]
  motionGroups: Record<string, number>
  parameters: ParameterInfo[]
  modelId?: string
}

export interface ParameterInfo {
  id: string
  name: string
  min: number
  max: number
  defaultValue: number
}

const DEFAULT_MODEL_PATH = 'http://localhost:3000/models/HiyoriPro/hiyori_pro_t11.model3.json'

export class Live2DApp {
  private app: PIXI.Application | null = null
  private model: Live2DModel | null = null
  private modelPath: string = DEFAULT_MODEL_PATH
  private modelInfo: ModelInfo | null = null
  private hitAreaGraphics: PIXI.Graphics | null = null
  private activeAnimation: { stop: () => void } | null = null
  private activeAnimationUpdate: (() => void) | null = null
  private defaultScale: number = 1.0

  // Target koordinat fisik spasial untuk peredaman transisi (exponential easing lerp)
  private targetX: number = 300
  private targetY: number = 300
  private targetScaleX: number = 1.0
  private targetScaleY: number = 1.0
  private targetRotation: number = 0

  async init(canvas: HTMLCanvasElement, modelPath?: string): Promise<void> {
    if (modelPath) this.modelPath = modelPath
    this.app = new PIXI.Application({
      view: canvas,
      width: 600,
      height: 600,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    })

    await this.loadModel()
  }

  /**
   * Hot-swap model saat runtime (untuk katalog model)
   */
  async loadModelFromPath(modelPath: string): Promise<void> {
    if (!this.app) throw new Error('App not initialized')
    this.modelPath = modelPath

    // Hentikan animasi aktif
    if (this.activeAnimation) {
      this.activeAnimation.stop()
      this.activeAnimation = null
    }
    this.activeAnimationUpdate = null

    // Hapus model lama dari stage
    if (this.model) {
      this.stopSpeaking()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.app.stage.removeChild(this.model as any)
      this.model.destroy()
      this.model = null
    }

    await this.loadModel()
  }

  private async loadModel(): Promise<void> {
    if (!this.app) throw new Error('App not initialized')

    try {
      const errEl = document.getElementById('model-load-error')
      if (errEl) errEl.style.display = 'none'

      this.model = await Live2DModel.from(this.modelPath, {
        autoInteract: false,  // 关闭自动鼠标交互，由 MCP 控制
      })

      this.model.anchor.set(0.5, 0.5)
      this.model.position.set(this.app.screen.width / 2, this.app.screen.height / 2)

      // 自适应缩放
      const scale = Math.min(
        this.app.screen.width / this.model.width,
        this.app.screen.height / this.model.height
      ) * 0.9
      this.model.scale.set(scale)
      this.defaultScale = scale

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.app.stage.addChild(this.model as any)

      // Inisialisasi target koordinat awal
      this.targetX = this.app.screen.width / 2
      this.targetY = this.app.screen.height / 2
      this.targetScaleX = scale
      this.targetScaleY = scale
      this.targetRotation = 0

      // Daftarkan listener pembaruan langsung ke PIXI Application Ticker.
      // Ini menjamin pembaruan fisik/spasial tereksekusi secara andal di setiap frame dengan redaman transisi (lerp).
      this.app.ticker.add((dt) => {
        // 1. Eksekusi pembaruan kustom jika aktif untuk menentukan target koordinat spasial
        if (this.activeAnimationUpdate) {
          this.activeAnimationUpdate()
        } else {
          // Jika tidak ada animasi aktif, target koordinat kembali ke posisi siaga default
          const defaultX = this.app!.screen.width / 2
          const defaultY = this.app!.screen.height / 2
          this.targetX = defaultX
          this.targetY = defaultY
          this.targetScaleX = this.defaultScale
          this.targetScaleY = this.defaultScale
          this.targetRotation = 0
        }

        // 2. Redam pergerakan fisik model secara asimtotik (exponential easing / lerp) menuju target koordinat.
        // Ini menciptakan kelembutan gerakan yang luar biasa dan menghilangkan patahan koordinat yang kasar saat animasi disela.
        if (this.model) {
          const lerpFactor = Math.min(1.0, 0.14 * (dt || 1.0))
          this.model.position.x += (this.targetX - this.model.position.x) * lerpFactor
          this.model.position.y += (this.targetY - this.model.position.y) * lerpFactor
          this.model.rotation += (this.targetRotation - this.model.rotation) * lerpFactor
          
          const curScaleX = this.model.scale.x
          const curScaleY = this.model.scale.y
          this.model.scale.set(
            curScaleX + (this.targetScaleX - curScaleX) * lerpFactor,
            curScaleY + (this.targetScaleY - curScaleY) * lerpFactor
          )
        }
      })

      // 收集模型信息
      this.modelInfo = this.extractModelInfo()

      console.log('[Live2D] Model loaded:', this.modelPath)
      console.log('[Live2D] Model info:', this.modelInfo)
    } catch (e) {
      console.error('[Live2D] Failed to load model:', e)
      document.getElementById('model-load-error')!.style.display = 'block'
      throw e
    }
  }

  private extractModelInfo(): ModelInfo {
    if (!this.model) return { expressions: [], motionGroups: {}, parameters: [] }

    const internalModel = (this.model as unknown as { internalModel: { settings: { json: Record<string, unknown> } } }).internalModel
    const settings = internalModel?.settings?.json ?? {}

    // Cubism 4 model3.json 将资源路径放在 FileReferences 下
    const fileRefs = (settings['FileReferences'] as Record<string, unknown> | undefined) ?? settings

    // 提取表情列表
    const expressionsRaw = (fileRefs['Expressions'] as Array<{ Name: string }> | undefined) ?? []
    const expressions = expressionsRaw.map((e) => e.Name)

    const motionsRaw = (fileRefs['Motions'] as Record<string, unknown[]> | undefined) ?? {}
    const motionGroups: Record<string, number> = {}
    for (const [group, motions] of Object.entries(motionsRaw)) {
      motionGroups[group] = Array.isArray(motions) ? motions.length : 0
    }

    // Tambahkan gerakan kustom terprogram yang sangat interaktif (heboh!)
    motionGroups['Dance'] = 1
    motionGroups['Jump'] = 1
    motionGroups['Shake'] = 1
    motionGroups['Nod'] = 1

    // 提取参数列表（从 Cubism Core）
    const parameters: ParameterInfo[] = []
    try {
      const coreModel = (internalModel as unknown as { coreModel: { parameters: { count: number; ids: string[]; minimumValues: number[]; maximumValues: number[]; defaultValues: number[] } } }).coreModel
      const params = coreModel?.parameters
      if (params) {
        for (let i = 0; i < params.count; i++) {
          parameters.push({
            id: params.ids[i],
            name: params.ids[i],
            min: params.minimumValues[i],
            max: params.maximumValues[i],
            defaultValue: params.defaultValues[i],
          })
        }
      }
    } catch (e) {
      console.warn('[Live2D] Could not extract parameters:', e)
    }

    return { expressions, motionGroups, parameters }
  }

  getModelInfo(): ModelInfo | null {
    if (!this.modelInfo) return null
    let modelId = 'Hiyori'
    try {
      const parts = this.modelPath.split('/')
      if (parts.length >= 2) {
        modelId = parts[parts.length - 2]
      }
    } catch {}
    return {
      ...this.modelInfo,
      modelId
    }
  }

  // 切换表情
  setExpression(expressionName: string): boolean {
    if (!this.model) return false
    try {
      this.model.expression(expressionName)
      return true
    } catch (e) {
      console.error('[Live2D] setExpression failed:', e)
      return false
    }
  }

  // 播放动作
  playMotion(group: string, index: number = -1, priority: number = 2): boolean {
    if (!this.model) return false
    try {
      // Hentikan animasi terprogram yang sedang berjalan (jika ada)
      if (this.activeAnimation) {
        this.activeAnimation.stop()
        this.activeAnimation = null
      }

      const motionGroupLower = group.toLowerCase()
      if (motionGroupLower === 'dance' || motionGroupLower.includes('dance')) {
        this.startDanceAnimation()
        return true
      } else if (motionGroupLower === 'jump' || motionGroupLower.includes('jump')) {
        this.startJumpAnimation()
        return true
      } else if (motionGroupLower === 'shake' || motionGroupLower.includes('shake')) {
        this.startShakeAnimation()
        return true
      } else if (motionGroupLower === 'nod' || motionGroupLower.includes('nod')) {
        this.startNodAnimation()
        return true
      }

      if (index < 0) {
        // 随机选择
        this.model.motion(group, undefined, priority)
      } else {
        this.model.motion(group, index, priority)
      }
      return true
    } catch (e) {
      console.error('[Live2D] playMotion failed:', e)
      return false
    }
  }

  // Pembantu untuk menghitung berat pudar (fade weight) pudar masuk / pudar keluar
  private getFadeWeight(elapsed: number, duration: number, fadeInMs: number, fadeOutMs: number): number {
    let weight = 1.0
    if (elapsed < fadeInMs) {
      const progress = elapsed / fadeInMs
      weight = progress * progress * (3 - 2 * progress) // smoothstep
    } else if (elapsed > duration - fadeOutMs) {
      const progress = (duration - elapsed) / fadeOutMs
      weight = progress * progress * (3 - 2 * progress) // smoothstep
    }
    return weight
  }

  private startDanceAnimation(): void {
    if (!this.model || !this.app) return
    const startTime = Date.now()
    const duration = 6000 // 6 detik tarian elok!
    
    // Memainkan gerakan tangan bawaan profesional Flick@Body (wave) dengan prioritas tinggi
    try { this.model.motion('Flick@Body', 0, 3) } catch {}

    const defaultX = this.app.screen.width / 2
    const defaultY = this.app.screen.height / 2

    const updateFn = () => {
      const elapsed = Date.now() - startTime
      if (elapsed >= duration) {
        stopFn()
        return
      }

      // Smooth Fade-In dan Fade-Out (800ms)
      const fadeWeight = this.getFadeWeight(elapsed, duration, 800, 800)
      const t = (elapsed / 1000) * 1.8 * Math.PI // Frekuensi tempo tarian yang elok

      // 🕺 SPATIAL LISSAJOUS FIGURE-8: Menari meliuk melengkung indah membentuk angka 8 di kanvas
      const danceX = Math.sin(t) * 75 * fadeWeight // Goyang kiri-kanan sejauh 75px!
      const danceY = Math.sin(t * 2) * 18 * fadeWeight // Bobbing naik-turun 18px!
      const danceRot = Math.cos(t) * 0.12 * fadeWeight // Miringkan tubuh +/- 7 derajat!

      // Squash and stretch dinamis yang ritmis seirama gerakan tarian
      const scaleX = 1.0 + Math.sin(t * 2) * 0.04 * fadeWeight
      const scaleY = 1.0 - Math.sin(t * 2) * 0.04 * fadeWeight

      this.targetX = defaultX + danceX
      this.targetY = defaultY + danceY
      this.targetScaleX = this.defaultScale * scaleX
      this.targetScaleY = this.defaultScale * scaleY
      this.targetRotation = danceRot

      // Harmonisasi Parameter Live2D Sekunder agar seluruh anggota tubuh bergerak seirama
      this.setParameter('ParamBodyAngleX', Math.sin(t) * 10 * fadeWeight)
      this.setParameter('ParamBodyAngleZ', Math.sin(t) * 8 * fadeWeight)
      this.setParameter('ParamAngleX', Math.sin(t * 1.3) * 18 * fadeWeight)
      this.setParameter('ParamAngleZ', Math.sin(t) * 15 * fadeWeight)
      this.setParameter('ParamShoulder', Math.sin(t * 2) * 6 * fadeWeight)
      this.setParameter('ParamLeg', Math.cos(t) * 8 * fadeWeight)
      
      // Kibasan rok & rambut
      this.setParameter('ParamSkirt', Math.cos(t * 2) * 12 * fadeWeight)
      this.setParameter('ParamSkirt2', Math.sin(t * 2) * 8 * fadeWeight)
      this.setParameter('ParamHairAhoge', Math.sin(t * 3) * 12 * fadeWeight)
      this.setParameter('ParamHairFront', Math.sin(t * 2) * 10 * fadeWeight)
      this.setParameter('ParamHairBack', Math.cos(t * 2) * 10 * fadeWeight)
      this.setParameter('ParamSideupRibbon', Math.sin(t * 2) * 12 * fadeWeight)
      this.setParameter('ParamRibbon', Math.cos(t * 2) * 10 * fadeWeight)
      
      // Ekspresi wajah riang gembira
      this.setParameter('ParamCheek', 0.8 * fadeWeight)
      this.setParameter('ParamEyeLSmile', 1.0 * fadeWeight)
      this.setParameter('ParamEyeRSmile', 1.0 * fadeWeight)
    }

    const stopFn = () => {
      this.activeAnimationUpdate = null
      this.resetParameters()
    }

    this.activeAnimationUpdate = updateFn
    this.activeAnimation = { stop: stopFn }
  }

  private startJumpAnimation(): void {
    if (!this.model || !this.app) return
    const startTime = Date.now()
    const duration = 4000 // 4 detik lompat-lompat gembira berantai
    
    // Memainkan gerakan tangan bawaan profesional Tap (hiyori_m07 - mengangkat tangan bersemangat!)
    try { this.model.motion('Tap', 0, 3) } catch {}

    const defaultX = this.app.screen.width / 2
    const defaultY = this.app.screen.height / 2

    const updateFn = () => {
      const elapsed = Date.now() - startTime
      if (elapsed >= duration) {
        stopFn()
        return
      }

      // Smooth Fade-In dan Fade-Out (400ms)
      const fadeWeight = this.getFadeWeight(elapsed, duration, 400, 400)

      // Siklus lompatan berantai: 1.3 detik per lompatan
      const cycleDuration = 1300
      const cycleElapsed = elapsed % cycleDuration
      const progress = cycleElapsed / cycleDuration

      let targetOffsetY = 0
      let scaleX = 1.0
      let scaleY = 1.0

      // Fase 1: Crouch (0% - 15% dari durasi siklus) - Lutut ditekuk ke bawah untuk mengumpulkan tenaga
      if (progress < 0.15) {
        const t = progress / 0.15
        const crouchAmt = Math.sin(t * Math.PI)
        targetOffsetY = crouchAmt * 18 * fadeWeight // Tekuk ke bawah 18px
        scaleY = 1.0 - crouchAmt * 0.14 * fadeWeight // Squash Y (gepeng 14%)
        scaleX = 1.0 + crouchAmt * 0.08 * fadeWeight // Stretch X (melebar 8%)
      }
      // Fase 2: Launch & Flight (15% - 75% dari durasi siklus) - Melambung tinggi ke atas langit
      else if (progress < 0.75) {
        const t = (progress - 0.15) / 0.60
        const flightAmt = Math.sin(t * Math.PI)
        targetOffsetY = -flightAmt * 170 * fadeWeight // Melambung naik secara fisik setinggi 170px!
        
        // Stretch vertikal saat meluncur naik, squash sedikit di puncak, stretch kembali saat jatuh
        const stretchAmt = Math.cos(t * Math.PI) * 0.12 * fadeWeight // Positif saat naik, negatif saat jatuh
        scaleY = 1.0 + stretchAmt
        scaleX = 1.0 - stretchAmt * 0.5
      }
      // Fase 3: Landing Impact (75% - 90% dari durasi siklus) - Membentur tanah & meredam berat gravitasi
      else if (progress < 0.90) {
        const t = (progress - 0.75) / 0.15
        const landingAmt = Math.sin(t * Math.PI)
        targetOffsetY = landingAmt * 12 * fadeWeight // Sedikit bergeser di bawah permukaan tanah
        scaleY = 1.0 - landingAmt * 0.18 * fadeWeight // Squash landing berat (gepeng 18%)
        scaleX = 1.0 + landingAmt * 0.12 * fadeWeight // Stretch X (melebar 12%)
      }
      // Fase 4: Recovery (90% - 100% dari durasi siklus) - Memantul kembali ke ukuran semula
      else {
        const t = (progress - 0.90) / 0.10
        const recoverAmt = Math.sin(t * Math.PI)
        scaleY = 1.0 + recoverAmt * 0.04 * fadeWeight // Pantulan pemulihan mikro
        scaleX = 1.0 - recoverAmt * 0.02 * fadeWeight
      }

      this.targetX = defaultX
      this.targetY = defaultY + targetOffsetY
      this.targetScaleX = this.defaultScale * scaleX
      this.targetScaleY = this.defaultScale * scaleY
      this.targetRotation = 0

      // Harmonisasi Parameter Live2D untuk meniru percepatan gerakan
      const isRising = progress > 0.15 && progress < 0.45
      const isFalling = progress >= 0.45 && progress < 0.75
      const isCrouching = progress < 0.15 || (progress >= 0.75 && progress < 0.90)

      this.setParameter('ParamBodyAngleY', (isRising ? 10 : isFalling ? -10 : isCrouching ? -6 : 0) * fadeWeight)
      this.setParameter('ParamAngleY', (isRising ? 12 : isFalling ? -8 : isCrouching ? -5 : 0) * fadeWeight)
      this.setParameter('ParamLeg', (isRising ? 8 : isFalling ? -8 : -2) * fadeWeight)
      this.setParameter('ParamSkirt', (isRising ? -10 : isFalling ? 10 : 0) * fadeWeight)
      this.setParameter('ParamSkirt2', (isRising ? -8 : isFalling ? 8 : 0) * fadeWeight)
      this.setParameter('ParamHairAhoge', (isRising ? -12 : isFalling ? 12 : 0) * fadeWeight)
      
      this.setParameter('ParamCheek', 0.8 * fadeWeight)
      this.setParameter('ParamEyeLSmile', 1.0 * fadeWeight)
      this.setParameter('ParamEyeRSmile', 1.0 * fadeWeight)
    }

    const stopFn = () => {
      this.activeAnimationUpdate = null
      this.resetParameters()
    }

    this.activeAnimationUpdate = updateFn
    this.activeAnimation = { stop: stopFn }
  }

  private startShakeAnimation(): void {
    if (!this.model || !this.app) return
    const startTime = Date.now()
    const duration = 3000 // 3 detik getaran super panik heboh!
    
    // Memainkan gerakan bawaan Flick (hiyori_m03 - kaget/gemetar)
    try { this.model.motion('Flick', 0, 3) } catch {}

    const defaultX = this.app.screen.width / 2
    const defaultY = this.app.screen.height / 2

    const updateFn = () => {
      const elapsed = Date.now() - startTime
      if (elapsed >= duration) {
        stopFn()
        return
      }

      // Smooth Fade-In dan Fade-Out (400ms)
      const fadeWeight = this.getFadeWeight(elapsed, duration, 400, 400)

      // 🌀 SPATIAL SHAKE: Menggetarkan koordinat spasial secara agresif & panik
      const shakeX = (Math.random() - 0.5) * 22 * fadeWeight // Getaran +/- 11px
      const shakeY = (Math.random() - 0.5) * 16 * fadeWeight // Getaran +/- 8px
      const shakeRot = (Math.random() - 0.5) * 0.07 * fadeWeight // Getaran miring rotasi

      this.targetX = defaultX + shakeX
      this.targetY = defaultY + shakeY
      this.targetScaleX = this.defaultScale
      this.targetScaleY = this.defaultScale
      this.targetRotation = shakeRot

      // Tambahkan parameter Live2D frekuensi tinggi
      const t = (elapsed / 1000) * 14 * Math.PI
      this.setParameter('ParamAngleX', Math.sin(t) * 16 * fadeWeight)
      this.setParameter('ParamAngleY', Math.cos(t * 1.2) * 8 * fadeWeight)
      this.setParameter('ParamBodyAngleX', Math.sin(t * 0.8) * 8 * fadeWeight)
      this.setParameter('ParamHairAhoge', Math.sin(t * 2) * 15 * fadeWeight)
      this.setParameter('ParamSkirt', Math.sin(t * 1.5) * 8 * fadeWeight)
      
      // Ekspresi wajah terkejut, melotot panik & mulut ternganga
      this.setParameter('ParamEyeLOpen', 1.0 + 0.4 * fadeWeight)
      this.setParameter('ParamEyeROpen', 1.0 + 0.4 * fadeWeight)
      this.setParameter('ParamEyeLSmile', 0)
      this.setParameter('ParamEyeRSmile', 0)
      this.setParameter('ParamMouthForm', -1.0 * fadeWeight)
      this.setParameter('ParamMouthOpenY', (0.1 + Math.abs(Math.sin(t * 0.4)) * 0.35) * fadeWeight)
      this.setParameter('ParamCheek', 0.2 * fadeWeight)
    }

    const stopFn = () => {
      this.activeAnimationUpdate = null
      this.resetParameters()
    }

    this.activeAnimationUpdate = updateFn
    this.activeAnimation = { stop: stopFn }
  }

  private startNodAnimation(): void {
    if (!this.model || !this.app) return
    const startTime = Date.now()
    const duration = 2500 // 2.5 detik anggukan mantap!
    
    // Memainkan gerakan kustom bawaan FlickDown (hiyori_m04 - mengangguk/bow)
    try { this.model.motion('FlickDown', 0, 3) } catch {}

    const defaultX = this.app.screen.width / 2
    const defaultY = this.app.screen.height / 2

    const updateFn = () => {
      const elapsed = Date.now() - startTime
      if (elapsed >= duration) {
        stopFn()
        return
      }

      // Smooth Fade-In dan Fade-Out (400ms)
      const fadeWeight = this.getFadeWeight(elapsed, duration, 400, 400)
      const t = (elapsed / 1000) * 3 * Math.PI // Frekuensi anggukan tegas
      const wave = Math.sin(t)
      const positiveWave = Math.max(0, wave)
      
      // 👍 SPATIAL NOD: Menghentakkan model ke bawah & menekuk secara vertikal
      const targetOffsetY = positiveWave * 28 * fadeWeight // Hentakan ke bawah 28px
      const squashY = 1.0 - positiveWave * 0.08 * fadeWeight // Squash vertikal (gepeng 8%)
      const squashX = 1.0 + positiveWave * 0.04 * fadeWeight

      this.targetX = defaultX
      this.targetY = defaultY + targetOffsetY
      this.targetScaleX = this.defaultScale * squashX
      this.targetScaleY = this.defaultScale * squashY
      this.targetRotation = 0

      // Parameter Live2D
      this.setParameter('ParamAngleY', wave * 22 * fadeWeight)
      this.setParameter('ParamBodyAngleY', wave * 7 * fadeWeight)
      this.setParameter('ParamShoulder', wave * 6 * fadeWeight)
      this.setParameter('ParamHairAhoge', wave * 8 * fadeWeight)
      this.setParameter('ParamSkirt', wave * 5 * fadeWeight)
      
      this.setParameter('ParamCheek', 0.6 * fadeWeight)
      this.setParameter('ParamEyeLSmile', 1.0 * fadeWeight)
      this.setParameter('ParamEyeRSmile', 1.0 * fadeWeight)
    }

    const stopFn = () => {
      this.activeAnimationUpdate = null
      this.resetParameters()
    }

    this.activeAnimationUpdate = updateFn
    this.activeAnimation = { stop: stopFn }
  }

  private resetParameters(): void {
    const defaults = [
      'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
      'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
      'ParamShoulder', 'ParamArmLA', 'ParamArmRA', 'ParamArmLB', 'ParamArmRB',
      'ParamHandL', 'ParamHandR', 'ParamLeg', 'ParamBustY',
      'ParamHairAhoge', 'ParamHairFront', 'ParamHairBack', 'ParamSideupRibbon', 'ParamRibbon',
      'ParamSkirt', 'ParamSkirt2', 'ParamCheek', 'ParamEyeLSmile', 'ParamEyeRSmile',
      'ParamMouthForm', 'ParamMouthOpenY'
    ]
    for (const id of defaults) {
      this.setParameter(id, 0)
    }
    this.setParameter('ParamEyeLOpen', 1.0)
    this.setParameter('ParamEyeROpen', 1.0)
  }

  // 设置眼神方向（-1 到 1）
  lookAt(x: number, y: number): boolean {
    if (!this.model) return false
    try {
      // pixi-live2d-display 通过 focus 方法控制眼神
      this.model.focus(
        this.app!.screen.width / 2 + x * this.app!.screen.width / 2,
        this.app!.screen.height / 2 - y * this.app!.screen.height / 2
      )
      return true
    } catch (e) {
      console.error('[Live2D] lookAt failed:', e)
      return false
    }
  }

  // 设置参数
  setParameter(paramId: string, value: number): boolean {
    if (!this.model) return false
    try {
      const internalModel = (this.model as unknown as { internalModel: { coreModel: { setParameterValueById: (id: string, value: number) => void } } }).internalModel
      internalModel?.coreModel?.setParameterValueById(paramId, value)
      return true
    } catch (e) {
      console.error('[Live2D] setParameter failed:', e)
      return false
    }
  }

  // 重置
  reset(): boolean {
    if (!this.model) return false
    try {
      // 重置表情为 normal 或第一个表情
      const expressions = this.modelInfo?.expressions ?? []
      if (expressions.length > 0) {
        const normalExpr = expressions.find((e) => e.toLowerCase().includes('normal')) ?? expressions[0]
        this.model.expression(normalExpr)
      }
      // 停止当前动作，回到 idle
      const idleGroup = Object.keys(this.modelInfo?.motionGroups ?? {}).find((g) =>
        g.toLowerCase().includes('idle')
      )
      if (idleGroup) {
        this.model.motion(idleGroup, undefined, 1)
      }
      // 重置眼神
      this.lookAt(0, 0)
      return true
    } catch (e) {
      console.error('[Live2D] reset failed:', e)
      return false
    }
  }

  // HitArea 边框 overlay
  showHitAreaOverlay(show: boolean): void {
    if (!this.app) return
    if (!show) {
      if (this.hitAreaGraphics) {
        this.app.ticker.remove(this.drawHitAreaOverlay, this)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.app.stage.removeChild(this.hitAreaGraphics as any)
        this.hitAreaGraphics.destroy()
        this.hitAreaGraphics = null
      }
      return
    }
    if (this.hitAreaGraphics) return
    this.hitAreaGraphics = new PIXI.Graphics()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.app.stage.addChild(this.hitAreaGraphics as any)
    this.app.ticker.add(this.drawHitAreaOverlay, this)
  }

  private drawHitAreaOverlay(): void {
    const g = this.hitAreaGraphics
    if (!g || !this.model) return
    g.clear()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internalModel = (this.model as any).internalModel
    const hitAreas: Array<{ Id?: string; id?: string; Name?: string; name?: string }> =
      internalModel?.settings?.hitAreas ?? []

    // getDrawableVertexPositions 返回 Cubism NDC 坐标（原点在模型中心，Y 轴向上，范围 [-1,1]）
    // worldTransform.apply 期望纹理空间坐标（原点左上角，Y 轴向下，[0, originalWidth] × [0, originalHeight]）
    // 需要先做坐标系转换：texX = (cx + 1) * halfW，texY = (1 - cy) * halfH
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const halfW: number = (internalModel?.originalWidth ?? 0) / 2
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const halfH: number = (internalModel?.originalHeight ?? 0) / 2

    for (const area of hitAreas) {
      const areaId = area.Id ?? area.id ?? ''

      let vertices: Float32Array | undefined
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const coreModel = internalModel?.coreModel as any
        // 方式 A: drawables 属性数组（pixi-live2d-display 封装）
        if (coreModel?.drawables?.ids) {
          const ids: string[] = Array.from(coreModel.drawables.ids as ArrayLike<string>)
          const idx = ids.indexOf(areaId)
          if (idx >= 0) vertices = coreModel.drawables.vertexPositions?.[idx]
        }
        // 方式 B: getDrawable* 方法（直接 Cubism SDK API）
        if (!vertices && typeof coreModel?.getDrawableIndex === 'function') {
          const idx: number = coreModel.getDrawableIndex(areaId)
          if (idx >= 0) vertices = coreModel.getDrawableVertexPositions?.(idx)
        }
      } catch {
        continue
      }

      if (!vertices || vertices.length < 4 || halfW === 0 || halfH === 0) continue

      // Cubism NDC → 纹理空间坐标，计算 AABB
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (let i = 0; i < vertices.length; i += 2) {
        const tx = (vertices[i] + 1) * halfW          // cx → texX
        const ty = (1 - vertices[i + 1]) * halfH      // cy → texY（Y 轴翻转）
        if (tx < minX) minX = tx
        if (tx > maxX) maxX = tx
        if (ty < minY) minY = ty
        if (ty > maxY) maxY = ty
      }

      // 纹理空间坐标 → canvas 坐标（通过 worldTransform）
      const wt = (this.model as unknown as { worldTransform: PIXI.Matrix }).worldTransform
      const tl = wt.apply(new PIXI.Point(minX, minY))
      const tr = wt.apply(new PIXI.Point(maxX, minY))
      const br = wt.apply(new PIXI.Point(maxX, maxY))
      const bl = wt.apply(new PIXI.Point(minX, maxY))

      g.lineStyle(1.5, 0x64b4ff, 0.85)
      g.beginFill(0x64b4ff, 0.07)
      g.moveTo(tl.x, tl.y)
      g.lineTo(tr.x, tr.y)
      g.lineTo(br.x, br.y)
      g.lineTo(bl.x, bl.y)
      g.closePath()
      g.endFill()
    }
  }

  // 命中检测，返回点击到的区域名称列表（坐标为 canvas 像素坐标）
  hitTest(x: number, y: number): string[] {
    if (!this.model) return []
    try {
      // pixi-live2d-display 接受 canvas 全局坐标
      return (this.model as unknown as { hitTest: (x: number, y: number) => string[] }).hitTest(x, y)
    } catch {
      return []
    }
  }

  isLoaded(): boolean {
    return this.model !== null
  }

  // ========== TTS + 口型同步功能 ==========

  private speakingAudio: HTMLAudioElement | null = null
  private lipSyncInterval: number | null = null
  private lipSyncRaf: number | null = null
  private audioContext: AudioContext | null = null
  private isSpeaking = false

  // 流式播放队列
  private audioQueue: Array<{ audio: string; lipSyncData: Array<{ time: number; value: number }>; durationMs: number }> = []
  private isPlayingQueue = false

  /**
   * 流式说话 - 初始化音频队列，准备接收 audioChunk
   */
  startSpeak(): boolean {
    if (!this.model) return false
    this.stopSpeaking()
    this.audioQueue = []
    this.isPlayingQueue = false
    return true
  }

  /**
   * 追加一段音频到播放队列，若队列空闲则立即开始播放
   */
  appendChunk(audio: string, lipSyncData: Array<{ time: number; value: number }>, durationMs = 2000): boolean {
    if (!this.model) return false
    this.audioQueue.push({ audio, lipSyncData, durationMs })
    if (!this.isPlayingQueue) {
      this.playNextInQueue()
    }
    return true
  }

  /**
   * 标记流式说话结束（所有 chunk 已发送）
   */
  endSpeak(): boolean {
    return true
  }

  /**
   * 播放队列中的下一段音频
   */
  private playNextInQueue(): void {
    // 取消上一段的口型 RAF
    if (this.lipSyncRaf !== null) {
      cancelAnimationFrame(this.lipSyncRaf)
      this.lipSyncRaf = null
    }

    if (this.audioQueue.length === 0) {
      this.isPlayingQueue = false
      this.isSpeaking = false
      this.setParameter('ParamMouthOpenY', 0)
      return
    }

    this.isPlayingQueue = true
    const { audio, lipSyncData, durationMs } = this.audioQueue.shift()!
    
    // Deteksi tipe audio secara dinamis dari string base64 (RIFF WAV dimulai dengan UklGR)
    let mimeType = 'audio/mpeg'
    if (audio.startsWith('UklGR')) {
      mimeType = 'audio/wav'
    }
    const src = audio.startsWith('data:') ? audio : `data:${mimeType};base64,${audio}`
    
    const audioEl = new Audio(src)
    this.speakingAudio = audioEl

    audioEl.onplay = () => {
      this.isSpeaking = true
      if (lipSyncData && lipSyncData.length > 0) {
        this.playLipSyncData(lipSyncData)
      } else {
        // Gunakan Web Audio API yang luar biasa dinamis untuk menganalisis frekuensi audio secara real-time!
        this.startAudioDrivenLipSync(audioEl)
      }
    }

    audioEl.onended = () => {
      this.playNextInQueue()
    }

    audioEl.play().catch((e) => {
      console.error('[Live2D] queue play blocked:', e)
      this.playNextInQueue()
    })
  }

  /**
   * 仅启动口型动画 - 用于配合外部 TTS
   */
  startLipSyncOnly(duration: number, emotion: string): boolean {
    if (!this.model) return false

    try {
      // 停止之前的说话
      this.stopSpeaking()

      // 设置表情
      this.setExpression(emotion)

      // 启动口型动画，到期后停止说话状态
      this.isSpeaking = true
      this.startLipSyncAnimationWithDuration(duration)
      setTimeout(() => { if (this.isSpeaking && !this.isPlayingQueue) this.stopSpeaking() }, duration + 100)

      console.log('[Live2D] Lip sync only started, duration:', duration, 'ms')
      return true
    } catch (e) {
      console.error('[Live2D] Start lip sync only failed:', e)
      return false
    }
  }

  /**
   * 启动固定时长的口型动画
   */
  private startLipSyncAnimationWithDuration(durationMs: number): void {
    if (this.lipSyncInterval) {
      clearInterval(this.lipSyncInterval)
    }

    const startTime = Date.now()
    const frameInterval = 50

    this.lipSyncInterval = window.setInterval(() => {
      const elapsed = Date.now() - startTime

      if (elapsed >= durationMs) {
        // 只停止口型动画，不清空播放队列（队列由 audio.onended 驱动）
        clearInterval(this.lipSyncInterval!)
        this.lipSyncInterval = null
        this.setParameter('ParamMouthOpenY', 0)
        return
      }

      // 使用正弦波叠加，模拟自然说话节奏
      const progress = elapsed / durationMs
      const mouthOpen = (
        Math.abs(Math.sin(progress * Math.PI * 8)) * 0.5 +
        Math.abs(Math.sin(progress * Math.PI * 13)) * 0.3 +
        Math.abs(Math.sin(progress * Math.PI * 5)) * 0.2
      ) * 0.8

      this.setParameter('ParamMouthOpenY', mouthOpen)
    }, frameInterval)
  }

  /**
   * 口型同步 - 根据音频播放同步口型
   */
  lipSync(
    audioUrl?: string,
    audioBase64?: string,
    lipSyncData?: Array<{ time: number; value: number }>
  ): boolean {
    if (!this.model) return false

    try {
      // 停止之前的说话
      this.stopSpeaking()

      // 播放音频，口型优先用时间轴，无时间轴则用音量分析
      if (audioUrl || audioBase64) {
        let src = audioUrl || ''
        if (audioBase64) {
          let mimeType = 'audio/mpeg'
          if (audioBase64.startsWith('UklGR')) {
            mimeType = 'audio/wav'
          }
          src = audioBase64.startsWith('data:') ? audioBase64 : `data:${mimeType};base64,${audioBase64}`
        }
        const audio = new Audio(src)
        audio.crossOrigin = 'anonymous'
        this.speakingAudio = audio

        audio.onplay = () => {
          this.isSpeaking = true
          if (lipSyncData && lipSyncData.length > 0) {
            this.playLipSyncData(lipSyncData)
          } else {
            this.startAudioDrivenLipSync(audio)
          }
        }

        audio.onended = () => {
          this.stopSpeaking()
        }

        audio.play().catch((e) => {
          console.error('[Live2D] audio.play() blocked:', e)
        })
        return true
      }

      return false
    } catch (e) {
      console.error('[Live2D] Lip sync failed:', e)
      return false
    }
  }

  /**
   * Web Audio API 实时音量驱动口型
   */
  private startAudioDrivenLipSync(audio: HTMLAudioElement): void {
    // 复用或新建 AudioContext
    if (!this.audioContext) {
      this.audioContext = new AudioContext()
    }
    const ctx = this.audioContext

    const source = ctx.createMediaElementSource(audio)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.85  // 高平滑，让嘴型变化舒缓

    source.connect(analyser)
    analyser.connect(ctx.destination)

    const dataArray = new Uint8Array(analyser.frequencyBinCount)
    let currentMouth = 0

    const tick = () => {
      if (!this.isSpeaking) return

      analyser.getByteFrequencyData(dataArray)

      // 取低频段（语音主要能量区）的均值
      const sliceEnd = Math.floor(dataArray.length * 0.25)
      let sum = 0
      for (let i = 0; i < sliceEnd; i++) sum += dataArray[i]
      const avg = sum / sliceEnd  // 0 ~ 255

      const target = Math.min(1, Math.pow(avg / 180, 0.7))

      // 每帧缓动，0.12 约等于 100ms 内跟上目标值的 50%（60fps 下）
      currentMouth += (target - currentMouth) * 0.12

      this.setParameter('ParamMouthOpenY', currentMouth)
      this.lipSyncRaf = requestAnimationFrame(tick)
    }

    this.lipSyncRaf = requestAnimationFrame(tick)
  }

  /**
   * 停止说话
   */
  stopSpeaking(): void {
    // 清空队列
    this.audioQueue = []
    this.isPlayingQueue = false

    // 停止音频
    if (this.speakingAudio) {
      this.speakingAudio.pause()
      this.speakingAudio = null
    }

    // 停止 RAF 口型循环
    if (this.lipSyncRaf !== null) {
      cancelAnimationFrame(this.lipSyncRaf)
      this.lipSyncRaf = null
    }

    // 停止定时器口型循环（startLipSyncOnly 使用）
    if (this.lipSyncInterval) {
      clearInterval(this.lipSyncInterval)
      this.lipSyncInterval = null
    }

    this.isSpeaking = false

    // 嘴巴闭合
    this.setParameter('ParamMouthOpenY', 0)

    console.log('[Live2D] Speaking stopped')
  }

  /**
   * 启动口型动画（模拟）
   */
  private startLipSyncAnimation(): void {
    if (this.lipSyncInterval) {
      clearInterval(this.lipSyncInterval)
    }

    // 模拟口型动画 - 使用正弦波模拟说话节奏
    let time = 0
    this.lipSyncInterval = window.setInterval(() => {
      if (!this.isSpeaking) {
        this.stopSpeaking()
        return
      }

      time += 0.1
      // 使用多个正弦波叠加，模拟自然说话的节奏
      const mouthOpen = (
        Math.abs(Math.sin(time * 8)) * 0.5 +
        Math.abs(Math.sin(time * 13)) * 0.3 +
        Math.abs(Math.sin(time * 5)) * 0.2
      ) * 0.8

      this.setParameter('ParamMouthOpenY', mouthOpen)
    }, 50) // 每 50ms 更新一次
  }

  /**
   * 播放预计算的口型数据（时间轴插值）
   */
  private playLipSyncData(lipSyncData: Array<{ time: number; value: number }>): void {
    const startTime = Date.now()
    const lastTime = lipSyncData[lipSyncData.length - 1].time

    const updateLip = () => {
      const elapsed = Date.now() - startTime

      // 二分查找当前时间点对应的区间，线性插值
      let value = 0
      for (let i = lipSyncData.length - 1; i >= 0; i--) {
        if (elapsed >= lipSyncData[i].time) {
          if (i < lipSyncData.length - 1) {
            const t0 = lipSyncData[i].time
            const t1 = lipSyncData[i + 1].time
            const alpha = (elapsed - t0) / (t1 - t0)
            value = lipSyncData[i].value + (lipSyncData[i + 1].value - lipSyncData[i].value) * alpha
          } else {
            value = lipSyncData[i].value
          }
          break
        }
      }

      this.setParameter('ParamMouthOpenY', Math.max(0, Math.min(1, value)))

      if (elapsed < lastTime + 100) {
        this.lipSyncRaf = requestAnimationFrame(updateLip)
      } else {
        this.setParameter('ParamMouthOpenY', 0)
        this.lipSyncRaf = null
      }
    }

    this.lipSyncRaf = requestAnimationFrame(updateLip)
  }
}
