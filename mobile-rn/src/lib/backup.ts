import * as DocumentPicker from "expo-document-picker";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { unzipSync, zipSync } from "fflate";

import { closeDatabase, getDatabase, inspectDatabaseFile } from "@/data/database";

function timestamp(): string {
  return new Date().toISOString().replace(/[.:]/g, "-").slice(0, 19);
}

function collectDirectoryFiles(directory: Directory, prefix: string, output: Record<string, Uint8Array>): void {
  for (const entry of directory.list()) {
    const name = entry.name;
    if (entry instanceof Directory) {
      collectDirectoryFiles(entry, `${prefix}${name}/`, output);
    } else if (entry instanceof File) {
      output[`${prefix}${name}`] = entry.bytesSync();
    }
  }
}

const DATABASE_NAME = "openfic.db";
const STYLE_LIBRARY_NAME = "style-library";
const BACKUP_TYPE = "openficm.backup";
const BACKUP_SCHEMA_VERSION = 1;

/**
 * 整库备份：把 SQLite 数据库和文风书库原始文件打成 zip，用系统分享面板发出去。
 * API Key 存在系统安全存储里，不在备份中。
 */
export async function exportBackup(): Promise<void> {
  // 确保数据库连接已建立、WAL 已落盘到主库文件。
  const db = await getDatabase();
  await db.execAsync("PRAGMA wal_checkpoint(FULL)");

  const databaseFile = new File(Paths.document, "SQLite", DATABASE_NAME);
  if (!databaseFile.exists) throw new Error("找不到数据库文件");

  const entries: Record<string, Uint8Array> = {
    [DATABASE_NAME]: databaseFile.bytesSync(),
  };
  const styleLibrary = new Directory(Paths.document, STYLE_LIBRARY_NAME);
  if (styleLibrary.exists) {
    collectDirectoryFiles(styleLibrary, `${STYLE_LIBRARY_NAME}/`, entries);
  }
  const manifest = {
    type: BACKUP_TYPE,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    note: "恢复方法：在 OpenFicM 的“设置 → 通用”里点“从备份恢复”，选择这个压缩包。API Key 不在备份里，恢复后需要重新填写。",
  };
  entries["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

  const zipped = zipSync(entries, { level: 6 });
  const zipFile = new File(Paths.cache, `OpenFicM-backup-${timestamp()}.zip`);
  if (zipFile.exists) zipFile.delete();
  zipFile.write(zipped);

  if (!(await Sharing.isAvailableAsync())) throw new Error("当前设备不支持系统分享");
  await Sharing.shareAsync(zipFile.uri, {
    mimeType: "application/zip",
    dialogTitle: "导出 OpenFicM 备份",
  });
}

const MAX_BACKUP_ARCHIVE_BYTES = 600 * 1024 * 1024;
const MAX_BACKUP_DATABASE_BYTES = 1024 * 1024 * 1024;
const MAX_BACKUP_LIBRARY_BYTES = 1024 * 1024 * 1024;
const MAX_BACKUP_LIBRARY_FILES = 2_000;
const SQLITE_MAGIC = "SQLite format 3\u0000";
/** 文风书库里的文件名形如 <id>.epub、<id>.content.txt；只接受这种扁平、安全的名字。 */
const LIBRARY_FILE_PATTERN = /^[A-Za-z0-9_-]{1,80}(\.[A-Za-z0-9]{1,12}){1,2}$/;

export interface BackupRestoreResult {
  exportedAt: string | null;
  projectCount: number;
  libraryFileCount: number;
}

function hasSqliteHeader(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_MAGIC.length) return false;
  for (let index = 0; index < SQLITE_MAGIC.length; index += 1) {
    if (bytes[index] !== SQLITE_MAGIC.charCodeAt(index)) return false;
  }
  return true;
}

function removeFile(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // 清理失败不影响主流程。
  }
}

function removeDirectory(directory: Directory): void {
  try {
    if (directory.exists) directory.delete();
  } catch {
    // 清理失败不影响主流程。
  }
}

/**
 * 从备份压缩包恢复全部数据（功能由社区补丁提出，作者"打包一份凉皮"）。
 *
 * 顺序是"先准备、再校验、最后替换"：新数据库和新书库先写到临时位置，数据库通过完整性
 * 检查后才动现有数据；替换阶段任何一步失败都会把原来的数据库和书库改名放回去。
 * 调用方负责先向用户确认，并保证此时没有助手任务或文风蒸馏在运行。
 */
export async function importBackup(options?: {
  /** 校验通过、即将替换数据前调用：用来中止正在运行的助手任务并清空界面上的旧状态。 */
  beforeReplace?: () => void;
}): Promise<BackupRestoreResult | null> {
  const picked = await DocumentPicker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: true, multiple: false });
  if (picked.canceled) return null;
  const asset = picked.assets[0];
  const archiveFile = new File(asset.uri);
  const archiveSize = asset.size ?? archiveFile.size;
  if (!archiveSize) throw new Error("备份文件是空的");
  if (archiveSize > MAX_BACKUP_ARCHIVE_BYTES) throw new Error("备份文件超过 600 MB，无法在手机上恢复");

  let databaseBytes = 0;
  let libraryBytes = 0;
  let libraryFiles = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(await archiveFile.bytes(), {
      filter: (entry) => {
        if (entry.name === "manifest.json") return entry.originalSize <= 64 * 1024;
        if (entry.name === DATABASE_NAME) {
          databaseBytes = entry.originalSize;
          if (databaseBytes > MAX_BACKUP_DATABASE_BYTES) throw new Error("备份里的数据库超过 1 GB，无法在手机上恢复");
          return true;
        }
        if (!entry.name.startsWith(`${STYLE_LIBRARY_NAME}/`)) return false;
        const name = entry.name.slice(STYLE_LIBRARY_NAME.length + 1);
        // 目录项、子目录、带 .. 的路径一律不解压，避免把文件写到书库目录之外。
        if (!LIBRARY_FILE_PATTERN.test(name)) return false;
        libraryFiles += 1;
        libraryBytes += entry.originalSize;
        if (libraryFiles > MAX_BACKUP_LIBRARY_FILES || libraryBytes > MAX_BACKUP_LIBRARY_BYTES) {
          throw new Error("备份里的参考书超过恢复上限（2000 个文件或 1 GB）");
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof Error && /备份里/.test(error.message)) throw error;
    throw new Error("无法解压这个文件，它不是 OpenFicM 导出的备份压缩包");
  }

  const manifestBytes = entries["manifest.json"];
  if (!manifestBytes) throw new Error("备份包无效：缺少 manifest.json");
  let manifest: { type?: unknown; schemaVersion?: unknown; exportedAt?: unknown };
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as typeof manifest;
  } catch {
    throw new Error("备份包无效：manifest.json 无法解析");
  }
  if (manifest?.type !== BACKUP_TYPE) throw new Error("备份包无效：这不是 OpenFicM 的备份");
  if (typeof manifest.schemaVersion === "number" && manifest.schemaVersion > BACKUP_SCHEMA_VERSION) {
    throw new Error("这个备份来自更新版本的 OpenFicM，请先升级应用再恢复");
  }
  const database = entries[DATABASE_NAME];
  if (!database?.byteLength) throw new Error("备份包无效：缺少数据库文件");
  if (!hasSqliteHeader(database)) throw new Error("备份包无效：数据库文件已损坏");

  const stamp = timestamp();
  const sqliteDirectory = new Directory(Paths.document, "SQLite");
  sqliteDirectory.create({ idempotent: true, intermediates: true });
  const candidateName = `restore-${stamp}.db`;
  const candidateFile = new File(sqliteDirectory, candidateName);
  const stagedLibrary = new Directory(Paths.document, `${STYLE_LIBRARY_NAME}.restore-${stamp}`);
  const cleanupCandidate = () => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) removeFile(new File(sqliteDirectory, `${candidateName}${suffix}`));
  };

  // 第一阶段：写到临时位置并校验。此时现有数据一个字节都没动。
  let projectCount = 0;
  try {
    candidateFile.create({ overwrite: true });
    candidateFile.write(database);
    projectCount = (await inspectDatabaseFile(candidateName)).projectCount;
    removeDirectory(stagedLibrary);
    stagedLibrary.create({ idempotent: true, intermediates: true });
    for (const [path, bytes] of Object.entries(entries)) {
      if (!path.startsWith(`${STYLE_LIBRARY_NAME}/`)) continue;
      const file = new File(stagedLibrary, path.slice(STYLE_LIBRARY_NAME.length + 1));
      file.create({ overwrite: true });
      file.write(bytes);
    }
  } catch (error) {
    cleanupCandidate();
    removeDirectory(stagedLibrary);
    throw new Error(`备份校验失败，现有数据没有改动：${error instanceof Error ? error.message : String(error)}`);
  }

  // 第二阶段：替换。旧数据先改名留着，全部成功后才删。
  const liveDatabase = new File(sqliteDirectory, DATABASE_NAME);
  const liveLibrary = new Directory(Paths.document, STYLE_LIBRARY_NAME);
  const oldDatabaseName = `${DATABASE_NAME}.before-restore-${stamp}`;
  const oldLibraryName = `${STYLE_LIBRARY_NAME}.before-restore-${stamp}`;
  let databaseSwapped = false;
  let librarySwapped = false;
  let hadDatabase = false;
  let hadLibrary = false;
  options?.beforeReplace?.();
  await closeDatabase();
  try {
    for (const suffix of ["-wal", "-shm"]) removeFile(new File(sqliteDirectory, `${DATABASE_NAME}${suffix}`));
    hadDatabase = liveDatabase.exists;
    if (hadDatabase) liveDatabase.rename(oldDatabaseName);
    databaseSwapped = true;
    new File(sqliteDirectory, candidateName).rename(DATABASE_NAME);
    hadLibrary = liveLibrary.exists;
    if (hadLibrary) liveLibrary.rename(oldLibraryName);
    librarySwapped = true;
    stagedLibrary.rename(STYLE_LIBRARY_NAME);
    // 重新打开并跑迁移：旧版本的备份在这里升级到当前结构。
    const reopened = await getDatabase();
    // 参考书记录里存的是绝对路径；换过手机或重装后目录不同，按文件名改指到当前书库。
    const libraryUri = new Directory(Paths.document, STYLE_LIBRARY_NAME).uri.replace(/\/+$/, "");
    const sources = await reopened.getAllAsync<{ id: string; file_uri: string }>("SELECT id, file_uri FROM style_sources");
    for (const source of sources) {
      const fileName = source.file_uri.split("/").pop() ?? "";
      if (!LIBRARY_FILE_PATTERN.test(fileName)) continue;
      const nextUri = `${libraryUri}/${fileName}`;
      if (nextUri !== source.file_uri) {
        await reopened.runAsync("UPDATE style_sources SET file_uri = ? WHERE id = ?", nextUri, source.id);
      }
    }
  } catch (error) {
    // 还原：把刚换上去的删掉，把改了名的旧数据放回原位。
    await closeDatabase().catch(() => undefined);
    if (librarySwapped) {
      removeDirectory(new Directory(Paths.document, STYLE_LIBRARY_NAME));
      if (hadLibrary) {
        try {
          new Directory(Paths.document, oldLibraryName).rename(STYLE_LIBRARY_NAME);
        } catch {
          // 还原失败时旧书库仍以 before-restore 名称留在应用目录里。
        }
      }
    }
    if (databaseSwapped) {
      for (const suffix of ["", "-wal", "-shm"]) removeFile(new File(sqliteDirectory, `${DATABASE_NAME}${suffix}`));
      if (hadDatabase) {
        try {
          new File(sqliteDirectory, oldDatabaseName).rename(DATABASE_NAME);
        } catch {
          // 还原失败时旧数据库仍以 before-restore 名称留在 SQLite 目录里。
        }
      }
    }
    cleanupCandidate();
    removeDirectory(stagedLibrary);
    throw new Error(`恢复失败，已还原到恢复前的数据：${error instanceof Error ? error.message : String(error)}`);
  }

  removeFile(new File(sqliteDirectory, oldDatabaseName));
  removeDirectory(new Directory(Paths.document, oldLibraryName));
  removeFile(archiveFile);
  return {
    exportedAt: typeof manifest.exportedAt === "string" ? manifest.exportedAt : null,
    projectCount,
    libraryFileCount: libraryFiles,
  };
}
