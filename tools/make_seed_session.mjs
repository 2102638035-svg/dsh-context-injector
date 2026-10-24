// 构造一个「带伪造历史」的 DSH 会话文件（离线生成，先不放进 sessions）
// 结构完全照抄真实会话：header + 初始化事件 + 每轮 (inbox → turn/start → step/start → user/message → delivery → assistant/message → step/end → turn/end)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib'
import { randomUUID } from 'node:crypto'

const ZSTD_MAGIC = 4247762216
const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`bad magic @${offset}`)
    offset += 4
    const d = buffer.readUInt8(offset); offset += 1
    const csf = d >>> 6, ss = (d & 32) !== 0, ck = (d & 4) !== 0, df = d & 3
    offset += (ss ? 0 : 1) + (df === 3 ? 4 : df) + (csf === 0 ? (ss ? 1 : 0) : (1 << csf))
    for (;;) {
      const bh = buffer.readUIntLE(offset, 3); offset += 3
      const last = (bh & 1) !== 0, bt = (bh >>> 1) & 3, bs = bh >>> 3
      offset += bt === 1 ? 1 : bs
      if (last) break
    }
    if (ck) offset += 4
    frames.push({ start, end: offset })
  }
  return frames
}

const TEMPLATE = process.argv[2]   // 模板会话文件
const OUTDIR = process.argv[3]     // 输出目录
const DIALOG = process.argv[4]     // 对话 JSON 文件
if (!TEMPLATE || !OUTDIR || !DIALOG) { console.error('usage: node make_seed_session.mjs <template.zstd> <outdir> <dialog.json>'); process.exit(2) }

// 1) 读模板，取 header 和初始化事件
const raw = readFileSync(TEMPLATE)
const frames = scanFrames(raw)
const parts = frames.map(f => zstdDecompressSync(raw.subarray(f.start, f.end)).toString('utf8'))
const templateEvents = parts.join('').split('\n').filter(Boolean).map(l => JSON.parse(l))
const templateHeader = templateEvents[0]
const initTypes = ['permission/preset', 'sandbox/mode', 'approval/policy', 'agent-preset/selected', 'session/end-seed']
const initEvents = templateEvents.filter(e => initTypes.includes(e.type))

// 2) 读对话脚本
const dialog = JSON.parse(readFileSync(DIALOG, 'utf8'))  // [{role:'user'|'assistant', text:'...'}]

// 3) 组装
const sessionId = 'session-' + randomUUID()
const now = Date.now()
const events = []
let seq = 0
const push = (type, data, extra = {}) => { events.push({ type, seq: seq++, time: now, data, ...extra }) }

// header
const header = { ...templateHeader, id: sessionId, createdAt: now, isSeeded: false }
events.push(header)
for (const e of initEvents) {
  events.push({ ...e, seq: seq++, time: now })
}
// 重新排序 seq（init 事件原本有自己的 seq）
events.forEach((e, i) => { if (e.type !== 'session') e.seq = i - 1 })

const RECORDS = []
for (let turn = 1; turn <= Math.ceil(dialog.length / 2); turn++) {
  const userMsg = dialog[(turn - 1) * 2]
  const asstMsg = dialog[(turn - 1) * 2 + 1]
  if (!userMsg) break
  const userId = randomUUID()
  const record = {
    content: [{ type: 'text', text: userMsg.text }],
    source: { kind: 'user', rpcId: randomUUID(), clientTimeZone: 'Asia/Shanghai' },
    role: 'user',
    id: userId,
  }
  // inbox 入队
  push('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [record] })
  push('turn/start', { turn })
  push('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  push('step/start', { turn, step: 1 })
  push('user/message', {
    role: 'user',
    content: [{ type: 'text', text: userMsg.text }],
    source: record.source,
    id: userId,
  }, { surfaceOp: 'append' })
  push('session-log-deepseek/delivery-accepted', { sessionId, sessionFormatVersion: 4, throughSeq: seq - 1 })
  if (asstMsg) {
    push('assistant/message', {
      turn,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: asstMsg.text }],
        source: {
          kind: 'model',
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          replayState: {
            response: { kind: 'deepseek-messages', version: 1, model: 'deepseek-flash' },
            blocks: [{ type: 'text' }],
          },
        },
        id: randomUUID(),
      },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
      stream: [],
    }, { surfaceOp: 'append' })
  }
  push('step/end', { turn, step: 1 })
  push('turn/end', { turn, reason: { kind: 'completed' } })
}

// 4) 每帧一个 batch（header 一帧，其余按事件分帧）
mkdirSync(OUTDIR, { recursive: true })
const chunks = []
chunks.push(zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'), CHECKSUM))
for (const e of events.slice(1)) {
  chunks.push(zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8'), CHECKSUM))
}
const dir = `${OUTDIR}/${sessionId}`
mkdirSync(dir, { recursive: true })
const outFile = `${dir}/session.v4.jsonl.zstd`
writeFileSync(outFile, Buffer.concat(chunks))

console.log(`会话 ID: ${sessionId}`)
console.log(`事件数: ${events.length}（其中轮次 ${Math.ceil(dialog.length / 2)}）`)
console.log(`帧数: ${chunks.length}`)
console.log(`输出: ${outFile}`)

// 5) 自检
const back = readFileSync(outFile)
const bf = scanFrames(back)
const bl = bf.map(f => zstdDecompressSync(back.subarray(f.start, f.end)).toString('utf8')).join('').split('\n').filter(Boolean).map(l => JSON.parse(l))
console.log(`回读事件数: ${bl.length}`)
const seqs = bl.filter(e => e.seq !== undefined).map(e => e.seq)
let okSeq = seqs.every((s, i) => s === i)
console.log(`seq 连续: ${okSeq ? '✅' : '❌ ' + seqs.slice(0, 5)}`)
const users = bl.filter(e => e.type === 'user/message')
const assts = bl.filter(e => e.type === 'assistant/message')
console.log(`user/message: ${users.length}  assistant/message: ${assts.length}`)
const badRole = users.filter(e => e.data.role !== 'user').length + assts.filter(e => e.data.message.role !== 'assistant').length
console.log(`角色合法: ${badRole === 0 ? '✅' : '❌ ' + badRole + ' 条不符'}`)
