'use strict';

function createSnapshot(normalized, validation) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    period: normalized.period,
    source: normalized.source,
    manual: normalized.manual || null,
    validation: {
      passed: validation.passed,
      summary: validation.summary
    },
    items: normalized.items
  };
}

module.exports = { createSnapshot };
