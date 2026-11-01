/**
 * dsh-routing-quality — task routing + output quality guard.
 *
 * This plugin deliberately has no runtime dependencies.  It applies a short
 * contract only when the task needs it, keeps the checker host-resident but filters
 * it from simple and medium model schemas, and never starts another model
 * generation request.
 */

export const name = 'dsh-routing-quality'
export const version = '0.2.4'
export const inject = ['systemPrompt', 'tools', 'webServer', 'connection', 'userQuestions', 'llm']

const CONTRACT_VERSION = '2026-11-01.6'
const MARKER = '[dsh-routing-quality]'
const SECTION = 'dsh-routing-quality-contract'
const MAX_TASK = 2000
const MAX_TASK_SOURCE = 32 * 1024
const MAX_OUTPUT = 512 * 1024
const STATE_TTL_MS = 6 * 60 * 60 * 1000
const MAX_TRACKED_SESSIONS = 256
// 选择题的默认等待时间：足够让用户看到并回答，又不会让模型请求无限期挂起。
const ASK_TIMEOUT_MS = 25 * 1000

const REACT_RE = /(开发|创建|写一个|生成|从零|做一个|游戏|网页|网站|构建|新项目|搭建|实现|脚本|工具|应用|build|create|develop|generate|implement|new project)/i
const FIX_RE = /(修复|调试|排查|报错|崩溃|故障|兼容|迁移|升级|回归|fix|debug|broken|repair|refactor|regression|incident)/i
const API_RE = /(api|接口|json|schema|响应|response|输出质量|openai|兼容|结构化|字段|sse|streaming|webhook)/i
const ANALYSIS_RE = /(分析|比较|评估|研究|解释|审查|调研|方案|原因|analy[sz]e|compare|review|research|explain|evaluate)/i
const COMPLEX_RE = /(架构|重构|全面|系统|多步骤|迁移|安全|并发|性能|兼容|发布|部署|设计|全面优化|architecture|refactor|comprehensive|multi[- ]step|migration|security|concurrency|performance|release|deploy|design)/i
const HIGH_RISK_RE = /(安全|鉴权|认证|权限|生产|删除|清空|迁移|回滚|支付|密钥|隐私|并发|数据库|发布|部署|数据丢失|security|auth(?:entication|orization)?|permission|production|delete|drop|migration|rollback|payment|secret|privacy|concurrency|database|release|deploy|data loss)/i
const ACTION_RE = /(修改|修复|创建|实现|构建|重构|运行|执行|写入|保存|调用|部署|发布|迁移|删除|清空|fix|change|implement|build|run|execute|write|save|call|deploy|release|migrate|delete|drop|code|script|plugin)/i
const EFFORT_RE = /(?:\/effort\s*:\s*|(?:思考强度|thinking(?:\s+(?:effort|level|strength))?)\s*[=:：]\s*)(off|minimal|low|medium|high|xhigh|max|inherit)\b/i
const FAST_RE = /(一句话|简短|快速|只要|翻译|拼写|改名|单步|what is|how do i|translate|typo|rename|one[- ]line)/i
const EFFORT_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const OPERATION_RE = /(修改|修复|调试|排查|创建|实现|构建|重构|运行|执行|写入|保存|调用|部署|发布|迁移|删除|清空|开发|搭建|编写|写一个|做一个|\b(?:fix|change|debug|repair|implement|build|create|develop|refactor|run|execute|write|save|call|deploy|release|migrate|delete|drop)\b)/i
const INFORMATION_RE = /^(?:(?:请|帮我|替我|简单|简短|快速|一句话|用一句话|告诉我|说说|讲讲|please\b|briefly\b|quickly\b|(?:can|could)\s+you\b)\s*)*(?:解释|介绍|科普|定义|翻译|什么是|如何|怎么|\b(?:explain|define|translate|what\s+(?:is|are)|how\s+(?:does|do|to)|meaning\s+of)\b)|(?:是什么意思|是什么|什么原理)\s*[？?。.!！]*$/i
const DIRECT_OPERATION_RE = /(?:^|[，。！？；,;.!?\n]|并且?|然后|接着|同时|\band(?:\s+then)?\b)\s*(?:(?:请|帮我|替我|给我|先|再|快速|简短|只要|只需|立刻|直接|please|quickly|briefly|just|first)\s*)*(?:修改|修复|调试|排查|创建|实现|构建|重构|运行|执行|写入|保存|调用|部署|发布|迁移|删除|清空|开发|搭建|编写|写一个|做一个|\b(?:fix|change|debug|repair|implement|build|create|develop|refactor|run|execute|write|save|call|deploy|release|migrate|delete|drop)\b)/i
const DEEP_REQUEST_RE = /(全面|深入|详细|系统性|多步骤|比较|评估|权衡|逐项|\b(?:comprehensive|in[- ]depth|detailed|compare|evaluate|tradeoffs?|multi[- ]step)\b)/i
const CODE_RE = /(代码|脚本|插件|仓库|文件|网页|接口|程序|模块|解析器|编译|测试|\b(?:api|code|script|plugin|repository|file|parser|module|tests?)\b)/i
const JSON_OUTPUT_RE = /(?:返回|输出|回复|答复|给我|只要|仅要|只需|仅需|\b(?:return|output|emit|only|respond(?:\s+(?:with|in))?|give\s+me|provide)\b)\s*(?:(?:严格|合法|有效|纯|仅|只|一个|一份|strict|valid|raw|only|a|an)\s*)*(?:JSON\b|application\/json)|(?:以|用|采用|按)\s*JSON\s*(?:格式|形式|输出|返回|回复|回答)|\b(?:as|in)\s+(?:(?:strict|valid|raw|pure)\s+)?JSON\b|(?:格式|format(?:\s+as)?)\s*[:：=]?\s*JSON\b/i

function isInformationalTask(text) {
  return INFORMATION_RE.test(text) && !DIRECT_OPERATION_RE.test(text)
}

function jsonWithExplanation(text) {
  if (!/\bJSON\b/i.test(text) || isInformationalTask(text)) return false
  if (/(?:只(?:要|需)?|仅(?:要|需)?|\b(?:only|exclusively)\b)\s*(?:返回|输出|回复|答复|\b(?:return|output|respond(?:\s+with)?)\b)?\s*(?:合法|有效|严格|valid|strict)?\s*JSON\b/i.test(text)) return false
  return /(?:[，；,;\n]\s*(?:并且?|然后|同时|再)?|并且?|然后|同时|\b(?:and|then|followed\s+by)\b)\s*(?:请|给我|另外)?\s*(?:解释|说明|解读|\b(?:explain|describe)\b)/i.test(text)
}

function requestsJson(text) {
  if (jsonWithExplanation(text)) return false
  if (/(?:不要|不用|无需|不需要|禁止|别|\bdo\s+not|\bdon't|\bno)\s*(?:输出|返回|用|使用|return\s+|output\s+)?JSON\b/i.test(text)) return false
  const clauses = text.replace(EFFORT_RE, '').split(/[，。！？；,;!?\n]/)
  for (const clause of clauses) {
    const instruction = clause.trim().replace(/^(?:(?:请|帮我|替我|最后|最终|并且|并|然后|快速|简短|回答时|回复时|please\b|finally\b|then\b|quickly\b|briefly\b)\s*)+/i, '')
    const plain = instruction.replace(/^(?:只需|仅需|只|仅|only\b|just\b)\s*/i, '')
    if (instruction.match(JSON_OUTPUT_RE)?.index === 0 || plain.match(JSON_OUTPUT_RE)?.index === 0) return true
    if (/^(?:给出|生成|提供|\b(?:produce|generate)\b)\s*(?:(?:一个|一份|合法|有效|严格|a|an|valid|strict)\s*)*JSON\b(?:\s*(?:响应|内容|对象|数组|示例|样例|模板|结果|数据|格式|response|object|array|example|template|data))?\s*$/i.test(plain)) return true
  }
  return !isInformationalTask(text) && !FIX_RE.test(text)
    && /JSON\s*(?:对象|数组|示例|样例|响应示例|模板)|\bJSON\s+(?:object|array|example|template)\b/i.test(text)
}

function isImplementationTask(text) {
  return !isInformationalTask(text) && OPERATION_RE.test(text) && (FIX_RE.test(text) || CODE_RE.test(text))
}

function safeString(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function utf8ByteLength(value) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).byteLength
  return safeString(value).length
}

function clip(value, limit) {
  const text = safeString(value).trim()
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

function unwrapMessage(message) {
  if (!message || typeof message !== 'object') return message
  if (message.message && typeof message.message === 'object') return message.message
  if (message.data?.message && typeof message.data.message === 'object') return message.data.message
  if (message.data && typeof message.data === 'object') return message.data
  return message
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    if (typeof part === 'string') return part
    if (!part || typeof part !== 'object') return ''
    if (typeof part.text === 'string') return part.text
    if (typeof part.content === 'string') return part.content
    if (typeof part.value === 'string') return part.value
    return ''
  }).filter(Boolean).join(' ')
}

/** Extract bounded raw task text for classification and task identity. */
function extractFullText(message) {
  const payload = unwrapMessage(message)
  if (!payload || typeof payload !== 'object') return ''
  return clip(payload.text || contentText(payload.content), MAX_TASK_SOURCE)
}

/** Extract user text from flat and injector-generated nested message shapes. */
export function extractText(message) {
  return clip(extractFullText(message), MAX_TASK)
}

function sourceKind(message) {
  const payload = unwrapMessage(message)
  return payload?.source?.kind || message?.source?.kind || message?.data?.source?.kind || ''
}

function sourceCallId(message) {
  const payload = unwrapMessage(message)
  return payload?.source?.callId || message?.source?.callId || message?.data?.source?.callId || ''
}

function isRealUser(message) {
  const payload = unwrapMessage(message)
  if (!payload || typeof payload !== 'object') return false
  const role = payload.role || payload.kind
  const source = sourceKind(payload)
  return (role === 'user' || role === 'user/message') && source !== 'plugin'
}

function messagesOf(session) {
  try {
    if (typeof session?.deriveMessages === 'function') {
      const messages = session.deriveMessages()
      if (Array.isArray(messages)) return messages.filter(Boolean)
    }
    if (typeof session?.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      if (Array.isArray(events)) return events.map((event) => event?.data || event?.message || event).filter(Boolean)
    }
  } catch { /* fall through to the lightweight test/session projection */ }
  const events = Array.isArray(session?.events) ? session.events : []
  return events.map((event) => event?.data || event?.message || event).filter(Boolean)
}

export function latestRealUserMessage(messages) {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isRealUser(messages[index]) && extractText(messages[index])) return messages[index]
  }
  return undefined
}

function isTaskContinuation(task) {
  const text = safeString(task).replace(EFFORT_RE, '').trim().toLowerCase()
    .replace(/[\s，。！？；,.!?;]+/g, '')
  return /^(?:(?:好的?|那就|请|麻烦)(?:你)?)?(?:继续(?:吧|做|处理|执行|测试(?:一下|一遍)?|验证(?:一下|一遍)?)?|接着(?:做|处理)?|测试(?:一下|一遍|下)?|测(?:一下|一遍|下)|验证(?:一下|一遍|下)?|再(?:测|测试|验证)(?:一下|一遍)?|跑(?:一下)?(?:测试|回归测试))(?:吧|即可|就行)?$/.test(text)
    || /^(?:please)?(?:continue|goon|proceed|testit|runtests|runthetests|verifyit)(?:please)?$/.test(text)
}

function taskWithContext(task, previousTask) {
  const text = safeString(task).trim()
  if (!isTaskContinuation(text)) return text
  if (!previousTask) return ''
  const override = parseEffortOverride(text)
  if (override === undefined) return previousTask
  return `/effort:${override} ${previousTask.replace(EFFORT_RE, '').trim()}`
}

/** Fold real user turns so resume uses the latest task and preserves pure follow-ups. */
function activeUserTask(messages) {
  let task = ''
  if (!Array.isArray(messages)) return task
  for (const message of messages) {
    if (!isRealUser(message) || sourceKind(message) === 'user-question-reply') continue
    const text = extractFullText(message)
    if (text) task = taskWithContext(text, task)
  }
  return task
}

/** Small deterministic fingerprint; no task text is sent to the status endpoint. */
export function messageKey(message) {
  const source = safeString(message?.id) || extractText(message)
  let hash = 2166136261
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

export function classifyTask(task) {
  const text = safeString(task)
  const api = API_RE.test(text)
  const react = REACT_RE.test(text)
  const fix = FIX_RE.test(text)
  const analysis = ANALYSIS_RE.test(text)
  if (api) return 'api'
  if (react && !fix) return 'build'
  if (fix && !react) return 'fix'
  if (analysis && !react && !fix) return 'analysis'
  if (react && fix) return 'mixed'
  return 'general'
}

export function complexityBand(task) {
  const text = safeString(task).trim()
  if (!text) return 'fast'
  const lineCount = text.split(/\r?\n/).length
  // 风险与明确格式要求不能被“快速/只要”等篇幅偏好覆盖。
  if (riskBand(text) === 'critical') return 'full'
  const json = requestsJson(text)
  if (!json && isInformationalTask(text) && !DEEP_REQUEST_RE.test(text) && text.length <= 180 && lineCount <= 2) return 'fast'
  if (COMPLEX_RE.test(text) || text.length > 280 || lineCount >= 5 || (API_RE.test(text) && text.length > 180)) return 'full'
  if (json || isImplementationTask(text)) return 'guarded'
  if (FAST_RE.test(text) && text.length <= 180) return 'fast'
  if (text.length <= 90 && !API_RE.test(text) && lineCount <= 2) return 'fast'
  return 'guarded'
}

export function riskBand(task) {
  const text = safeString(task).trim()
  if (isInformationalTask(text)) return 'low'
  if (HIGH_RISK_RE.test(text) && OPERATION_RE.test(text)) return 'critical'
  if (ACTION_RE.test(text)) return 'normal'
  return 'low'
}

export function parseEffortOverride(task) {
  const match = safeString(task).match(EFFORT_RE)
  return match ? match[1].toLowerCase() : undefined
}

function normalizeEffortChoice(value) {
  const text = safeString(value).trim().toLowerCase()
  if (!text) return undefined
  if (text === 'inherit' || /保持当前|当前设置|不改变|keep\s+current|unchanged/.test(text)) return 'inherit'
  const match = text.match(/(?:^|[^a-z])(off|minimal|low|medium|high|xhigh|max)(?:$|[^a-z])/i)
  return match ? match[1].toLowerCase() : undefined
}

/** Parse a choice returned by the native ask_user_question service. */
export function parseEffortSelection(message) {
  const source = sourceKind(message)
  const answerLike = source === 'user-question-reply'
    || message?.answers !== undefined
    || message?.selected !== undefined
    || message?.selection !== undefined
  if (!answerLike) return parseEffortOverride(extractText(message))
  const candidates = []
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== 'object') {
      if (typeof value === 'string') candidates.push(value)
      return
    }
    for (const key of ['selected', 'selection', 'choice', 'value', 'label', 'custom']) {
      if (value[key] !== undefined) visit(value[key])
    }
    if (value.answers !== undefined) visit(value.answers)
  }
  visit(message)
  const payload = unwrapMessage(message)
  if (payload !== message) visit(payload)
  const serialized = payload && typeof payload === 'object'
    ? typeof payload.text === 'string'
      ? payload.text
      : contentText(payload.content)
    : ''
  if (serialized.trim()) {
    try { visit(JSON.parse(serialized)) } catch { /* ordinary answer objects are handled above */ }
  }
  for (const candidate of candidates) {
    const choice = normalizeEffortChoice(candidate)
    if (choice !== undefined) return choice
  }
  return undefined
}

function normalizeEfforts(values) {
  const entries = Array.isArray(values)
    ? values
    : values && typeof values === 'object'
      ? Object.keys(values)
      : []
  return [...new Set(entries
    .map((value) => typeof value === 'object' && value !== null ? value.id : value)
    .map((value) => safeString(value).toLowerCase())
    .filter((value) => EFFORT_LEVELS.includes(value)))]
}

export function clampEffort(requested, supportedEfforts) {
  const requestedId = safeString(requested).toLowerCase()
  const supported = normalizeEfforts(supportedEfforts)
  if (!supported.length || requestedId === 'inherit') return 'inherit'
  if (supported.includes(requestedId)) return requestedId
  const requestedIndex = EFFORT_LEVELS.indexOf(requestedId)
  if (requestedIndex < 0) return 'inherit'
  for (let index = requestedIndex; index < EFFORT_LEVELS.length; index++) {
    if (supported.includes(EFFORT_LEVELS[index])) return EFFORT_LEVELS[index]
  }
  for (let index = requestedIndex - 1; index >= 0; index--) {
    if (supported.includes(EFFORT_LEVELS[index])) return EFFORT_LEVELS[index]
  }
  return 'inherit'
}

export function resolveEffortPlan(task, options = {}) {
  const text = safeString(task).trim()
  const complexity = complexityBand(text)
  const risk = riskBand(text)
  const requested = parseEffortOverride(text)
  const selected = normalizeEffortChoice(options.selectedEffort)
  const hasSelected = selected !== undefined
  let automatic = 'off'
  if (risk === 'critical') automatic = complexity === 'full' ? 'max' : complexity === 'guarded' ? 'xhigh' : 'high'
  else if (risk === 'normal') automatic = complexity === 'full' ? 'high' : complexity === 'guarded' ? 'medium' : 'low'
  else if (complexity === 'full') automatic = 'high'
  else if (complexity === 'guarded') automatic = 'minimal'
  const desired = requested === 'inherit' || selected === 'inherit'
    ? 'inherit'
    : requested || selected || automatic
  const agent = options.agent
  const rawSupported = options.supportedEfforts
    ?? options.reasoningEfforts
    ?? agent?.model?.reasoning?.efforts
    ?? agent?.model?.reasoning?.supportedEfforts
    ?? agent?.runtimeContext?.model?.reasoning?.efforts
    ?? agent?.session?.model?.reasoning?.efforts
  const supported = rawSupported !== undefined
    ? normalizeEfforts(rawSupported)
    : undefined
  const candidate = desired === 'inherit'
    ? 'inherit'
    : supported !== undefined
      ? clampEffort(desired, supported)
      : options.providerSupported === true
        ? desired
        : 'inherit'
  const suggested = supported !== undefined
    ? clampEffort(automatic, supported)
    : options.providerSupported === true
      ? automatic
      : 'inherit'
  const source = requested ? 'user' : hasSelected ? 'user-choice' : 'automatic'
  const requiredChecks = risk !== 'low' || complexity !== 'fast'
  const canApply = candidate !== 'inherit' && (supported !== undefined || options.providerSupported === true)
  const requiresChoice = source === 'automatic' && requiredChecks && canApply
  return {
    effort: desired,
    requested: requested || null,
    automatic,
    suggested,
    source,
    choice: hasSelected ? selected : null,
    choiceConfirmed: source === 'user-choice',
    requiresChoice,
    complexity,
    risk,
    supported: supported ?? null,
    providerSupported: supported !== undefined || options.providerSupported === true,
    applied: source === 'automatic' ? 'inherit' : candidate,
    requiredChecks,
  }
}

export function classifyOutputMode(task) {
  const text = safeString(task)
  if (requestsJson(text)) return 'json'
  if (jsonWithExplanation(text) && !isImplementationTask(text)) return 'structured-text'
  if (isInformationalTask(text)) return 'prose'
  if (CODE_RE.test(text) || isImplementationTask(text)) return 'code'
  if (/(表格|列表|步骤|清单|报告|文档|说明)/i.test(text)) return 'structured-text'
  return 'prose'
}

function verificationHint(text, outputMode) {
  if (!isInformationalTask(text) && OPERATION_RE.test(text) && FIX_RE.test(text)) {
    return '先复现原问题；修复后运行针对性回归，记录实际检查命令与结果。'
  }
  if (isImplementationTask(text)) return '运行最小可用示例或必要测试，记录实际检查命令与结果。'
  if (outputMode === 'json') return '检查 JSON 可解析、必填字段及类型符合给定 schema。'
  if (riskBand(text) === 'critical') return '核对实际执行结果，记录关键检查及其证据。'
  if (outputMode === 'structured-text') return '核对必需条目和结论依据，清除占位与未完成项。'
  return '核对关键依据，区分事实、推断和仍未知的部分。'
}

export function buildQualityContract(task, options = {}) {
  // 与状态判定使用同一份有界任务，长任务末尾的格式要求也必须生效。
  const text = clip(task, MAX_TASK_SOURCE)
  const band = complexityBand(text)
  if (band === 'fast') return ''
  const outputMode = classifyOutputMode(text)
  const jsonRule = '严格输出合法 JSON，遵守给定 schema，不加 Markdown 围栏。'
  const verification = verificationHint(text, outputMode)
  const delivery = outputMode === 'json'
    ? '最终仅返回 JSON，不附加说明或自增字段；未运行的检查不能写成通过。'
    : '交付时说明实际检查结果与未验证项；未运行的检查不能写成通过。'
  if (band === 'guarded') {
    return [
      `${MARKER} medium: 抓住当前主路径，不扩展无关范围。`,
      outputMode === 'json' ? `${jsonRule}${verification}` : verification,
      delivery,
    ].join('\n')
  }
  const scope = riskBand(text) === 'critical'
    ? '先确定少量验收条件；涉及实际操作时核对目标、作用范围及可恢复方式。'
    : '先确定规格和少量验收条件，只保留完成当前目标所需的步骤、工具和证据。'
  const toolNote = options.qualityToolVisible
    ? 'routing_quality_check 只检查结构，不代表真实运行验证。'
    : ''
  return [
    `${MARKER} complex: 按当前目标、约束和风险完成任务。`,
    scope,
    outputMode === 'json' ? jsonRule : '按用户要求输出，先给结果，再给必要依据。',
    `${verification}${delivery}${toolNote}`,
  ].join('\n')
}

function statusFor(record, sid) {
  return {
    sessionId: sid || null,
    taskType: record?.taskType || 'general',
    complexity: record?.complexity || 'fast',
    risk: record?.risk || 'low',
    effort: record?.effort?.effort || 'off',
    effortApplied: record?.effort?.applied || 'inherit',
    effortSupported: record?.effort?.supported || null,
    effortSource: record?.effort?.source || 'automatic',
    outputMode: record?.outputMode || 'prose',
    lastUserAt: record?.lastUserAt || null,
    contractVersion: CONTRACT_VERSION,
  }
}

function sessionIdOf(exec) {
  return exec?.agent?.session?.id || exec?.session?.id || null
}

function check(name, pass, detail) {
  return { name, pass: Boolean(pass), detail: String(detail) }
}

function inferFormat(output, requested) {
  const value = safeString(requested).trim().toLowerCase()
  if (value && value !== 'auto') return value
  const text = safeString(output).trim()
  if (text.startsWith('{') || text.startsWith('[')) return 'json'
  return 'text'
}

function collectStatuses(value, path = '$', out = []) {
  if (!value || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStatuses(item, `${path}[${index}]`, out))
    return out
  }
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = String(key).toLowerCase()
    const normalizedValue = typeof item === 'string' ? item.toLowerCase() : ''
    if (['status', 'state', 'result'].includes(normalizedKey) && ['pending', 'fail', 'failed', 'blocked'].includes(normalizedValue)) {
      out.push({ status: normalizedValue === 'failed' ? 'fail' : normalizedValue, path: `${path}.${key}` })
    }
    if (['pending', 'fail', 'failed', 'blocked'].includes(normalizedKey) && item === true) {
      out.push({ status: normalizedKey === 'failed' ? 'fail' : normalizedKey, path: `${path}.${key}` })
    }
    collectStatuses(item, `${path}.${key}`, out)
  }
  return out
}

function strictJson(text) {
  const value = safeString(text)
  const trimmed = value.trim()
  const checks = []
  const fenced = /^```(?:json)?\s*[\s\S]*?```$/i.test(trimmed)
  checks.push(check('no-markdown-fence', !fenced, fenced ? 'JSON output contains a markdown fence' : 'no markdown fence'))
  try {
    const parsed = JSON.parse(trimmed.replace(/^\uFEFF/, ''))
    checks.push(check('valid-json', true, 'JSON.parse succeeded'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.ok === false) {
      const error = parsed.error
      const stable = error && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string'
      checks.push(check('stable-error-envelope', stable, stable ? 'error.code and error.message present' : 'ok:false requires error.code and error.message'))
    }
    const statuses = collectStatuses(parsed)
    checks.push(check('no-pending-fail-blocked', statuses.length === 0, statuses.length === 0 ? 'no pending/fail/blocked statuses' : `found ${statuses.length} unresolved status item(s)`))
    return { parsed, checks, statuses }
  } catch (error) {
    checks.push(check('valid-json', false, `invalid JSON: ${clip(error?.message || error, 180)}`))
    return { parsed: undefined, checks, statuses: [] }
  }
}

export function checkOutputQuality(output, requestedFormat = 'auto') {
  const value = safeString(output)
  const format = inferFormat(value, requestedFormat)
  const checks = [check('non-empty', value.trim().length > 0, value.trim() ? 'output is non-empty' : 'output is empty')]
  let statuses = []
  const outputBytes = utf8ByteLength(value)
  if (outputBytes > MAX_OUTPUT) checks.push(check('size-limit', false, `output exceeds ${MAX_OUTPUT} bytes (${outputBytes} bytes)`))
  else checks.push(check('size-limit', true, `within ${MAX_OUTPUT} byte limit (${outputBytes} bytes)`))
  if (format === 'json') {
    const result = strictJson(value)
    checks.push(...result.checks)
    statuses = result.statuses
  } else if (format === 'text' || format === 'markdown' || format === 'structured-text') {
    checks.push(check('no-unresolved-placeholder', !/(\{\{[^}]+\}\}|<TODO>|\bTBD\b)/i.test(value), 'no obvious unresolved placeholder'))
  } else {
    checks.push(check('known-format', false, `unsupported format: ${format}`))
  }
  const ok = checks.every((item) => item.pass)
  return {
    ok,
    format,
    checks,
    statuses,
    evidenceVerified: false,
    summary: ok ? 'structure checks passed; runtime evidence not verified' : 'structure checks failed; runtime evidence not verified',
  }
}

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function createToolController(ctx) {
  const checkTool = {
    name: 'routing_quality_check',
    description: '复杂任务中按需调用的本地结构检查；不读文件、不跑命令、不看截图、不发网络请求。',
    parameters: {
      type: 'object',
      properties: {
        output: { type: 'string', description: '待检查的完整输出' },
        format: { type: 'string', enum: ['auto', 'json', 'text', 'markdown', 'structured-text'] },
      },
      required: ['output'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args) { return checkOutputQuality(args?.output, args?.format) },
  }
  let registered = false
  let disposer
  if (ctx?.tools && typeof ctx.tools.register === 'function') {
    try {
      disposer = ctx.tools.register(checkTool)
      registered = true
    } catch {
      registered = false
      disposer = undefined
    }
  }
  ctx.effect?.(() => () => {
    if (typeof disposer === 'function') {
      try { disposer() } catch { /* idempotent dispose */ }
    }
  }, `${name}: tools`)
  return { checkTool, registered }
}

function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader?.('content-type', 'application/json; charset=utf-8')
  res.setHeader?.('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

function registerRoute(host, state, pruneState) {
  if (!host?.webServer?.register) return
  const register = () => host.webServer.register({
    kind: 'exact',
    path: '/dsh-routing-quality/status',
    handler: async (req, res) => {
      pruneState?.()
      const rejection = host.connection?.requestRejection?.(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'GET') {
        res.setHeader?.('allow', 'GET')
        sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use GET' } })
        return
      }
      const modes = {}
      const bands = {}
      const routeEffortCapabilities = {}
      for (const record of state.values()) {
        modes[record.taskType || 'general'] = (modes[record.taskType || 'general'] || 0) + 1
        bands[record.complexity || 'fast'] = (bands[record.complexity || 'fast'] || 0) + 1
        if (record.route && Array.isArray(record.effort?.supported)) routeEffortCapabilities[record.route] = [...record.effort.supported]
      }
      sendJson(res, 200, {
        ok: true,
        plugin: name,
        version,
        contractVersion: CONTRACT_VERSION,
        activeSessions: state.size,
        taskTypes: modes,
        complexityBands: bands,
        routeEffortCapabilities,
        effortLevels: [...EFFORT_LEVELS],
        knownEffortCapabilities: {
          builtInDeepSeek: ['off', 'low', 'high', 'max'],
          genericCatalog: [...EFFORT_LEVELS],
        },
        effortCapabilitySource: 'agent metadata or built-in provider rules; unknown routes inherit',
        capabilities: ['task-routing', 'same-request-guidance', 'manual-json-check', 'effort-clamp', 'no-secret-status'],
      })
    },
  }, `${name}: status api`)
  if (typeof host.effect === 'function') host.effect(register)
  else register()
}

function toolName(tool) {
  return tool?.name || tool?.function?.name || ''
}

function routerAllowsQualityTool(agent) {
  const tools = agent?.ctx?.get?.('tools')
  try {
    const visible = tools?.view?.(agent)?.visible
    if (visible && typeof visible.has === 'function') return visible.has('routing_quality_check')
  } catch { /* unknown tool view: use assembled schema as the final boundary */ }
  return undefined
}

function filterQualityTool(assembled, agent, band, checkTool, registered) {
  if (!Array.isArray(assembled?.tools)) return assembled
  const current = assembled.tools.filter((tool) => toolName(tool) !== checkTool.name)
  const alreadyPresent = assembled.tools.some((tool) => toolName(tool) === checkTool.name)
  const routerVisible = routerAllowsQualityTool(agent)
  const allowed = registered === true && band === 'full' && (routerVisible === true || (routerVisible === undefined && alreadyPresent))
  if (!alreadyPresent && !allowed) return assembled
  if (allowed && !alreadyPresent) current.push(checkTool)
  return { ...assembled, tools: current }
}

function supportedEffortsFor(agent) {
  const options = agent?.options || {}
  const declared = options.supportedEfforts
    ?? options.reasoningEfforts
    ?? agent?.model?.reasoning?.efforts
    ?? agent?.model?.reasoning?.supportedEfforts
    ?? agent?.runtimeContext?.model?.reasoning?.efforts
    ?? agent?.session?.model?.reasoning?.efforts
  if (declared !== undefined) return declared
  const provider = safeString(options.provider).toLowerCase()
  // 内置 DeepSeek adapter 明确只广告这四档；medium/xhigh 由其他 model catalog 按模型提供。
  if (provider.includes('deepseek')) return ['off', 'low', 'high', 'max']
  return undefined
}

function routeIdentity(agent) {
  const provider = safeString(agent?.options?.provider)
  const model = safeString(agent?.options?.model)
  return provider && model ? `${provider}\u0000${model}` : ''
}

function routeLabel(agent) {
  const provider = safeString(agent?.options?.provider)
  const model = safeString(agent?.options?.model)
  return provider && model ? `${provider}/${model}` : ''
}

async function resolveRouteEfforts(agent, signal, cache, llm) {
  const declared = supportedEffortsFor(agent)
  if (declared !== undefined) return normalizeEfforts(declared)
  const key = routeIdentity(agent)
  const modelService = llm || agent?.ctx?.get?.('llm') || agent?.ctx?.llm
  if (!key || !modelService || typeof modelService.resolveModelInfo !== 'function') return undefined
  if (!cache.has(key)) {
    const [provider, model] = key.split('\u0000')
    const pending = Promise.resolve()
      .then(() => modelService.resolveModelInfo(provider, model, signal))
      .then((info) => normalizeEfforts(info?.reasoning?.efforts))
      .then((efforts) => {
        if (efforts === undefined) cache.delete(key)
        else cache.set(key, efforts)
        return efforts
      })
      .catch(() => {
        cache.delete(key)
        return undefined
      })
    cache.set(key, pending)
  }
  return cache.get(key)
}

export function apply(ctx) {
  const state = new Map()
  const routeEffortCache = new Map()
  const pruneState = () => {
    const now = Date.now()
    for (const [sid, record] of state) {
      const at = Date.parse(record?.lastUserAt || '')
      if (!Number.isFinite(at) || now - at > STATE_TTL_MS) state.delete(sid)
    }
    if (state.size <= MAX_TRACKED_SESSIONS) return
    const oldest = [...state.entries()].sort((left, right) => {
      const leftAt = Date.parse(left[1]?.lastUserAt || '') || 0
      const rightAt = Date.parse(right[1]?.lastUserAt || '') || 0
      return leftAt - rightAt
    })
    for (let index = 0; index < oldest.length - MAX_TRACKED_SESSIONS; index++) state.delete(oldest[index][0])
  }
  const qualityTool = createToolController(ctx)
  const remember = (sid, task, agent, selectedEffort, routeEfforts) => {
    pruneState()
    if (!sid || !task) return undefined
    const current = state.get(sid) || {}
    const incoming = safeString(task).trim()
    const previousTask = current.taskSource || (isTaskContinuation(incoming) ? activeUserTask(messagesOf(agent?.session)) : '')
    const raw = clip(taskWithContext(incoming, previousTask), MAX_TASK_SOURCE)
    if (!raw) return undefined
    const text = clip(raw, MAX_TASK)
    const taskKey = messageKey({ id: raw })
    const sameTask = current.taskKey ? current.taskKey === taskKey : current.task === text
    const choice = selectedEffort !== undefined
      ? selectedEffort
      : sameTask
        ? current.effort?.choice
        : undefined
    const sameRoute = !current.route || current.route === routeLabel(agent)
    const supportedEfforts = routeEfforts ?? supportedEffortsFor(agent)
      ?? (sameTask && sameRoute ? current.effort?.supported ?? undefined : undefined)
    const effort = resolveEffortPlan(raw, { supportedEfforts, selectedEffort: choice })
    if (sameTask && current.effort?.choiceAsked) effort.choiceAsked = true
    if (sameTask && current.effort?.questionCallId) effort.questionCallId = current.effort.questionCallId
    const record = {
      ...current,
      route: routeLabel(agent) || current.route || undefined,
      task: text,
      taskSource: raw,
      taskType: classifyTask(raw),
      complexity: complexityBand(raw),
      risk: riskBand(raw),
      effort,
      outputMode: classifyOutputMode(raw),
      lastUserAt: sameTask ? current.lastUserAt || new Date().toISOString() : new Date().toISOString(),
      taskKey,
    }
    state.set(sid, record)
    return record
  }

  const askEffortChoice = async (agent, record, signal) => {
    const sid = agent?.session?.id
    const plan = record?.effort
    if (!sid || !plan?.requiresChoice || plan.choiceAsked) return record
    const service = ctx?.userQuestions
    if (!service || typeof service.askTimed !== 'function') return state.get(sid) || record
    const callId = `routing-effort-${record?.taskKey || sid}`
    const current = state.get(sid)
    if (!current || current.taskKey !== record.taskKey) return current || record
    current.effort = { ...current.effort, choiceAsked: true, questionCallId: callId }
    const supported = Array.isArray(plan.supported) && plan.supported.length
      ? plan.supported
      : EFFORT_LEVELS
    const options = [
      { label: '保持当前 effort', description: '不覆盖模型或宿主当前的思考强度设置。' },
      ...supported.map((effort) => ({
        label: effort,
        description: effort === plan.suggested ? 'Router 根据当前任务和模型能力给出的建议档位。' : '明确使用这一档思考强度。',
      })),
    ]
    let selected
    let outcome = 'failed'
    try {
      const request = {
        agent,
        questions: [{
          id: 'routing-effort',
          header: '思考强度',
          question: `当前任务建议使用 ${plan.suggested || plan.automatic}。请选择是否调整 effort。`,
          options,
          multiSelect: false,
        }],
      }
      // askTimed 让请求有明确上限：没有界面回答时按超时返回 pending，
      // 不修改宿主 effort，问题卡片仍可在界面上继续回答。
      const controller = new AbortController()
      const requestSignal = signal && typeof AbortSignal?.any === 'function'
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal
      let timer
      let timeoutResolve
      const timeoutResult = new Promise((resolve) => {
        timeoutResolve = resolve
        timer = setTimeout(() => {
          controller.abort()
          resolve({ pending: true, callId })
        }, ASK_TIMEOUT_MS)
      })
      let answer
      try {
        const asking = service.askTimed({ ...request, signal: requestSignal }, callId, ASK_TIMEOUT_MS)
        answer = await Promise.race([asking, timeoutResult])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        timeoutResolve = undefined
      }
      if (answer?.pending === true) {
        outcome = 'pending'
      } else {
        const choice = parseEffortSelection(answer)
        if (choice !== undefined) {
          selected = choice
          outcome = 'answered'
        }
      }
    } catch {
      outcome = 'failed'
    }
    const live = state.get(sid)
    if (!live || live.taskKey !== record.taskKey || live.effort?.questionCallId !== callId) return live || record
    if (outcome === 'pending') return live
    if (outcome === 'failed') {
      live.effort = { ...live.effort, choiceAsked: false }
      delete live.effort.questionCallId
      return live
    }
    const updated = remember(sid, live.taskSource || live.task, agent, selected)
    if (updated?.effort) {
      updated.effort.choiceAsked = true
      delete updated.effort.questionCallId
    }
    return updated || live
  }

  ctx?.on?.('agent/inbox/claimed', ({ agent, message } = {}) => {
    const sid = agent?.session?.id
    if (sourceKind(message) === 'user-question-reply') {
      const selected = parseEffortSelection(message)
      const current = sid ? state.get(sid) : undefined
      const expectedCallId = current?.effort?.questionCallId
      const replyCallId = sourceCallId(message)
      if (selected !== undefined && current?.taskSource && expectedCallId && replyCallId === expectedCallId) {
        const updated = remember(sid, current.taskSource, agent, selected, current.effort?.supported)
        if (updated?.effort) {
          updated.effort.choiceAsked = true
          delete updated.effort.questionCallId
        }
      }
      return
    }
    if (!isRealUser(message)) return
    const record = remember(sid, extractFullText(message), agent)
    if (record) record.lastUserAt = new Date().toISOString()
  })

  ctx?.on?.('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context?.agent
    const sid = agent?.session?.id
    const task = state.get(sid)?.taskSource || activeUserTask(messagesOf(agent?.session))
    if (!task) return assembled
    const routeEfforts = await resolveRouteEfforts(agent, undefined, routeEffortCache, ctx?.llm)
    const record = remember(sid, task, agent, undefined, routeEfforts)
    const routed = filterQualityTool(assembled, agent, record?.complexity || 'fast', qualityTool.checkTool, qualityTool.registered)
    const contract = buildQualityContract(task, {
      qualityToolVisible: Array.isArray(routed?.tools) && routed.tools.some((tool) => toolName(tool) === qualityTool.checkTool.name),
    })
    const originalSections = routed?.sections
    const sections = Array.isArray(originalSections)
      ? originalSections.filter((item) => item?.name !== SECTION)
      : []
    // 无论当前任务档位如何，先移除上一任务留下的契约；没有旧 section 时保留原对象身份。
    if (!contract || record?.complexity === 'fast') {
      if (!Array.isArray(originalSections) || sections.length === originalSections.length) return routed
      return { ...routed, sections }
    }
    sections.push({ name: SECTION, order: 900, text: contract })
    return { ...routed, sections }
  })

  ctx?.on?.('agent/pre-step', async (payload = {}, next) => {
    const agent = payload.agent
    const sid = agent?.session?.id
    const history = messagesOf(agent?.session)
    const user = latestRealUserMessage(payload.messages) || latestRealUserMessage(history)
    const currentTask = sid ? state.get(sid)?.taskSource || state.get(sid)?.task : ''
    const choiceReply = sourceKind(user) === 'user-question-reply'
    const task = choiceReply ? currentTask : activeUserTask(payload.messages) || activeUserTask(history) || currentTask
    if (sid && task) {
      const routeEfforts = await resolveRouteEfforts(agent, payload.signal, routeEffortCache, ctx?.llm)
      const record = remember(sid, task, agent, undefined, routeEfforts)
      await askEffortChoice(agent, record, payload.signal)
    }
    const decision = await next()
    if (!sid) return decision
    const nextUser = latestRealUserMessage(decision?.messages)
    if (nextUser && extractFullText(nextUser) && !state.get(sid)?.taskSource) remember(sid, extractFullText(nextUser), agent)
    // 选择题本身不插入额外 user message，也不会增加模型回合。
    return decision
  })

  ctx?.on?.('agent/request', async ({ agent } = {}, next) => {
    const resolved = await next()
    const sid = agent?.session?.id
    let plan = sid ? state.get(sid)?.effort : undefined
    if (sid && plan?.applied === 'inherit') {
      const taskSource = state.get(sid)?.taskSource
      const routeEfforts = await resolveRouteEfforts(agent, undefined, routeEffortCache, ctx?.llm)
      if (taskSource && routeEfforts !== undefined) {
        plan = remember(sid, taskSource, agent, undefined, routeEfforts)?.effort || plan
      }
    }
    if (!plan || plan.applied === 'inherit') return resolved
    if (plan.source !== 'user' && plan.source !== 'user-choice') return resolved
    if (resolved?.reasoningEffort === plan.applied) return resolved
    return { ...resolved, reasoningEffort: plan.applied }
  })

  if (ctx?.webServer) registerRoute(ctx, state, pruneState)
  else if (typeof ctx?.inject === 'function') ctx.inject(['webServer'], (host) => registerRoute(host, state, pruneState))

  return { state }
}

export default { name, version, inject, apply }
