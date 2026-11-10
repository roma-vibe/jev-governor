// What the memory tab's API returns: shared by the server (lib/memory.ts) and the page (src/api.ts).
// Types only, nothing from node: the page's build reads this file too.

import type { FactType, Importance } from '../../hooks/lib/mnema.ts';

/** A fact as the page shows it. */
export type FactView = {
  id: string;
  /** The memory it is stored in (an older id of the project, for a fact read through an alias). */
  memory: string;
  text: string;
  type: FactType | null;
  tags: string[];
  importance: Importance;
  pinned: boolean;
  status: string;
  /** Saved by the mod from a dialog, not by hand or by the model. */
  auto: boolean;
  /** A chat's note (what it did and left open), not a fact. */
  session: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MemoryProjectView = {
  id: string;
  name: string;
  names: string[];
  roots: string[];
  aliases: { id: string; facts: number }[];
  related: string[];
  facts: number;
  /** No git remote: the memory is tied to the folder's path. */
  local: boolean;
  seenAt: string | null;
};

export type MemoryOverview = {
  enabled: boolean;
  /** A key for the service was found. */
  configured: boolean;
  reachable: boolean;
  error: string | null;
  url: string;
  keyFile: string;
  personal: { id: string; facts: number } | null;
  projects: MemoryProjectView[];
  /** What the mod did with the memory in the last days (its journal). */
  activity: { days: number; recalls: number; recallsWithNotes: number; notes: number; saves: number; factsSaved: number; chatNotes: number; failures: number; lastError: string | null };
};
