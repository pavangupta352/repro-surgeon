'use strict';

const displayOptions = {
  heading: 'Weekly score report',
  separator: ' | ',
  decimals: 2,
};

const limits = { minimum: 0, maximum: 1000, pageSize: 25 };

function normalizeScores(scores) {
  return scores.map(Number).filter(Number.isFinite);
}

function sortScores(scores) {
  const numeric = normalizeScores(scores);
  return numeric.sort();
}

function scoreSummary(scores) {
  const numeric = normalizeScores(scores);
  const total = numeric.reduce((sum, score) => sum + score, 0);
  return {
    count: numeric.length,
    total,
    average: numeric.length ? total / numeric.length : 0,
  };
}

function formatReport(scores) {
  const summary = scoreSummary(scores);
  return [
    displayOptions.heading,
    `Count: ${summary.count}`,
    `Average: ${summary.average.toFixed(displayOptions.decimals)}`,
  ].join(displayOptions.separator);
}

module.exports = { sortScores, scoreSummary, formatReport, limits };
