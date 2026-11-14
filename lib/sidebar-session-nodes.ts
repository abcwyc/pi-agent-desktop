/**
 * The session rows of a sidebar project group, as a tree (#237).
 *
 * Only subagent runs and side chats nest under the session that started them;
 * a fork is a row of its own beside its source, so folding the source never
 * hides it. A fork's own subagents nest under the fork.
 */

import { isHiddenRelation } from "./session-family";
import { skillExpansionToCommand } from "./slash-display";
import type { SessionInfo } from "./types";

export interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

export function treeContainsSession(node: SessionTreeNode, sessionId: string): boolean {
  return node.session.id === sessionId || node.children.some((child) => treeContainsSession(child, sessionId));
}

export function countTreeDescendants(node: SessionTreeNode): number {
  return node.children.reduce((total, child) => total + 1 + countTreeDescendants(child), 0);
}

/** The name a session row shows (SessionItem's title, without a side chat's number). */
export function sessionRowTitle(session: SessionInfo): string {
  const firstMessage = skillExpansionToCommand(session.firstMessage) ?? session.firstMessage;
  return session.name || firstMessage.slice(0, 50) || session.id.slice(0, 12);
}

export function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const s of sessions) {
    byId.set(s.id, { session: s, children: [] });
  }

  // Only subagent runs and side chats nest under their parent (#237): a fork
  // is a row of its own beside its source, marked with the fork glyph, so
  // folding the source never hides it. Build the parent chains of those only,
  // so a missing ancestor still resolves to the nearest one that is listed.
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    if (isHiddenRelation(s.relation)) parentOf.set(s.id, s.relation.parentSessionId);
  }

  // Walk up the parentSessionId chain to find the nearest ancestor that exists in byId
  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null; // cycle guard
      visited.add(cur);
      if (byId.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) {
      byId.get(ancestor)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort each level by modified desc
  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

