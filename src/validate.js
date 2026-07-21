'use strict';

function issue(level, code, message, item, suggestion) {
  return {
    level,
    code,
    message,
    projectId: item && item.projectId,
    commitSha: item && item.sha,
    suggestion: suggestion || undefined
  };
}

function includesIfConfigured(values, value) {
  return !Array.isArray(values) || values.length === 0 || values.includes(value);
}

function validateNormalized(normalized, config, options = {}) {
  const issues = [];
  const rules = { ...config.validation, ...options };
  const dictionaries = config.dictionaries || {};

  for (const failure of normalized.source.failures || []) {
    issues.push({
      level: 'error',
      code: 'PARTIAL_FETCH_FAILURE',
      message: failure.message,
      projectId: String(failure.projectId || ''),
      suggestion: '检查项目权限或网络后使用 --refresh 重试'
    });
  }

  for (const item of normalized.items) {
    const requiresGitIdentity = item.source !== 'manual';
    if (!item.date || !item.title || !item.group || !item.projectName ||
        (requiresGitIdentity && (!item.sha || !item.projectId))) {
      issues.push(issue('error', 'REQUIRED_FIELD_MISSING', '周报条目存在必填字段缺失', item));
    }
    if (rules.requireProjectMapping && item.projectId && !item.projectMapped) {
      issues.push(issue(
        'error',
        'UNKNOWN_PROJECT',
        `项目 ${item.projectId} 未配置业务映射`,
        item,
        '在 report.config.json 的 projects 中补充项目配置'
      ));
    }
    if (!includesIfConfigured(dictionaries.products, item.product)) {
      issues.push(issue('error', 'INVALID_PRODUCT', `产品不在字典中：${item.product}`, item));
    }
    if (!includesIfConfigured(dictionaries.issueTypes, item.issueType)) {
      issues.push(issue('error', 'INVALID_ISSUE_TYPE', `问题类型不在字典中：${item.issueType}`, item));
    }
    if (!includesIfConfigured(dictionaries.statuses, item.status)) {
      issues.push(issue('error', 'INVALID_STATUS', `解决状态不在字典中：${item.status}`, item));
    }
    if (item.title.length < 4) {
      issues.push(issue('warning', 'SHORT_COMMIT_TITLE', `提交说明过短：${item.title}`, item));
    }
  }

  const unmatchedAuthors = normalized.rejected.filter(row => row.reason === 'UNMATCHED_AUTHOR');
  if (unmatchedAuthors.length) {
    issues.push({
      level: rules.failOnUnmatchedAuthor ? 'error' : 'warning',
      code: 'UNMATCHED_AUTHORS',
      message: `${unmatchedAuthors.length} 条提交因作者不匹配被排除`,
      suggestion: '确认 authors.names 和 authors.emails 配置'
    });
  }

  const mergeCommits = normalized.rejected.filter(row =>
    row.reason === 'MERGE_COMMIT' || row.reason === 'MANUAL_MERGE_COMMIT'
  );
  if (mergeCommits.length) {
    issues.push({
      level: 'warning',
      code: 'MERGE_COMMITS_EXCLUDED',
      message: `${mergeCommits.length} 条 Merge Commit 已过滤，不进入周报`
    });
  }

  const allowEmpty = Boolean(rules.allowEmpty);
  if (!normalized.items.length && !allowEmpty) {
    issues.push({
      level: 'error',
      code: 'EMPTY_REPORT',
      message: '最终有效周报条目为 0',
      suggestion: '检查统计周期、作者配置、项目映射及提交日期；确认无数据时可使用 --allow-empty'
    });
  }

  const errors = issues.filter(row => row.level === 'error').length;
  const warnings = issues.filter(row => row.level === 'warning').length;
  return {
    schemaVersion: 1,
    validatedAt: new Date().toISOString(),
    passed: errors === 0,
    period: normalized.period,
    summary: {
      events: normalized.source.stats.events || 0,
      pushEvents: normalized.source.stats.pushEvents || 0,
      commits: normalized.stats.input,
      accepted: normalized.stats.accepted,
      rejected: normalized.stats.rejected,
      manualRows: normalized.stats.manualRows || 0,
      manualMerged: normalized.stats.manualMerged || 0,
      manualOnly: normalized.stats.manualOnly || 0,
      warnings,
      errors
    },
    issues
  };
}

module.exports = { validateNormalized };
