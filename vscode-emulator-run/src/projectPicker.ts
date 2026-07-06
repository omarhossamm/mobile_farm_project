import * as vscode from 'vscode';
import type { ProjectEntry, ProjectFlavor } from './serverClient';
import { UserCancelled } from './devicePicker';

/**
 * Interactive picker for {project, flavor} pairs coming from the
 * server's `list_projects` endpoint.
 *
 * Behavior mirrors the old local `flavorDiscovery` UX but with server
 * data:
 *   • Zero projects → throw a clear "no projects configured" error.
 *   • One project + zero flavors → return it, no prompt.
 *   • One project + one flavor  → return it, no prompt.
 *   • One project + N flavors   → single Quick Pick over flavors.
 *   • N projects                → two-step: pick project → pick flavor.
 *
 * `lastProject` / `lastFlavor` can be passed to pre-select the user's
 * previous choice (workspace-scoped persistence lives in extension.ts).
 */
export interface PickedRun {
  project: ProjectEntry;
  flavor: ProjectFlavor | null;
}

export async function pickProjectAndFlavor(
  projects: ProjectEntry[],
  opts: { lastProject?: string; lastFlavor?: string } = {}
): Promise<PickedRun> {
  if (projects.length === 0) {
    throw new Error(
      'No Flutter projects are configured on the server. ' +
      'Ask the operator to add one to flutter-projects.json.'
    );
  }
  const project = await pickProject(projects, opts.lastProject);
  const flavor  = await pickFlavor(project, opts.lastFlavor);
  return { project, flavor };
}

async function pickProject(projects: ProjectEntry[], lastId?: string): Promise<ProjectEntry> {
  if (projects.length === 1) return projects[0];

  interface Item extends vscode.QuickPickItem { project: ProjectEntry; }
  const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name));

  // Move last-used to the top so it's the default action.
  if (lastId) {
    const idx = sorted.findIndex((p) => p.id === lastId);
    if (idx > 0) sorted.unshift(...sorted.splice(idx, 1));
  }

  const items: Item[] = sorted.map((p) => ({
    project: p,
    label: `$(folder)  ${p.name}`,
    description: p.flavors.length === 0 ? 'no flavors' : `${p.flavors.length} flavor(s)`,
    detail: p.id,
    picked: p.id === lastId,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Choose a Flutter project',
    placeHolder: lastId ? `Last used: ${lastId}` : 'Pick which project to build & run on the remote host',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) throw new UserCancelled();
  return picked.project;
}

async function pickFlavor(project: ProjectEntry, lastName?: string): Promise<ProjectFlavor | null> {
  const flavors = project.flavors;
  if (flavors.length === 0) return null;
  if (flavors.length === 1) return flavors[0];

  interface Item extends vscode.QuickPickItem { flavor: ProjectFlavor | null; }
  const sorted = [...flavors].sort((a, b) => a.name.localeCompare(b.name));

  if (lastName) {
    const idx = sorted.findIndex((f) => f.name === lastName);
    if (idx > 0) sorted.unshift(...sorted.splice(idx, 1));
  }

  const items: Item[] = sorted.map((f) => ({
    flavor: f,
    label: f.name,
    description: describeFlavor(f),
    picked: f.name === lastName,
  }));
  items.push({
    flavor: null,
    label: '$(gear) Default',
    description: 'no --flavor / no --target',
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: `Choose a flavor for ${project.name}`,
    placeHolder: lastName ? `Last used: ${lastName}` : 'Pick which Flutter flavor / entry point to run',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) throw new UserCancelled();
  return picked.flavor;
}

function describeFlavor(f: ProjectFlavor): string {
  const bits: string[] = [];
  if (f.flavor) bits.push(`--flavor ${f.flavor}`);
  if (f.target) bits.push(f.target);
  if (f.args?.length) bits.push(f.args.join(' '));
  return bits.join(' · ');
}
