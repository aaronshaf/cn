import { readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import type { PushCandidate } from './file-scanner.js';

/**
 * Extract all local markdown links from content.
 *
 * Matches markdown links like [text](path.md) but excludes:
 * - http:// and https:// URLs
 * - Links to non-.md files
 *
 * @param content - Markdown content to extract links from
 * @returns Array of relative paths (as written in the markdown)
 */
export function extractLocalLinks(content: string): string[] {
  // Match markdown links: [text](path.md) or [text](path.md#anchor)
  // The text part can contain nested brackets (e.g., [text [nested]](link.md))
  // Pattern explanation:
  // \[([^\[\]]+(?:\[[^\]]*\][^\[\]]*)*)\] - Match [text] allowing nested brackets
  // \(([^)#]+\.md)(?:#[^)]*)?\) - Match (path.md) or (path.md#anchor)
  const linkPattern = /\[([^[\]]+(?:\[[^\]]*\][^[\]]*)*)\]\(([^)#]+\.md)(?:#[^)]*)?\)/g;

  const links: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = linkPattern.exec(content)) !== null) {
    const linkPath = match[2];

    // Skip external URLs
    if (linkPath.startsWith('http://') || linkPath.startsWith('https://')) {
      continue;
    }

    // Remove any anchor fragments (e.g., file.md#section -> file.md)
    const pathWithoutAnchor = linkPath.split('#')[0];

    links.push(pathWithoutAnchor);
  }

  return links;
}

/**
 * Resolve a link path relative to the source file's directory.
 *
 * @param linkPath - The link path as written in markdown
 * @param sourceFilePath - The path of the file containing the link (relative to directory)
 * @returns Normalized path relative to directory root
 */
function resolveLinkPath(linkPath: string, sourceFilePath: string): string {
  // Get the directory containing the source file
  const sourceDir = dirname(sourceFilePath);

  // Join and normalize the path
  const resolvedPath = normalize(join(sourceDir, linkPath));

  return resolvedPath;
}

/**
 * Sort push candidates by dependencies so linked-to pages are pushed first.
 *
 * Uses Kahn's algorithm for topological sorting with cycle detection.
 * If cycles are detected, the files involved in cycles are still included
 * in the output (in their original relative order).
 *
 * @param candidates - Array of push candidates to sort
 * @param directory - Root directory for resolving file paths
 * @returns Object containing:
 *   - sorted: Candidates sorted so dependencies come first
 *   - cycles: Array of detected cycles (each cycle is array of paths)
 */
export function sortByDependencies(
  candidates: PushCandidate[],
  directory: string,
): { sorted: PushCandidate[]; cycles: string[][] } {
  // Build a set of candidate paths for quick lookup
  const candidatePaths = new Set(candidates.map((c) => c.path));

  // Build dependency graph: file -> files it depends on (links to)
  // dependsOn[A] = [B, C] means A links to B and C
  const dependsOn = new Map<string, Set<string>>();

  // Build reverse graph: file -> files that depend on it (link to it)
  // dependedBy[B] = [A] means A links to B
  const dependedBy = new Map<string, Set<string>>();

  // Initialize maps for all candidates
  for (const candidate of candidates) {
    dependsOn.set(candidate.path, new Set());
    dependedBy.set(candidate.path, new Set());
  }

  // Read each candidate's content and extract dependencies
  for (const candidate of candidates) {
    const fullPath = join(directory, candidate.path);

    let content: string;
    try {
      content = readFileSync(fullPath, 'utf-8');
    } catch {
      // If we can't read the file, skip dependency analysis for it
      continue;
    }

    const links = extractLocalLinks(content);

    for (const link of links) {
      // Resolve the link relative to the candidate's location
      const resolvedLink = resolveLinkPath(link, candidate.path);

      // Only track dependencies that are also candidates
      if (candidatePaths.has(resolvedLink)) {
        // candidate.path depends on resolvedLink
        dependsOn.get(candidate.path)!.add(resolvedLink);
        dependedBy.get(resolvedLink)!.add(candidate.path);
      }
    }
  }

  // Kahn's algorithm for topological sort
  // Start with nodes that have no dependencies
  const sorted: PushCandidate[] = [];
  const candidateMap = new Map(candidates.map((c) => [c.path, c]));

  // Queue of nodes with no remaining dependencies
  const queue: string[] = [];

  // Count of unprocessed dependencies for each node
  const inDegree = new Map<string, number>();

  // Initialize in-degrees
  for (const candidate of candidates) {
    const deps = dependsOn.get(candidate.path)!;
    inDegree.set(candidate.path, deps.size);

    if (deps.size === 0) {
      queue.push(candidate.path);
    }
  }

  // Process queue
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(candidateMap.get(current)!);

    // For each file that depends on current, decrement its in-degree
    const dependents = dependedBy.get(current)!;
    for (const dependent of dependents) {
      const newDegree = inDegree.get(dependent)! - 1;
      inDegree.set(dependent, newDegree);

      if (newDegree === 0) {
        queue.push(dependent);
      }
    }
  }

  // Detect cycles: any nodes not in sorted output are part of cycles
  const cycles: string[][] = [];
  const sortedPaths = new Set(sorted.map((c) => c.path));
  const remainingPaths = candidates.filter((c) => !sortedPaths.has(c.path)).map((c) => c.path);

  if (remainingPaths.length > 0) {
    // Find cycles using DFS
    const visited = new Set<string>();
    const inStack = new Set<string>();

    function findCycles(node: string, path: string[]): void {
      if (inStack.has(node)) {
        // Found a cycle - extract it from path
        const cycleStart = path.indexOf(node);
        const cycle = path.slice(cycleStart);
        cycles.push(cycle);
        return;
      }

      if (visited.has(node)) {
        return;
      }

      visited.add(node);
      inStack.add(node);
      path.push(node);

      const deps = dependsOn.get(node);
      if (deps) {
        for (const dep of deps) {
          if (remainingPaths.includes(dep)) {
            findCycles(dep, [...path]);
          }
        }
      }

      inStack.delete(node);
    }

    for (const start of remainingPaths) {
      if (!visited.has(start)) {
        findCycles(start, []);
      }
    }

    // Add remaining candidates to sorted output (in their original order)
    // so they still get pushed even if they're in cycles
    for (const path of remainingPaths) {
      sorted.push(candidateMap.get(path)!);
    }
  }

  return { sorted, cycles };
}
