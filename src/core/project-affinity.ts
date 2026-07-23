/**
 * Trusted project-root resolution for project-aware retrieval affinity.
 *
 * This module resolves local roots only. Remote hints remain opaque and never
 * trigger filesystem probes. Returned metadata is path-redacted; ranking is a
 * separate concern.
 *
 * @module src/core/project-affinity
 */

// node:fs/promises for directory stat/realpath (no Bun directory equivalent)
import { realpath, stat } from "node:fs/promises";
// node:path for path utilities (no Bun path utils)
import { dirname, join, relative, sep } from "node:path";

import type {
  Collection,
  ProjectAffinityInput,
  ProjectAffinityRoot,
  TrustedProjectRootSource,
} from "../config/types";

import { isCanonicalPathContained } from "./validation";

export type ProjectAffinityZeroReason =
  | "no_collection_match"
  | "root_unavailable"
  | "untrusted_remote_hint";

export type ProjectAffinityRelation =
  | "collection_contains_root"
  | "exact"
  | "root_contains_collection";

export interface ProjectAffinityMatch {
  collection: string;
  collectionAlias: string;
  distance: number;
  relation: ProjectAffinityRelation;
  rootAlias: string;
  source: TrustedProjectRootSource;
}

export interface ProjectAffinityRootMetadata {
  collectionAliases: string[];
  reason: ProjectAffinityZeroReason | null;
  repositoryRootDiscovered: boolean;
  rootAlias: string;
  source: ProjectAffinityRoot["source"];
  status: "matched" | "zero";
}

export interface ProjectAffinityResolution {
  matches: ProjectAffinityMatch[];
  roots: ProjectAffinityRootMetadata[];
}

export interface ProjectAffinityResolverDependencies {
  canonicalizePath: (path: string) => Promise<string>;
  discoverRepositoryRoot: (path: string) => Promise<string | null>;
}

/**
 * Trust is supplied by the invoking surface, never inferred from payload data.
 */
export interface ProjectAffinityResolverContext {
  channel: "local" | "remote";
}

interface CanonicalCollection {
  alias: string;
  name: string;
  path: string;
}

interface CanonicalTrustedRoot {
  path: string;
  repositoryRootDiscovered: boolean;
  rootAlias: string;
  source: TrustedProjectRootSource;
}

const alias = (namespace: "collection" | "root", value: string): string => {
  const hash = new Bun.CryptoHasher("sha256")
    .update(`${namespace}\0${value}`)
    .digest("hex")
    .slice(0, 12);
  return `${namespace}_${hash}`;
};

const defaultCanonicalizePath = (path: string): Promise<string> =>
  realpath(path);

const isDirectoryOrFile = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const defaultDiscoverRepositoryRoot = async (
  startingPath: string
): Promise<string | null> => {
  let current = startingPath;
  while (true) {
    if (await isDirectoryOrFile(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
};

const pathDistance = (parent: string, child: string): number => {
  const nestedPath = relative(parent, child);
  if (nestedPath === "") {
    return 0;
  }
  return nestedPath.split(sep).filter(Boolean).length;
};

const describeRelationship = (
  collectionPath: string,
  rootPath: string
): Pick<ProjectAffinityMatch, "distance" | "relation"> | null => {
  if (collectionPath === rootPath) {
    return { distance: 0, relation: "exact" };
  }
  if (isCanonicalPathContained(collectionPath, rootPath)) {
    return {
      distance: pathDistance(collectionPath, rootPath),
      relation: "collection_contains_root",
    };
  }
  if (isCanonicalPathContained(rootPath, collectionPath)) {
    return {
      distance: pathDistance(rootPath, collectionPath),
      relation: "root_contains_collection",
    };
  }
  return null;
};

const canonicalizeCollections = async (
  collections: readonly Collection[],
  canonicalizePath: ProjectAffinityResolverDependencies["canonicalizePath"]
): Promise<CanonicalCollection[]> => {
  const resolved = await Promise.all(
    collections.map(async (collection): Promise<CanonicalCollection | null> => {
      try {
        const path = await canonicalizePath(collection.path);
        return {
          alias: alias("collection", collection.name),
          name: collection.name,
          path,
        };
      } catch {
        return null;
      }
    })
  );
  return resolved
    .filter((collection): collection is CanonicalCollection =>
      Boolean(collection)
    )
    .sort((left, right) => left.name.localeCompare(right.name));
};

const canonicalizeTrustedRoot = async (
  root: Extract<ProjectAffinityRoot, { path: string }>,
  dependencies: ProjectAffinityResolverDependencies
): Promise<CanonicalTrustedRoot | null> => {
  let canonicalPath: string;
  try {
    canonicalPath = await dependencies.canonicalizePath(root.path);
  } catch {
    return null;
  }

  let repositoryRootDiscovered = false;
  if (root.source === "cli_cwd" || root.source === "cli_worktree") {
    let discovered: string | null = null;
    try {
      discovered = await dependencies.discoverRepositoryRoot(canonicalPath);
    } catch {
      // Repository discovery is opportunistic; the trusted canonical cwd
      // remains a valid affinity root when discovery is unavailable.
    }
    if (discovered) {
      try {
        canonicalPath = await dependencies.canonicalizePath(discovered);
        repositoryRootDiscovered = true;
      } catch {
        return null;
      }
    }
  }

  return {
    path: canonicalPath,
    repositoryRootDiscovered,
    rootAlias: alias("root", canonicalPath),
    source: root.source,
  };
};

const zeroMetadata = (
  root: ProjectAffinityRoot,
  reason: ProjectAffinityZeroReason,
  source: ProjectAffinityRoot["source"] = root.source
): ProjectAffinityRootMetadata => ({
  collectionAliases: [],
  reason,
  repositoryRootDiscovered: false,
  rootAlias: alias(
    "root",
    root.source === "remote_hint" ? root.hint : root.path
  ),
  source,
  status: "zero",
});

const relationOrder: Record<ProjectAffinityRelation, number> = {
  exact: 0,
  collection_contains_root: 1,
  root_contains_collection: 2,
};

const compareMatches = (
  left: ProjectAffinityMatch,
  right: ProjectAffinityMatch
): number =>
  relationOrder[left.relation] - relationOrder[right.relation] ||
  left.distance - right.distance ||
  left.collection.localeCompare(right.collection) ||
  left.rootAlias.localeCompare(right.rootAlias);

export async function resolveProjectAffinity(
  input: ProjectAffinityInput,
  collections: readonly Collection[],
  context: ProjectAffinityResolverContext,
  overrides: Partial<ProjectAffinityResolverDependencies> = {}
): Promise<ProjectAffinityResolution> {
  if (context.channel === "remote") {
    return {
      matches: [],
      roots: input.roots.map((root) =>
        zeroMetadata(root, "untrusted_remote_hint", "remote_hint")
      ),
    };
  }

  const dependencies: ProjectAffinityResolverDependencies = {
    canonicalizePath: overrides.canonicalizePath ?? defaultCanonicalizePath,
    discoverRepositoryRoot:
      overrides.discoverRepositoryRoot ?? defaultDiscoverRepositoryRoot,
  };
  const trustedRoots = input.roots.filter(
    (root): root is Extract<ProjectAffinityRoot, { path: string }> =>
      root.source !== "remote_hint"
  );
  const canonicalCollections =
    trustedRoots.length === 0
      ? []
      : await canonicalizeCollections(
          collections,
          dependencies.canonicalizePath
        );
  const matches: ProjectAffinityMatch[] = [];
  const roots: ProjectAffinityRootMetadata[] = [];

  for (const root of input.roots) {
    if (root.source === "remote_hint") {
      roots.push(zeroMetadata(root, "untrusted_remote_hint"));
      continue;
    }

    const canonicalRoot = await canonicalizeTrustedRoot(root, dependencies);
    if (!canonicalRoot) {
      roots.push(zeroMetadata(root, "root_unavailable"));
      continue;
    }

    const rootMatches = canonicalCollections
      .map((collection): ProjectAffinityMatch | null => {
        const relationship = describeRelationship(
          collection.path,
          canonicalRoot.path
        );
        return relationship
          ? {
              collection: collection.name,
              collectionAlias: collection.alias,
              rootAlias: canonicalRoot.rootAlias,
              source: canonicalRoot.source,
              ...relationship,
            }
          : null;
      })
      .filter((match): match is ProjectAffinityMatch => Boolean(match))
      .sort(compareMatches);

    if (rootMatches.length === 0) {
      roots.push({
        ...zeroMetadata(root, "no_collection_match"),
        repositoryRootDiscovered: canonicalRoot.repositoryRootDiscovered,
        rootAlias: canonicalRoot.rootAlias,
      });
      continue;
    }

    matches.push(...rootMatches);
    roots.push({
      collectionAliases: rootMatches.map((match) => match.collectionAlias),
      reason: null,
      repositoryRootDiscovered: canonicalRoot.repositoryRootDiscovered,
      rootAlias: canonicalRoot.rootAlias,
      source: root.source,
      status: "matched",
    });
  }

  matches.sort(compareMatches);
  return { matches, roots };
}
