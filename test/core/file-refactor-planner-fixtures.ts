import {
  FILE_REFACTOR_FIXTURE_MATRIX,
  type FileRefactorFixtureCase,
} from "./file-refactor-fixtures";

interface PlannerDocument {
  id: number;
  uri: string;
  relPath: string;
  collection: string;
  title: string;
  content?: string;
}

/** Fixtures with planner metadata, shared by adversarial planner/apply proofs. */
export function plannerDriveFixtures(): FileRefactorFixtureCase[] {
  return FILE_REFACTOR_FIXTURE_MATRIX.filter((fixture) => fixture.planner);
}

/** Build a live planner input for a fixture that declares planner metadata. */
export function fixtureToPlannerInput(fixture: FileRefactorFixtureCase): {
  operation: "rename" | "move";
  source: Omit<PlannerDocument, "id"> & { content: string; editable: true };
  target: Omit<PlannerDocument, "id">;
  documents: PlannerDocument[];
  targetOccupied: false;
} {
  const meta = fixture.planner;
  if (!meta) {
    throw new Error(`Fixture ${fixture.id} has no planner metadata`);
  }

  const referringRelPath = meta.referringRelPath ?? "referrer.md";
  let nextId = 1;
  const documents: PlannerDocument[] = [
    {
      id: nextId++,
      uri: `gno://notes/${meta.sourceRelPath}`,
      relPath: meta.sourceRelPath,
      collection: "notes",
      title: meta.sourceTitle,
    },
  ];

  for (const extra of meta.catalogExtras ?? []) {
    documents.push({
      id: nextId++,
      uri: `gno://notes/${extra.relPath}`,
      relPath: extra.relPath,
      collection: "notes",
      title: extra.title,
      content: extra.content,
    });
  }

  documents.push({
    id: nextId,
    uri: `gno://notes/${referringRelPath}`,
    relPath: referringRelPath,
    collection: "notes",
    title: "Referrer",
    content: fixture.content,
  });

  return {
    operation: meta.operation,
    source: {
      uri: `gno://notes/${meta.sourceRelPath}`,
      relPath: meta.sourceRelPath,
      collection: "notes",
      title: meta.sourceTitle,
      content: `# ${meta.sourceTitle}\n`,
      editable: true,
    },
    target: {
      uri: `gno://notes/${meta.targetRelPath}`,
      relPath: meta.targetRelPath,
      collection: "notes",
      title: meta.targetTitle,
    },
    documents,
    targetOccupied: false,
  };
}
