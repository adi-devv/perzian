import type { PermissionMode, State } from "@perzian/protocol";

/** The permission mode a new session starts in: the creator's choice, else the global default setting. */
export const startMode = (requested: PermissionMode | undefined, settings: Pick<State["settings"], "defaultMode">): PermissionMode => requested ?? settings.defaultMode;
