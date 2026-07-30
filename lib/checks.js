// lib/checks.js
// The scoring skeleton. A report is a set of weighted categories; each category
// holds checks; each check holds individual findings.
//
// Points work the way an auditor reads them: every scoring finding is worth
// exactly one point, so a check reads "8/9" and the missing point maps to a
// specific line of text. Findings marked `info` carry no points.
//
// A category's percentage is not a raw point average — points are weighted by
// how much the check matters, so a broken title outweighs a missing favicon.

export const IMPORTANCE = {
  critical: { label: 'Very important', weight: 3.0, rank: 0 },
  high:     { label: 'Important',      weight: 2.0, rank: 1 },
  low:      { label: 'Low importance', weight: 1.0, rank: 2 },
  nice:     { label: 'Nice to have',   weight: 0.5, rank: 3 },
};

export const CATEGORIES = [
  { key: 'meta',      label: 'Meta data',            weight: 22 },
  { key: 'quality',   label: 'Page quality',         weight: 24 },
  { key: 'structure', label: 'Page structure',       weight: 14 },
  { key: 'links',     label: 'Link structure',       weight: 14 },
  { key: 'server',    label: 'Server configuration', weight: 18 },
  { key: 'external',  label: 'External factors',     weight: 8  },
];

const POINTS = { ok: 1, warn: 0, fail: 0 };

export function createAudit() {
  const categories = new Map(
    CATEGORIES.map((c) => [c.key, { ...c, checks: [], measured: true, note: null }])
  );

  /**
   * Open a check inside a category.
   * @param {string} categoryKey
   * @param {string} name        Display name, e.g. "Meta description".
   * @param {keyof IMPORTANCE} importance
   * @param {{value?: string, help?: string}} [meta] `value` renders as the quoted
   *        subject of the check (the actual title text, canonical URL, …).
   */
  function check(categoryKey, name, importance, meta = {}) {
    const category = categories.get(categoryKey);
    if (!category) throw new Error(`Unknown category: ${categoryKey}`);
    if (!IMPORTANCE[importance]) throw new Error(`Unknown importance: ${importance}`);

    const record = {
      name,
      importance,
      importanceLabel: IMPORTANCE[importance].label,
      value: meta.value ?? null,
      help: meta.help ?? null,
      findings: [],
    };
    category.checks.push(record);

    const addFinding = (status) => (text, opts = {}) => {
      record.findings.push({
        status,
        text,
        todo: opts.todo ?? null,
        detail: opts.detail ?? null,
      });
      return api;
    };

    const api = {
      ok: addFinding('ok'),
      warn: addFinding('warn'),
      fail: addFinding('fail'),
      info: addFinding('info'),
      /** ok when `condition` is true, otherwise `severity` with the failure text. */
      assert(condition, okText, badText, opts = {}) {
        return condition ? api.ok(okText) : api[opts.severity || 'warn'](badText, opts);
      },
      value(v) { record.value = v; return api; },
    };

    return api;
  }

  /** Mark a category as unmeasurable so it is excluded from the overall score. */
  function unmeasured(categoryKey, note) {
    const category = categories.get(categoryKey);
    if (category) { category.measured = false; category.note = note; }
  }

  function finalize() {
    const result = [];
    let weightedSum = 0;
    let weightTotal = 0;

    for (const category of categories.values()) {
      let earned = 0;
      let max = 0;
      let wEarned = 0;
      let wMax = 0;

      const checks = category.checks.map((c) => {
        const scoring = c.findings.filter((f) => f.status !== 'info');
        const cEarned = scoring.reduce((sum, f) => sum + POINTS[f.status], 0);
        const cMax = scoring.length;
        const iw = IMPORTANCE[c.importance].weight;

        earned += cEarned;
        max += cMax;
        wEarned += cEarned * iw;
        wMax += cMax * iw;

        const status = c.findings.some((f) => f.status === 'fail')
          ? 'fail'
          : c.findings.some((f) => f.status === 'warn') ? 'warn' : 'ok';

        return { ...c, points: { earned: cEarned, max: cMax }, status };
      });

      const score = wMax ? Math.round((wEarned / wMax) * 100) : null;

      if (category.measured && score !== null) {
        weightedSum += score * category.weight;
        weightTotal += category.weight;
      }

      result.push({
        key: category.key,
        label: category.label,
        weight: category.weight,
        measured: category.measured,
        note: category.note,
        score,
        checks,
        points: { earned, max },
        counts: {
          ok: checks.filter((c) => c.status === 'ok').length,
          warn: checks.filter((c) => c.status === 'warn').length,
          fail: checks.filter((c) => c.status === 'fail').length,
        },
      });
    }

    const overall = weightTotal ? Math.round(weightedSum / weightTotal) : 0;
    const allFindings = result.flatMap((cat) =>
      cat.checks.flatMap((c) =>
        c.findings.map((f) => ({ ...f, check: c.name, category: cat.label, importance: c.importance }))
      )
    );

    const todos = allFindings
      .filter((f) => f.todo && f.status !== 'info')
      .sort((a, b) => {
        const ra = IMPORTANCE[a.importance].rank;
        const rb = IMPORTANCE[b.importance].rank;
        if (ra !== rb) return ra - rb;
        return (a.status === 'fail' ? 0 : 1) - (b.status === 'fail' ? 0 : 1);
      })
      .map((f) => ({
        action: f.todo,
        check: f.check,
        category: f.category,
        status: f.status,
        importance: f.importance,
        importanceLabel: IMPORTANCE[f.importance].label,
        because: f.text,
      }));

    return {
      overall,
      categories: result,
      todos,
      totals: {
        checks: result.reduce((n, c) => n + c.checks.length, 0),
        findings: allFindings.filter((f) => f.status !== 'info').length,
        errors: allFindings.filter((f) => f.status === 'fail').length,
        warnings: allFindings.filter((f) => f.status === 'warn').length,
        passed: allFindings.filter((f) => f.status === 'ok').length,
      },
    };
  }

  return { check, unmeasured, finalize };
}

/** Coarse label for a score, the way the reference report words it. */
export function verdict(score) {
  if (score >= 90) return 'Very good';
  if (score >= 80) return 'Good';
  if (score >= 60) return 'Warning';
  if (score >= 40) return 'Poor';
  return 'Critical';
}
