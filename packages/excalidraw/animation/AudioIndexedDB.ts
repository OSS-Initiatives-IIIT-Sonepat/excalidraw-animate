/**
 * IndexedDB storage for audio file bytes, modelled after how
 * excalidraw-app/data/LocalData.ts stores image BinaryFileData.
 *
 * Raw IndexedDB API is used because idb-keyval lives in excalidraw-app,
 * not in the @excalidraw/excalidraw package.
 */

export interface StoredAudioData {
  /** unique id (matches the AudioClip.fileId) */
  id: string;
  /** original file name */
  name: string;
  /** mime type, e.g. audio/mpeg */
  mimeType: string;
  /** raw file bytes */
  data: ArrayBuffer;
  /** epoch ms */
  created: number;
}

const DB_NAME = "excalidraw-animate-audio";
const DB_VERSION = 1;
const STORE_NAME = "audio-clips";

let dbPromise: Promise<IDBDatabase> | null = null;

const openDB = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
  });

  return dbPromise;
};

/** Save a File (or Blob) into IndexedDB keyed by fileId. */
export const saveAudioToIndexedDB = async (
  fileId: string,
  file: File,
): Promise<void> => {
  const db = await openDB();
  const data = await file.arrayBuffer();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    const record: StoredAudioData = {
      id: fileId,
      name: file.name,
      mimeType: file.type || "audio/mpeg",
      data,
      created: Date.now(),
    };

    store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

/** Load audio bytes from IndexedDB and return as a Blob (suitable for
 *  URL.createObjectURL). */
export const loadAudioFromIndexedDB = async (
  fileId: string,
): Promise<Blob | null> => {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(fileId);

    req.onsuccess = () => {
      const result: StoredAudioData | undefined = req.result;
      if (!result) {
        resolve(null);
        return;
      }
      const blob = new Blob([result.data], { type: result.mimeType });
      resolve(blob);
    };
    req.onerror = () => reject(req.error);
  });
};

/** Delete a single audio entry from IndexedDB. */
export const deleteAudioFromIndexedDB = async (fileId: string): Promise<void> => {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(fileId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

/** Remove audio files that are no longer referenced by any clip.
 *  `usedFileIds` should contain every AudioClip.fileId currently on
 *  the timeline across all frames. */
export const clearObsoleteAudio = async (
  usedFileIds: Set<string>,
): Promise<void> => {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();

    req.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result as
        | IDBCursorWithValue
        | undefined;
      if (!cursor) {
        return;
      }
      const record: StoredAudioData = cursor.value;
      if (!usedFileIds.has(record.id)) {
        cursor.delete();
      }
      cursor.continue();
    };

    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};
