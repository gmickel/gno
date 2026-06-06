/**
 * Shared SQL expressions for graph link target resolution.
 *
 * These helpers preserve getGraph's existing wiki matching order so future
 * typed-edge projection/backfill can reuse the exact resolver.
 *
 * @module src/core/graph-resolver
 */

const suffixMatch = (targetExpr: string, valueExpr: string): string =>
  `(substr(${targetExpr}, -length(${valueExpr})) = ${valueExpr}
    AND (length(${targetExpr}) = length(${valueExpr})
      OR substr(${targetExpr}, -length(${valueExpr}) - 1, 1) = '/'))`;

const wikiTitleExpr = (alias: string): string => `lower(trim(${alias}.title))`;
const wikiRelPathExpr = (alias: string): string => `lower(${alias}.rel_path)`;

function wikiTargetExpressions(targetRefExpr: string): {
  targetBaseExpr: string;
  targetMdExpr: string;
} {
  const targetBaseExpr = `CASE
    WHEN ${targetRefExpr} LIKE '%.md' THEN substr(${targetRefExpr}, 1, length(${targetRefExpr}) - 3)
    ELSE ${targetRefExpr}
  END`;
  return { targetBaseExpr, targetMdExpr: `${targetBaseExpr} || '.md'` };
}

export function buildWikiMatchExpression(
  alias: string,
  targetRefExpr: string
): string {
  const titleExpr = wikiTitleExpr(alias);
  const relExpr = wikiRelPathExpr(alias);
  const { targetBaseExpr, targetMdExpr } = wikiTargetExpressions(targetRefExpr);
  return `(
    ${titleExpr} = ${targetBaseExpr}
    OR ${titleExpr} = ${targetMdExpr}
    OR ${suffixMatch(targetBaseExpr, titleExpr)}
    OR ${suffixMatch(targetMdExpr, `${titleExpr} || '.md'`)}
    OR ${relExpr} = ${targetBaseExpr}
    OR ${relExpr} = ${targetMdExpr}
    OR ${suffixMatch(relExpr, targetMdExpr)}
    OR ${suffixMatch(relExpr, targetBaseExpr)}
    OR ${suffixMatch(targetMdExpr, relExpr)}
    OR ${suffixMatch(targetBaseExpr, relExpr)}
  )`;
}

export function buildWikiOrderExpression(
  alias: string,
  targetRefExpr: string
): string {
  const titleExpr = wikiTitleExpr(alias);
  const relExpr = wikiRelPathExpr(alias);
  const { targetBaseExpr, targetMdExpr } = wikiTargetExpressions(targetRefExpr);
  return `CASE
    WHEN ${titleExpr} = ${targetBaseExpr} THEN 1
    WHEN ${titleExpr} = ${targetMdExpr} THEN 2
    WHEN ${suffixMatch(targetBaseExpr, titleExpr)} THEN 3
    WHEN ${suffixMatch(targetMdExpr, `${titleExpr} || '.md'`)} THEN 4
    WHEN ${relExpr} = ${targetBaseExpr} THEN 5
    WHEN ${relExpr} = ${targetMdExpr} THEN 6
    WHEN ${suffixMatch(relExpr, targetMdExpr)} THEN 7
    WHEN ${suffixMatch(relExpr, targetBaseExpr)} THEN 8
    WHEN ${suffixMatch(targetMdExpr, relExpr)} THEN 9
    WHEN ${suffixMatch(targetBaseExpr, relExpr)} THEN 10
    ELSE 11
  END`;
}

export function buildWikiBestMatchSubquery(
  collectionExpr: string,
  targetRefExpr: string
): string {
  return `
    SELECT t.id FROM documents t
    WHERE t.active = 1
      AND t.collection = ${collectionExpr}
      AND ${buildWikiMatchExpression("t", targetRefExpr)}
      AND ${buildWikiOrderExpression("t", targetRefExpr)} = (
        SELECT MIN(${buildWikiOrderExpression("t2", targetRefExpr)}) FROM documents t2
        WHERE t2.active = 1
          AND t2.collection = ${collectionExpr}
          AND ${buildWikiMatchExpression("t2", targetRefExpr)}
      )
    ORDER BY t.id LIMIT 1
  `;
}

export function buildWikiBestRankSubquery(
  collectionExpr: string,
  targetRefExpr: string
): string {
  return `
    SELECT MIN(${buildWikiOrderExpression("t", targetRefExpr)}) FROM documents t
    WHERE t.active = 1
      AND t.collection = ${collectionExpr}
      AND ${buildWikiMatchExpression("t", targetRefExpr)}
  `;
}

export function buildWikiBestRankMatchCountSubquery(
  collectionExpr: string,
  targetRefExpr: string
): string {
  return `
    SELECT COUNT(*) FROM documents t
    WHERE t.active = 1
      AND t.collection = ${collectionExpr}
      AND ${buildWikiMatchExpression("t", targetRefExpr)}
      AND ${buildWikiOrderExpression("t", targetRefExpr)} = (${buildWikiBestRankSubquery(
        collectionExpr,
        targetRefExpr
      )})
  `;
}
