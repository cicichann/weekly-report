'use strict';

const { timestampToDate, isDateInRange } = require('./utils/dates');

function normalizedText(value) {
  return String(value || '').trim().toLowerCase();
}

function matchesAuthor(commit, authors) {
  const configuredNames = (authors.names || []).map(normalizedText).filter(Boolean);
  const configuredEmails = (authors.emails || []).map(normalizedText).filter(Boolean);
  if (!configuredNames.length && !configuredEmails.length) return true;

  const name = normalizedText(commit.author_name || commit.committer_name);
  const email = normalizedText(commit.author_email || commit.committer_email);
  return configuredNames.includes(name) || configuredEmails.includes(email);
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/)[0].trim();
}

function isMergeCommit(commit) {
  if (Array.isArray(commit.parent_ids) && commit.parent_ids.length > 1) return true;
  const title = firstLine(commit.title || commit.message);
  return /^merge(?:\s|:|$)/i.test(title);
}

function projectConfigFor(config, projectId) {
  return config.projects[String(projectId)] || null;
}

function extractJira(title, config) {
  const pattern = config.jira && config.jira.pattern;
  if (!pattern) return '';
  try {
    const match = String(title || '').match(new RegExp(pattern, 'i'));
    return match ? match[0].toUpperCase() : '';
  } catch (_) {
    return '';
  }
}

function buildJiraUrl(jira, config) {
  const baseUrl = String((config.jira && config.jira.baseUrl) || '').trim();
  if (!jira || !baseUrl) return '';
  return baseUrl.includes('{jira}')
    ? baseUrl.replace('{jira}', encodeURIComponent(jira))
    : `${baseUrl}${encodeURIComponent(jira)}`;
}

function removeLeadingJira(title, jira) {
  if (!jira) return title;
  const escaped = jira.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(title || '')
    .replace(new RegExp(`^\\s*[【[]?${escaped}[】\\]]?\\s*[:：-]?\\s*`, 'i'), '')
    .trim() || title;
}

function normalizeCommit(commit, config, period) {
  const project = projectConfigFor(config, commit.project_id);
  const committedAt = commit.committed_date || commit.created_at || commit.authored_date;
  const date = timestampToDate(committedAt, period.timezone);
  const rawTitle = firstLine(commit.title || commit.message);
  const jira = extractJira(rawTitle, config);
  const title = removeLeadingJira(rawTitle, jira);

  return {
    id: `${commit.project_id}:${commit.id}`,
    projectId: String(commit.project_id || ''),
    projectName: (project && project.name) || `项目 ${commit.project_id}`,
    projectMapped: Boolean(project),
    group: (project && project.group) || config.defaults.group || '未分类',
    product: (project && project.product) || config.defaults.product || '待确认',
    issueType: (project && project.issueType) || config.defaults.issueType || '功能开发',
    status: (project && project.status) || config.defaults.status || '已解决',
    detail: (project && project.detail) || '',
    jira,
    jiraUrl: buildJiraUrl(jira, config),
    owner: (project && project.owner) || '',
    feedbackPerson: '',
    remark: '',
    branch: commit.branch || '',
    sha: commit.id || '',
    shortSha: commit.short_id || String(commit.id || '').slice(0, 8),
    title,
    message: String(commit.message || title).trim(),
    authorName: commit.author_name || commit.committer_name || '',
    authorEmail: commit.author_email || commit.committer_email || '',
    committedAt,
    date,
    webUrl: commit.web_url || ''
  };
}

function compareItems(left, right, config) {
  const order = config.groupOrder || [];
  const leftOrder = order.indexOf(left.group);
  const rightOrder = order.indexOf(right.group);
  const normalizedLeft = leftOrder < 0 ? Number.MAX_SAFE_INTEGER : leftOrder;
  const normalizedRight = rightOrder < 0 ? Number.MAX_SAFE_INTEGER : rightOrder;
  return normalizedLeft - normalizedRight
    || right.date.localeCompare(left.date)
    || left.projectName.localeCompare(right.projectName, 'zh-CN')
    || String(right.committedAt).localeCompare(String(left.committedAt))
    || left.sha.localeCompare(right.sha);
}

function normalizeGitData(rawData, config, period) {
  const accepted = [];
  const rejected = [];
  const seen = new Set();

  for (const rawCommit of rawData.commits || []) {
    const uniqueKey = `${rawCommit.project_id}:${rawCommit.id}`;
    if (seen.has(uniqueKey)) {
      rejected.push({ reason: 'DUPLICATE_COMMIT', key: uniqueKey });
      continue;
    }
    seen.add(uniqueKey);

    if (config.filters.excludeMergeCommits && isMergeCommit(rawCommit)) {
      rejected.push({
        reason: 'MERGE_COMMIT',
        key: uniqueKey,
        title: firstLine(rawCommit.title || rawCommit.message),
        projectId: String(rawCommit.project_id || ''),
        sha: rawCommit.id || ''
      });
      continue;
    }

    const item = normalizeCommit(rawCommit, config, period);
    if (!item.date) {
      rejected.push({ reason: 'INVALID_COMMIT_DATE', item });
      continue;
    }
    if (!isDateInRange(item.date, period.reportStart, period.reportEnd)) {
      rejected.push({ reason: 'OUTSIDE_PERIOD', item });
      continue;
    }
    if (!matchesAuthor(rawCommit, config.authors)) {
      rejected.push({ reason: 'UNMATCHED_AUTHOR', item });
      continue;
    }
    accepted.push(item);
  }

  accepted.sort((a, b) => compareItems(a, b, config));
  accepted.forEach((item, index) => { item.index = index + 1; });

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    period,
    source: {
      fetchedAt: rawData.fetchedAt,
      stats: rawData.stats || {},
      failures: rawData.failures || []
    },
    stats: {
      input: (rawData.commits || []).length,
      accepted: accepted.length,
      rejected: rejected.length
    },
    items: accepted,
    rejected
  };
}

module.exports = {
  normalizeGitData,
  normalizeCommit,
  matchesAuthor,
  isMergeCommit,
  compareItems,
  extractJira,
  buildJiraUrl
};
