import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const RAG_DIR = path.join(__dirname, '..', 'rag_docs')

export interface RagChunk {
  filePath: string
  fileName: string
  content: string
  keywords: string[]
}

let cachedChunks: RagChunk[] = []

// Stopwords dalam Bahasa Indonesia & Inggris untuk menyaring kata kunci pencarian
const STOPWORDS = new Set([
  'dan', 'di', 'ke', 'dari', 'yang', 'ini', 'itu', 'adalah', 'yaitu', 'yakni',
  'untuk', 'dengan', 'pada', 'oleh', 'juga', 'akan', 'telah', 'sudah', 'belum',
  'saya', 'aku', 'kamu', 'dia', 'mereka', 'kita', 'kami', 'apa', 'siapa', 'mengapa',
  'bagaimana', 'kapan', 'dimana', 'sangat', 'sekali', 'saja', 'jika', 'kalau',
  'atau', 'karena', 'sehingga', 'maka', 'tapi', 'namun', 'ada', 'bisa', 'dapat',
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'from', 'by', 'of',
  'about', 'with', 'for', 'is', 'are', 'was', 'were', 'it', 'he', 'she', 'they', 'we',
  'you', 'i', 'my', 'your', 'his', 'her', 'their', 'our', 'what', 'who', 'why', 'how',
  'where', 'when', 'which', 'this', 'that', 'these', 'those'
])

/**
 * Membersihkan teks dari tanda baca dan membaginya menjadi kata-kata (token)
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 1 && !STOPWORDS.has(word))
}

/**
 * Membaca semua file .md di folder rag_docs dan menyusun potongan-potongan teks (chunking)
 */
export function buildIndex(): void {
  try {
    if (!fs.existsSync(RAG_DIR)) {
      fs.mkdirSync(RAG_DIR, { recursive: true })
    }

    const files = fs.readdirSync(RAG_DIR)
    const markdownFiles = files.filter(f => f.endsWith('.md'))
    const newChunks: RagChunk[] = []

    for (const file of markdownFiles) {
      const filePath = path.join(RAG_DIR, file)
      const content = fs.readFileSync(filePath, 'utf-8')

      // Memotong dokumen berdasarkan baris kosong ganda (paragraf) atau header (##)
      const sections = content.split(/(?=\n##\s+)/)

      for (const section of sections) {
        const trimmed = section.trim()
        if (trimmed.length < 20) continue // Hiraukan paragraf yang terlalu pendek

        newChunks.push({
          filePath,
          fileName: file,
          content: trimmed,
          keywords: tokenize(trimmed),
        })
      }
    }

    cachedChunks = newChunks
    console.error(`[RAG] Index built successfully. Loaded ${cachedChunks.length} chunks from ${markdownFiles.length} files.`)
  } catch (err) {
    console.error('[RAG] Failed to build index:', err)
  }
}

/**
 * Melakukan pencarian RAG berbasis pencocokan kata kunci relevan
 */
export function searchDocs(query: string, limit = 3): string {
  if (cachedChunks.length === 0) {
    buildIndex()
  }

  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return ''

  console.error('[RAG] Searching for keywords:', queryTokens)

  const scored = cachedChunks.map(chunk => {
    let score = 0

    // 1. Pencocokan token kata kunci
    for (const token of queryTokens) {
      // Jika kata kunci persis ada dalam teks
      if (chunk.content.toLowerCase().includes(token)) {
        score += 2
      }
      // Jika kata kunci ada dalam daftar token chunk
      if (chunk.keywords.includes(token)) {
        score += 1
      }
    }

    // 2. Bonus jika judul/header cocok dengan kata kunci
    const firstLine = chunk.content.split('\n')[0] || ''
    for (const token of queryTokens) {
      if (firstLine.toLowerCase().includes(token)) {
        score += 3
      }
    }

    return { chunk, score }
  })

  // Saring chunk yang memiliki skor kecocokan > 0, urutkan dari skor tertinggi
  const results = scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.chunk.content)

  if (results.length === 0) {
    console.error('[RAG] No matching document found.')
    return ''
  }

  console.error(`[RAG] Found ${results.length} relevant context chunks.`)
  return results.join('\n\n---\n\n')
}
