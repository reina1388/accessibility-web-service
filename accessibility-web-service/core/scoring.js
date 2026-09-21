function computeScoreAndGrade(findings) {
  const weights = { critical: 10, serious: 5, moderate: 2, minor: 1 };
  const penalty = findings.reduce((sum, f) => sum + (weights[f.severity] || 1), 0);
  const score = Math.max(0, 100 - penalty);
  let grade = 'D';
  if (score >= 90) grade = 'A';
  else if (score >= 75) grade = 'B';
  else if (score >= 60) grade = 'C';
  return { score, grade };
}

module.exports = { computeScoreAndGrade };
