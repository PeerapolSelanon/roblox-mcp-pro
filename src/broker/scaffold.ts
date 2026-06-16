/**
 * Rojo-style `default.project.json` generator. Used by the sync engine when it
 * seeds a new place mirror on disk (explorer/ tree -> DataModel services).
 *
 * (The on-disk project scaffolder that backed the dashboard's "New project"
 * button was removed along with the dashboard Project tab.)
 */

/** Rojo project file pointing at an explorer/ mirror (one per synced place). */
export function defaultProjectJson(name: string): string {
  return JSON.stringify(
    {
      name,
      tree: {
        $className: "DataModel",
        Workspace: { $path: "explorer/Workspace" },
        ReplicatedStorage: { $path: "explorer/ReplicatedStorage" },
        ReplicatedFirst: { $path: "explorer/ReplicatedFirst" },
        ServerScriptService: { $path: "explorer/ServerScriptService" },
        ServerStorage: { $path: "explorer/ServerStorage" },
        StarterGui: { $path: "explorer/StarterGui" },
        Lighting: { $path: "explorer/Lighting" },
        StarterPlayer: {
          StarterPlayerScripts: { $path: "explorer/StarterPlayer/StarterPlayerScripts" },
          StarterCharacterScripts: { $path: "explorer/StarterPlayer/StarterCharacterScripts" },
        },
      },
    },
    null,
    2,
  );
}
