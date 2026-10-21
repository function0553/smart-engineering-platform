export type PendingArchiveExport = { id: string; version: number; snapshot: string; attempted?: boolean };
export type PendingArchiveUpload = { segmentId: string; stageId: string; files: {name: string; sha256: string; bytes: number}[] };
export type ArchiveDraft<T> = {
  id: string;
  data: T;
  version: number;
  dirty: boolean;
  creationId?: string;
  creationData?: T;
  pendingExport?: PendingArchiveExport;
  pendingUploads?: PendingArchiveUpload[];
};
export type StoredArchiveDraft<T> = { draft: ArchiveDraft<T>; slot: string; sourceKey: string };
export type ArchiveConflictBackup<T> = { sourceKey: string; draft: ArchiveDraft<T>; savedAt: string; serverVersion: number };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validSlot = (slot: string) => slot === 'new' || uuid.test(slot);
const storageError = () => new Error('本机草稿读写失败，请检查可用空间后重试；此前备份仍保留。');

// The origin is explicit as Android's local origin and selected backend are different scopes.
export const archiveDraftScope = (origin: string, backend: string, userId: string,projectId='') =>
  projectId?`photo-archive:project:v1:${JSON.stringify([origin,backend,userId,projectId])}:`:`photo-archive:${encodeURIComponent(origin)}:${encodeURIComponent(backend)}:${userId}:`;

export function archiveDraftStorage<T>(scope: string, legacyScope: string, validData: (value: unknown) => value is T) {
  function parse(raw: string, slot: string): ArchiveDraft<T> {
    const value = JSON.parse(raw);
    const id = value?.id || (slot === 'new' ? value?.creationId : slot);
    const version = value?.version === undefined && slot === 'new' ? 0 : value?.version;
    if (!uuid.test(id) || !validData(value?.data) || !Number.isInteger(version) || version < 0) throw storageError();
    if (value.creationId !== undefined && !uuid.test(value.creationId)) throw storageError();
    if (value.creationData !== undefined && !validData(value.creationData)) throw storageError();
    const pending = value.pendingExport;
    if (pending && (!uuid.test(pending.id) || !Number.isInteger(pending.version) || pending.version < 1 || typeof pending.snapshot !== 'string' || (pending.attempted !== undefined && typeof pending.attempted !== 'boolean'))) throw storageError();
    const uploads = value.pendingUploads;
    if (uploads !== undefined && (!Array.isArray(uploads) || uploads.some(batch => !batch || !uuid.test(batch.segmentId) || !uuid.test(batch.stageId) || !Array.isArray(batch.files) || batch.files.some((file: {name?: unknown; sha256?: unknown; bytes?: unknown}) => !file || typeof file.name !== 'string' || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256) || !Number.isInteger(file.bytes) || Number(file.bytes) < 1)))) throw storageError();
    return { id, data: value.data, version, dirty: value.dirty === undefined ? true : !!value.dirty,
      ...(version === 0 ? { creationId: value.creationId || id } : {}),
      ...(value.creationData ? { creationData: value.creationData } : {}),
      ...(pending ? { pendingExport: pending } : {}), ...(uploads?.length ? { pendingUploads: uploads } : {}) };
  }
  function read(slot: string): StoredArchiveDraft<T> | undefined {
    try {
      for (const prefix of [scope, legacyScope]) {
        const sourceKey = prefix + slot, raw = localStorage.getItem(sourceKey);
        if (raw !== null) return { draft: parse(raw, slot), slot, sourceKey };
      }
      return undefined;
    } catch { throw storageError(); }
  }
  function index(): string[] {
    const raw = localStorage.getItem(scope + 'index');
    if (raw === null) return [];
    const value = JSON.parse(raw);
    if (!Array.isArray(value) || value.some(slot => typeof slot !== 'string' || !validSlot(slot))) throw storageError();
    return [...new Set(value)];
  }
  function write(slot: string, draft: ArchiveDraft<T>) {
    try {
      if (!validSlot(slot)) throw storageError();
      const slots = index();
      // Prepare discovery first: an index failure must not overwrite the earlier draft.
      // An orphan index entry is harmless and read() ignores its missing draft.
      if (!slots.includes(slot)) localStorage.setItem(scope + 'index', JSON.stringify([...slots, slot]));
      localStorage.setItem(scope + slot, JSON.stringify(draft));
    } catch { throw storageError(); }
  }
  function discover(): StoredArchiveDraft<T>[] {
    try {
      const slots = new Set(index());
      slots.add('new');
      // Recover an orphan if the previous index write failed; also discover pre-upgrade drafts.
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        for (const prefix of [scope, legacyScope]) if (key?.startsWith(prefix) && validSlot(key.slice(prefix.length))) slots.add(key.slice(prefix.length));
      }
      const results: StoredArchiveDraft<T>[] = [];
      for (const slot of slots) {
        const entry = read(slot);
        // A confirmed archive receipt supersedes an old new-slot whose cleanup failed.
        if (entry && slot === 'new' && read(entry.draft.id)?.draft.version) continue;
        if (entry && (entry.draft.dirty || !entry.draft.version || entry.draft.pendingExport || entry.draft.pendingUploads?.length)) results.push(entry);
      }
      return results.filter((entry, i, all) => all.findIndex(other => other.draft.id === entry.draft.id) === i);
    } catch { throw storageError(); }
  }
  function retire(entry: StoredArchiveDraft<T>, targetSlot: string): boolean {
    // A receipt is already committed to its target before this optional cleanup is attempted.
    if (entry.sourceKey === scope + targetSlot) return true;
    try {
      if (entry.slot === 'new') {
        for (const prefix of [scope, legacyScope]) {
          const raw = localStorage.getItem(prefix + 'new');
          if (raw !== null && parse(raw, 'new').id === entry.draft.id) localStorage.removeItem(prefix + 'new');
        }
      } else localStorage.removeItem(entry.sourceKey);
      return true;
    } catch { return false; }
  }
  function conflicts(archiveId?: string): ArchiveConflictBackup<T>[] {
    try {
      const prefix = scope + 'conflict:', results: ArchiveConflictBackup<T>[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const sourceKey = localStorage.key(i);
        if (!sourceKey?.startsWith(prefix)) continue;
        const value = JSON.parse(localStorage.getItem(sourceKey)!);
        const draft = parse(JSON.stringify(value.draft), value.draft?.id);
        if (typeof value.savedAt !== 'string' || !Number.isInteger(value.serverVersion) || value.serverVersion < 1) throw storageError();
        if (!archiveId || draft.id === archiveId) results.push({sourceKey, draft, savedAt: value.savedAt, serverVersion: value.serverVersion});
      }
      return results.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    } catch { throw storageError(); }
  }
  function preserveConflict(entry: StoredArchiveDraft<T>, serverVersion: number): ArchiveConflictBackup<T> {
    try {
      const matching = conflicts(entry.draft.id).find(backup => JSON.stringify(backup.draft) === JSON.stringify(entry.draft));
      if (matching) return matching;
      // Never reuse the working-draft slot. A normal edit or server receipt must
      // not be able to overwrite the only copy of the conflicting local data.
      const sourceKey = scope + 'conflict:' + entry.draft.id + ':' + crypto.randomUUID();
      const backup = {draft: entry.draft, savedAt: new Date().toISOString(), serverVersion};
      const serialized = JSON.stringify(backup);
      localStorage.setItem(sourceKey, serialized);
      if (localStorage.getItem(sourceKey) !== serialized) throw storageError();
      return {...backup, sourceKey};
    } catch { throw storageError(); }
  }
  return { read, write, discover, retire, conflicts, preserveConflict, key: (slot: string) => scope + slot };
}
