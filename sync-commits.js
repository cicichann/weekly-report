#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const ExcelJS = require('exceljs')

const config = require('./config')

const {
  gitlab,
  jira,
  projectGroupMap,
  noTypeProjectIds,
  typeColorMap,
  output,
  filters
} = config

const GITLAB_BASE_URL = gitlab.baseUrl
const GITLAB_USER_ID = gitlab.userId
const GITLAB_TOKEN = gitlab.token
const JIRA_BASE_URL = jira.baseUrl

const excelConfig = {
  file: './周报.xlsx',
  sheetName: '当周数据维护',
  startRow: 2,
  endRow: 100,
  ...config.excel
}

const outputConfig = {
  dir: output.dir,
  gitJsonFile: 'weekly-report.git-commits.json',
  excludedEventsFile: 'weekly-report.excluded-events.json',
  excludedCommitsFile: 'weekly-report.excluded.json',
  compareLogsFile: 'weekly-report.compare-logs.json',
  ...output
}

if (!GITLAB_TOKEN) {
  console.error('错误：缺少 GITLAB_TOKEN 环境变量')
  console.error('示例：GITLAB_TOKEN="你的token" node sync-commits.js')
  process.exit(1)
}

const args = parseArgs(process.argv.slice(2))
const defaultRange = getDefaultRange()
const after = normalizeDateArgument(args.after || defaultRange.after)
const before = normalizeDateArgument(args.before || defaultRange.before)
const shouldUpdateExcel = args.excel !== 'false'

const excludedEvents = []
const excludedCommits = []
const compareLogs = []

main().catch((error) => {
  console.error('执行失败：')
  console.error(error)
  process.exit(1)
})

async function main() {
  console.log(`开始获取 GitLab 事件：${after} ~ ${before}`)

  const events = await fetchAllGitlabEvents({
    userId: GITLAB_USER_ID,
    after,
    before
  })

  console.log(`GitLab 查询边界：after=${after}，before=${before}`)

  console.log(`获取到 GitLab events：${events.length} 条`)

  const pushEvents = filterPushEvents(events)

  console.log(`筛选后 pushed to events：${pushEvents.length} 条`)

  const commits = await fetchCommitsByPushEvents(pushEvents)

  console.log(`获取到真实 commits：${commits.length} 条`)

  const weeklyItems = normalizeCommits(commits)

  console.log(`生成周报候选条目：${weeklyItems.length} 条`)

  writeGitJson(weeklyItems)

  if (shouldUpdateExcel) {
    const appendCount = await updateWeeklyExcel(weeklyItems)
    console.log(`Excel 已追加：${appendCount} 条`)
  } else {
    console.log('已跳过 Excel 更新')
  }

  writeDebugFiles()

  console.log('执行完成')
}

function parseArgs(argv) {
  const result = {}

  for (const arg of argv) {
    const [key, ...rest] = arg.replace(/^--/, '').split('=')
    result[key] = rest.join('=')
  }

  return result
}

function getDefaultRange() {
  const now = new Date()
  const day = now.getDay() || 7

  // 本周一
  const monday = new Date(now)
  monday.setHours(0, 0, 0, 0)
  monday.setDate(now.getDate() - day + 1)

  // GitLab after 不包含边界，因此取本周一的前一天
  const afterDate = new Date(monday)
  afterDate.setDate(monday.getDate() - 1)

  // GitLab before 不包含边界，因此取本周日的后一天
  const beforeDate = new Date(monday)
  beforeDate.setDate(monday.getDate() + 7)

  return {
    after: formatDateOnly(afterDate),
    before: formatDateOnly(beforeDate)
  }
}

function getDefaultAfter() {
  const now = new Date()
  const day = now.getDay() || 7

  const monday = new Date(now)
  monday.setDate(now.getDate() - day + 1)

  const beforeMonday = new Date(monday)
  beforeMonday.setDate(monday.getDate() - 1)

  return formatDateOnly(beforeMonday)
}

function getDefaultBefore() {
  const now = new Date()

  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)

  return formatDateOnly(tomorrow)
}

function formatDateOnly(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

function formatMonthDay(dateStr) {
  const date = new Date(dateStr)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  return `${date.getMonth() + 1}/${String(date.getDate()).padStart(2, '0')}`
}

async function gitlabGet(apiPath, query = {}) {
  const url = new URL(`${GITLAB_BASE_URL}${apiPath}`)

  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value)
    }
  })

  const response = await fetch(url, {
    headers: {
      'PRIVATE-TOKEN': GITLAB_TOKEN
    }
  })

  if (!response.ok) {
    throw new Error(
      `GitLab 请求失败：${response.status} ${response.statusText} ${url}`
    )
  }

  const data = await response.json()

  return {
    data,
    headers: response.headers
  }
}

async function fetchAllPages(apiPath, query = {}) {
  let page = 1
  const perPage = 100
  const result = []

  while (true) {
    const { data, headers } = await gitlabGet(apiPath, {
      ...query,
      page,
      per_page: perPage
    })

    result.push(...data)

    const nextPage = headers.get('x-next-page')

    if (!nextPage) {
      break
    }

    page = Number(nextPage)
  }

  return result
}

async function fetchAllGitlabEvents({ userId, after, before }) {
  return fetchAllPages(`/api/v4/users/${userId}/events`, {
    after,
    before,
    target_type: '',
    action: ''
  })
}

function excludeEvent(event, reason) {
  const pushData = event.push_data || {}

  excludedEvents.push({
    reason,
    id: event.id,
    project_id: event.project_id,
    action_name: event.action_name,
    created_at: event.created_at,
    ref: pushData.ref,
    ref_type: pushData.ref_type,
    action: pushData.action,
    commit_count: pushData.commit_count,
    commit_from: pushData.commit_from,
    commit_to: pushData.commit_to,
    commit_title: pushData.commit_title
  })
}

function filterPushEvents(events) {
  return events.filter((event) => {
    const pushData = event.push_data || {}

    if (event.action_name !== 'pushed to') {
      excludeEvent(event, '非 pushed to 事件')
      return false
    }

    if (pushData.action !== 'pushed') {
      excludeEvent(event, '非 pushed action')
      return false
    }

    if (pushData.ref_type !== 'branch') {
      excludeEvent(event, '非 branch 推送')
      return false
    }

    if (!pushData.commit_from) {
      excludeEvent(event, '缺少 commit_from')
      return false
    }

    if (!pushData.commit_to) {
      excludeEvent(event, '缺少 commit_to')
      return false
    }

    if (!pushData.commit_count || pushData.commit_count <= 0) {
      excludeEvent(event, 'commit_count 为空或小于等于 0')
      return false
    }

    if (
      filters.maxCommitCountPerPush &&
      pushData.commit_count > filters.maxCommitCountPerPush
    ) {
      excludeEvent(
        event,
        `超过单次 push 数量阈值：${filters.maxCommitCountPerPush}`
      )
      return false
    }

    return true
  })
}

async function fetchCommitsByPushEvents(events) {
  const commitMap = new Map()

  for (const event of events) {
    const pushData = event.push_data

    console.log(`Compare project=${event.project_id}, ref=${pushData.ref}`)

    const commits = await fetchCompareCommits({
      projectId: event.project_id,
      from: pushData.commit_from,
      to: pushData.commit_to
    })

    compareLogs.push({
      project_id: event.project_id,
      ref: pushData.ref,
      commit_count_from_event: pushData.commit_count,
      commit_from: pushData.commit_from,
      commit_to: pushData.commit_to,
      compare_commit_count: commits.length,
      event_created_at: event.created_at,
      commit_title: pushData.commit_title
    })

    for (const commit of commits) {
      if (!commit.id) continue

      commitMap.set(commit.id, {
        ...commit,
        project_id: event.project_id,
        ref: pushData.ref,
        event_created_at: event.created_at,
        event_commit_count: pushData.commit_count
      })
    }
  }

  return Array.from(commitMap.values())
}

async function fetchCompareCommits({ projectId, from, to }) {
  try {
    const { data } = await gitlabGet(
      `/api/v4/projects/${encodeURIComponent(projectId)}/repository/compare`,
      {
        from,
        to
      }
    )

    return Array.isArray(data.commits) ? data.commits : []
  } catch (error) {
    console.warn(
      `警告：compare 失败，已跳过 project=${projectId}, from=${from}, to=${to}`
    )
    console.warn(error.message)
    return []
  }
}

function isMyCommit(commit) {
  const names = gitlab.authorNames || []
  const emails = gitlab.authorEmails || []

  return (
    names.includes(commit.author_name) ||
    names.includes(commit.committer_name) ||
    emails.includes(commit.author_email) ||
    emails.includes(commit.committer_email)
  )
}

function excludeCommit(commit, reason) {
  excludedCommits.push({
    reason,
    id: commit.id,
    short_id: commit.short_id,
    title: commit.title || commit.message || '',
    project_id: commit.project_id,
    ref: commit.ref,
    author_name: commit.author_name,
    author_email: commit.author_email,
    committer_name: commit.committer_name,
    committer_email: commit.committer_email,
    committed_date: commit.committed_date,
    event_created_at: commit.event_created_at
  })
}

function normalizeText(text = '') {
  return String(text)
    .replace(/\s+/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim()
}

function buildWeeklyUniqueKey(commit, parsed) {
  const group = projectGroupMap[commit.project_id] || '其他'
  const jira = parsed.jira || ''
  const project = parsed.project || ''
  const description = normalizeText(parsed.description || '')

  if (jira) {
    return `${group}_${jira}_${description}`
  }

  return `${group}_${project}_${description}`
}

function normalizeDateArgument(value) {
  return String(value || '')
    .trim()
    .replace(/\//g, '-')
}

function isCommitInRange(commit, after, before) {
  const dateStr = commit.committed_date || commit.created_at

  if (!dateStr) return false

  const normalizedAfter = normalizeDateArgument(after)
  const normalizedBefore = normalizeDateArgument(before)

  const commitTime = new Date(dateStr)
  const afterTime = new Date(`${normalizedAfter}T00:00:00.000+08:00`)
  const beforeTime = new Date(`${normalizedBefore}T00:00:00.000+08:00`)

  if (
    Number.isNaN(commitTime.getTime()) ||
    Number.isNaN(afterTime.getTime()) ||
    Number.isNaN(beforeTime.getTime())
  ) {
    console.warn('日期解析失败：', {
      committedDate: dateStr,
      after,
      before
    })
    return false
  }

  return commitTime > afterTime && commitTime < beforeTime
}

function compareDateAsc(a, b) {
  const ad = a.date || ''
  const bd = b.date || ''

  if (!ad && !bd) return 0
  if (!ad) return 1
  if (!bd) return -1

  return ad.localeCompare(bd, 'zh-CN')
}

function normalizeCommits(commits) {
  const result = []
  const seen = new Set()

  for (const commit of commits) {
    const title = commit.title || commit.message || ''

    if (!title) {
      excludeCommit(commit, '标题为空')
      continue
    }

    if (!isMyCommit(commit)) {
      excludeCommit(commit, '作者不匹配')
      continue
    }

    if (!isCommitInRange(commit, after, before)) {
      excludeCommit(commit, '提交时间不在周报周期内')
      continue
    }

    if (filters.ignoreMergeCommit && /^Merge branch/i.test(title)) {
      excludeCommit(commit, 'Merge commit')
      continue
    }

    const parsed = parseCommitTitle(title)

    if (!parsed.description) {
      excludeCommit(commit, '解析后描述为空')
      continue
    }

    const uniqueKey = buildWeeklyUniqueKey(commit, parsed)

    if (seen.has(uniqueKey)) {
      excludeCommit(commit, `重复周报事项：${uniqueKey}`)
      continue
    }

    seen.add(uniqueKey)

    const sourceDate =
      commit.committed_date || commit.created_at || commit.event_created_at

    result.push({
      source: 'gitlab',
      commit_id: commit.id || '',
      short_id:
        commit.short_id || (commit.id ? String(commit.id).slice(0, 8) : ''),
      web_url: commit.web_url || '',
      project_id: commit.project_id,
      ref: commit.ref,
      group: projectGroupMap[commit.project_id] || '其他',
      resolveDate: formatDateOnly(new Date(sourceDate)),
      date: formatMonthDay(sourceDate),
      project: parsed.project || '',
      jira: parsed.jira,
      jiraUrl: parsed.jira ? `${JIRA_BASE_URL}${parsed.jira}` : '',
      description: parsed.description,
      taskDescription: parsed.description,
      owner: '',
      status: '已完成',
      remark: '',
      typeLabel: '',
      typeColor: '',
      type: 'thisWeek'
    })
  }

  return result.sort((a, b) => {
    if (a.group !== b.group) {
      return a.group.localeCompare(b.group, 'zh-CN')
    }

    return compareDateAsc(a, b)
  })
}

function parseCommitTitle(title = '') {
  const jiraMatch = title.match(/([A-Z][A-Z0-9]+-\d+)/)
  const projectMatch = title.match(/【([^】]+)】/)

  const jira = jiraMatch ? jiraMatch[1] : ''
  const project = projectMatch ? projectMatch[1] : ''

  const description = title
    .replace(jira, '')
    .replace(/【[^】]+】/, '')
    .replace(
      /^(feat|fix|docs|style|refactor|test|chore|perf|build|ci):\s*/i,
      ''
    )
    .trim()

  return {
    jira,
    project,
    description
  }
}

function resolveProjectFile(filePath) {
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath)
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function getOutputPath(fileName) {
  const outputDir = resolveProjectFile(outputConfig.dir || './weekly-output')
  ensureDir(outputDir)
  return path.join(outputDir, fileName)
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
}

function writeGitJson(records) {
  const jsonPath = getOutputPath(outputConfig.gitJsonFile)

  writeJson(jsonPath, {
    meta: {
      after,
      before,
      generatedAt: new Date().toISOString(),
      count: records.length
    },
    records
  })

  console.log(`Git commit JSON 已保存：${jsonPath}`)
}

function writeDebugFiles() {
  writeJson(getOutputPath(outputConfig.excludedEventsFile), excludedEvents)
  writeJson(getOutputPath(outputConfig.excludedCommitsFile), excludedCommits)
  writeJson(getOutputPath(outputConfig.compareLogsFile), compareLogs)
}

function shouldSkipType(item) {
  return (noTypeProjectIds || []).includes(Number(item.project_id))
}

function getCommitMarker(shortId) {
  return shortId ? `[commit:${shortId}]` : ''
}

function extractCommitMarker(text) {
  const match = String(text || '').match(/\[commit:([a-f0-9]{7,40})\]/i)
  return match ? match[1] : ''
}

function readCellText(row, col) {
  const value = row.getCell(col).value

  if (value === null || value === undefined) return ''
  if (value instanceof Date) return formatDateOnly(value)

  if (typeof value === 'object') {
    if (value.text) return String(value.text).trim()
    if (value.result !== undefined && value.result !== null) {
      return String(value.result).trim()
    }
    if (Array.isArray(value.richText)) {
      return value.richText
        .map((item) => item.text)
        .join('')
        .trim()
    }
    if (value.hyperlink && value.text) return String(value.text).trim()
  }

  return String(value).trim()
}

function isExcelRowEmpty(row) {
  for (let col = 1; col <= 12; col++) {
    if (readCellText(row, col)) return false
  }

  return true
}

function getExcelRowKeys(row) {
  const remark = readCellText(row, 11)
  const marker = extractCommitMarker(remark)
  const group = readCellText(row, 2)
  const date = readCellText(row, 3)
  const project = readCellText(row, 4)
  const jiraNo = readCellText(row, 6)
  const taskDescription = readCellText(row, 7)
  const detail = readCellText(row, 10)
  const description = detail || taskDescription

  const keys = []

  if (marker) keys.push(`commit:${marker}`)
  if (jiraNo) keys.push(`jira:${jiraNo}`)
  if (group || project || taskDescription) {
    keys.push(`item:${group}_${project}_${normalizeText(taskDescription)}`)
  }
  if (date || description) {
    keys.push(`dateItem:${date}_${normalizeText(description)}`)
  }

  return keys.filter(Boolean)
}

function getRecordKeys(record) {
  const keys = []

  if (record.short_id) keys.push(`commit:${record.short_id}`)
  if (record.commit_id)
    keys.push(`commit:${String(record.commit_id).slice(0, 8)}`)
  if (record.jira) keys.push(`jira:${record.jira}`)
  if (
    record.group ||
    record.project ||
    record.taskDescription ||
    record.description
  ) {
    keys.push(
      `item:${record.group || ''}_${record.project || ''}_${normalizeText(
        record.taskDescription || record.description || ''
      )}`
    )
  }
  if (record.resolveDate || record.description) {
    keys.push(
      `dateItem:${record.resolveDate || ''}_${normalizeText(
        record.description || ''
      )}`
    )
  }

  return keys.filter(Boolean)
}

function findFirstEmptyRow(ws) {
  const startRow = excelConfig.startRow || 2
  const endRow = excelConfig.endRow || 100

  for (let rowNumber = startRow; rowNumber <= endRow; rowNumber++) {
    const row = ws.getRow(rowNumber)
    if (isExcelRowEmpty(row)) return rowNumber
  }

  return -1
}

function getExistingExcelKeys(ws) {
  const keys = new Set()
  const startRow = excelConfig.startRow || 2
  const endRow = excelConfig.endRow || 100

  for (let rowNumber = startRow; rowNumber <= endRow; rowNumber++) {
    const row = ws.getRow(rowNumber)

    if (isExcelRowEmpty(row)) continue

    getExcelRowKeys(row).forEach((key) => keys.add(key))
  }

  return keys
}

function parseLocalDate(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/\//g, '-')
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/)

  if (!match) {
    return null
  }

  const [, year, month, day] = match

  // 使用本地时间构造，避免 new Date('2026-07-17') 被按 UTC 解析后产生日期偏移
  return new Date(Number(year), Number(month) - 1, Number(day))
}

async function updateWeeklyExcel(records) {
  const excelPath = resolveProjectFile(excelConfig.file)

  if (!fs.existsSync(excelPath)) {
    throw new Error(`未找到 Excel 模板：${excelPath}`)
  }

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(excelPath)

  const ws = workbook.getWorksheet(excelConfig.sheetName)

  if (!ws) {
    throw new Error(`未找到工作表：${excelConfig.sheetName}`)
  }

  const existingKeys = getExistingExcelKeys(ws)
  let appendCount = 0

  for (const record of records) {
    const recordKeys = getRecordKeys(record)
    const exists = recordKeys.some((key) => existingKeys.has(key))

    if (exists) continue

    const rowNumber = findFirstEmptyRow(ws)

    if (rowNumber === -1) {
      throw new Error(
        `当周数据维护有效区域已满，请扩展模板行数。目前 endRow=${excelConfig.endRow}`
      )
    }

    const row = ws.getRow(rowNumber)

    const seqCell = row.getCell(1)
    seqCell.value = rowNumber - (excelConfig.startRow || 2) + 1
    seqCell.numFmt = '0'

    row.getCell(2).value = record.group || ''

    const dateCell = row.getCell(3)
    dateCell.value = record.resolveDate ? parseLocalDate(record.resolveDate) : null
    dateCell.numFmt = 'yyyy/mm/dd'

    row.getCell(4).value = record.project || ''
    row.getCell(5).value = shouldSkipType(record) ? '' : record.typeLabel || ''
    row.getCell(6).value = record.jira || ''
    row.getCell(7).value = record.taskDescription || record.description || ''
    row.getCell(8).value = record.owner || ''
    row.getCell(9).value = record.status || '已完成'
    row.getCell(10).value = ''
    row.getCell(11).value = ''
    row.getCell(12).value = ''

    row.eachCell((cell) => {
      cell.alignment = {
        ...(cell.alignment || {}),
        vertical: 'middle',
        wrapText: true
      }
    })

    recordKeys.forEach((key) => existingKeys.add(key))
    appendCount++
  }

  await workbook.xlsx.writeFile(excelPath)

  return appendCount
}
