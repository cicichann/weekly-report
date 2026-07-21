'use strict';

const { compareItems, buildJiraUrl } = require('./normalize');

function normalizedText(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .toLowerCase();
}

function getItemKeys(item) {
  const keys = [];
  const sha = String(item.sha || item.shortSha || '').toLowerCase();
  if (sha.length >= 7) keys.push(`commit:${sha.slice(0, 7)}`);
  if (sha.length >= 8) keys.push(`commit:${sha.slice(0, 8)}`);
  if (item.jira) keys.push(`jira:${normalizedText(item.jira)}`);
  if (item.group || item.projectName || item.title) {
    keys.push(`item:${normalizedText(item.group)}_${normalizedText(item.projectName)}_${normalizedText(item.title)}`);
  }
  if (item.date || item.title) {
    keys.push(`dateItem:${item.date || ''}_${normalizedText(item.title)}`);
  }
  return [...new Set(keys)];
}

function overlayNonEmpty(base, patch) {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && value !== null && value !== '') result[key] = value;
  }
  return result;
}

function mergeItems(gitItems, manualItems, config, options = {}) {
  const manualAuthoritative = Boolean(options.manualAuthoritative);
  const records = new Map();
  const gitRecords = new Map();
  const aliases = new Map();
  let mergedCount = 0;
  let manualOnlyCount = 0;

  function findPrimary(item) {
    for (const key of getItemKeys(item)) {
      if (aliases.has(key)) return aliases.get(key);
    }
    return '';
  }

  function registerAliases(primary, item) {
    for (const key of getItemKeys(item)) aliases.set(key, primary);
  }

  gitItems.forEach((item, index) => {
    const primary = getItemKeys(item)[0] || `git:${index}`;
    gitRecords.set(primary, item);
    if (!manualAuthoritative) records.set(primary, item);
    registerAliases(primary, item);
  });

  manualItems.forEach((manual, index) => {
    const primary = findPrimary(manual);
    const git = primary ? gitRecords.get(primary) : null;
    if (git) {
      const merged = overlayNonEmpty(git, manual);
      merged.source = 'git+manual';
      merged.projectId = git.projectId;
      merged.projectMapped = git.projectMapped;
      merged.sha = git.sha;
      merged.shortSha = git.shortSha;
      merged.message = git.message;
      merged.webUrl = git.webUrl;
      merged.jiraUrl = buildJiraUrl(merged.jira, config);
      records.set(primary, merged);
      registerAliases(primary, merged);
      mergedCount += 1;
    } else {
      const manualItem = {
        ...manual,
        product: manual.product || config.defaults.product || '',
        issueType: manual.issueType || config.defaults.issueType || '',
        status: manual.status || config.defaults.status || '',
        jiraUrl: buildJiraUrl(manual.jira, config)
      };
      const manualPrimary = getItemKeys(manualItem)[0] || `manual:${index}:${manual.rowNumber}`;
      records.set(manualPrimary, manualItem);
      registerAliases(manualPrimary, manualItem);
      manualOnlyCount += 1;
    }
  });

  const items = [...records.values()].sort((a, b) => compareItems(a, b, config));
  items.forEach((item, index) => { item.index = index + 1; });
  return { items, mergedCount, manualOnlyCount };
}

function mergeNormalizedWithManual(normalized, manual, config, options = {}) {
  const merged = mergeItems(normalized.items, manual.items, config, options);
  return {
    ...normalized,
    manual: {
      file: manual.file,
      rows: manual.items.length,
      merged: merged.mergedCount,
      manualOnly: merged.manualOnlyCount
    },
    stats: {
      ...normalized.stats,
      accepted: merged.items.length,
      rejected: normalized.rejected.length + (manual.rejected || []).length,
      manualRows: manual.items.length,
      manualMerged: merged.mergedCount,
      manualOnly: merged.manualOnlyCount
    },
    items: merged.items,
    rejected: [...normalized.rejected, ...(manual.rejected || [])]
  };
}

module.exports = { mergeNormalizedWithManual, mergeItems, getItemKeys, overlayNonEmpty };
