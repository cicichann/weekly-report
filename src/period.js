'use strict';

const {
  addDays,
  assertDateString,
  dateInTimezone,
  dayOfWeek
} = require('./utils/dates');

function calculatePeriod(weekDate, timezone = 'Asia/Shanghai', now = new Date()) {
  const referenceDate = weekDate || dateInTimezone(now, timezone);
  assertDateString(referenceDate, '周报日期');

  const weekday = dayOfWeek(referenceDate);
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  const reportStart = addDays(referenceDate, -daysSinceMonday);
  const reportEnd = addDays(reportStart, 6);

  return {
    timezone,
    referenceDate,
    reportStart,
    reportEnd,
    gitlabAfter: addDays(reportStart, -1),
    gitlabBefore: addDays(reportEnd, 1),
    key: `${reportStart}_${reportEnd}`
  };
}

module.exports = { calculatePeriod };

