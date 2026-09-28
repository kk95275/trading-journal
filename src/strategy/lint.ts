// Python syntax checking + light auto-fix. Both go through the same Pyodide
// runtime the backtest runner uses — no extra deps.
//
// Lint: `compile()` catches every SyntaxError with a line/col/message. We
// also add a couple of trivial static-warning heuristics on top (e.g. no
// `on_bar` defined) so the strategy is runnable before the user hits Run.
//
// Auto-fix: intentionally minimal so it's safe to run silently on save —
// strips trailing whitespace, converts leading tabs to 4 spaces, ensures a
// final newline. It never touches the semantics of the code.

import { loadPyodideRuntime } from './pyodide'

export type Severity = 'error' | 'warning'

export interface LintIssue {
  severity: Severity
  message: string
  line: number    // 1-based, matches Monaco
  column: number  // 1-based
  endColumn?: number
}

/**
 * Fast syntax check. Runs Python's own compiler, so it catches everything
 * `python -c "compile(...)"` would. Falls back to no-op if Pyodide hasn't
 * finished loading yet — the caller re-lints once it does.
 */
export async function lintPython(code: string): Promise<LintIssue[]> {
  const issues: LintIssue[] = []

  // Heuristics that don't need Pyodide.
  if (!/\bdef\s+on_bar\s*\(/.test(code)) {
    issues.push({
      severity: 'warning',
      message: 'No `on_bar(ctx)` function defined — Run will fail. Add one to make this strategy executable.',
      line: 1,
      column: 1,
    })
  }

  let py
  try { py = await loadPyodideRuntime() } catch { return issues }

  // Escape for triple-quoted string safely by rejecting the delimiter.
  py.globals.set('__lint_code', code)
  try {
    py.runPython(
`import ast, json
__lint_result = None
try:
    compile(__lint_code, '<strategy>', 'exec')
except SyntaxError as e:
    __lint_result = json.dumps({
        'msg': e.msg or 'Syntax error',
        'line': e.lineno or 1,
        'col':  e.offset or 1,
        'endcol': e.end_offset if hasattr(e, 'end_offset') else None,
    })
except Exception as e:
    __lint_result = json.dumps({
        'msg': f'{type(e).__name__}: {e}',
        'line': 1, 'col': 1, 'endcol': None,
    })
`,
    )
    const raw = py.globals.get('__lint_result')
    if (raw && typeof raw === 'string') {
      const j = JSON.parse(raw)
      issues.unshift({
        severity: 'error',
        message: j.msg,
        line: Math.max(1, j.line | 0),
        column: Math.max(1, j.col | 0),
        endColumn: j.endcol ? Math.max(j.col + 1, j.endcol) : undefined,
      })
    }
  } catch (e: any) {
    // Very rare: Pyodide itself blew up. Fail open, keep the user typing.
    console.warn('[lint] pyodide error:', e)
  } finally {
    py.globals.set('__lint_code', '')
    py.globals.set('__lint_result', '')
  }

  return issues
}

/**
 * Safe auto-fix. Never re-flows or reformats — just cleans whitespace so the
 * file is stable to check into git and doesn't accumulate weird invisible
 * characters. Runs in JS (no Pyodide round-trip) so it's instant.
 */
export function autoFix(code: string): string {
  const lines = code.replace(/\r\n?/g, '\n').split('\n')
  const cleaned = lines.map(line => {
    // Leading tabs → 4 spaces (Python style). Only leading; mid-line tabs
    // are left alone in case they're inside a string literal.
    const m = line.match(/^([\t ]*)(.*)$/s)
    const leading = m ? m[1] : ''
    const rest = m ? m[2] : line
    const expandedLeading = leading.replace(/\t/g, '    ')
    return (expandedLeading + rest).replace(/[ \t]+$/, '')
  })
  // Collapse runs of >2 blank lines to 2, and ensure a single trailing newline.
  let out = cleaned.join('\n').replace(/\n{3,}/g, '\n\n\n')
  if (!out.endsWith('\n')) out += '\n'
  return out
}
