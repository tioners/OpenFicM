import * as SQLite from "expo-sqlite";

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function migrateChatSessions(database: SQLite.SQLiteDatabase): Promise<void> {
  const columns = await database.getAllAsync<{ name: string }>("PRAGMA table_info(chat_messages)");
  if (!columns.some((column) => column.name === "session_id")) {
    try {
      await database.execAsync(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;

        DROP TABLE IF EXISTS chat_messages_migrated;
        CREATE TABLE chat_messages_migrated (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata_json TEXT,
          created_at TEXT NOT NULL
        );

        INSERT OR IGNORE INTO chat_sessions(id, project_id, title, model_id, created_at, updated_at)
        SELECT 'legacy-' || project_id, project_id, '历史对话', NULL, MIN(created_at), MAX(created_at)
        FROM chat_messages
        GROUP BY project_id;

        INSERT INTO chat_messages_migrated(id, project_id, session_id, role, content, created_at)
        SELECT id, project_id, 'legacy-' || project_id, role, content, created_at
        FROM chat_messages;

        DROP TABLE chat_messages;
        ALTER TABLE chat_messages_migrated RENAME TO chat_messages;
        COMMIT;
      `);
    } catch (error) {
      await database.execAsync("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await database.execAsync("PRAGMA foreign_keys = ON;");
    }
  }

  await database.execAsync(`
    INSERT OR IGNORE INTO chat_sessions(id, project_id, title, model_id, created_at, updated_at)
    SELECT 'legacy-' || project_id, project_id, '历史对话', NULL, MIN(created_at), MAX(created_at)
    FROM chat_messages
    WHERE session_id IS NULL OR session_id = ''
    GROUP BY project_id;

    UPDATE chat_messages
    SET session_id = 'legacy-' || project_id
    WHERE session_id IS NULL OR session_id = '';

    CREATE INDEX IF NOT EXISTS idx_chat_sessions_project_updated
      ON chat_sessions(project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_project_created
      ON chat_messages(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_session_created
      ON chat_messages(session_id, created_at);
  `);

  const currentColumns = await database.getAllAsync<{ name: string }>("PRAGMA table_info(chat_messages)");
  if (!currentColumns.some((column) => column.name === "metadata_json")) {
    await database.execAsync("ALTER TABLE chat_messages ADD COLUMN metadata_json TEXT;");
  }
}

async function migrate(database: SQLite.SQLiteDatabase): Promise<void> {
  await database.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS volumes (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      order_index INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chapters (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      order_index INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS style_sources (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      file_name TEXT NOT NULL,
      format TEXT NOT NULL,
      file_uri TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      character_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS style_profiles (
      id TEXT PRIMARY KEY NOT NULL,
      series_id TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      source_id TEXT REFERENCES style_sources(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      version INTEGER NOT NULL,
      guide TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(series_id, version)
    );

    CREATE TABLE IF NOT EXISTS chapter_drafts (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      style_profile_id TEXT REFERENCES style_profiles(id) ON DELETE SET NULL,
      ai_draft TEXT NOT NULL,
      author_revision TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chapter_fts USING fts5(
      chapter_id UNINDEXED,
      project_id UNINDEXED,
      title,
      content,
      tokenize='unicode61'
    );

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key_ref TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY NOT NULL,
      provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      model_id TEXT NOT NULL,
      temperature REAL NOT NULL DEFAULT 0.8,
      max_tokens INTEGER NOT NULL DEFAULT 4096
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      image_path TEXT,
      is_favorited INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS world_info (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS world_info_entries (
      id TEXT PRIMARY KEY NOT NULL,
      world_info_id TEXT NOT NULL REFERENCES world_info(id) ON DELETE CASCADE,
      uid INTEGER NOT NULL,
      name TEXT NOT NULL,
      entry_order INTEGER NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      token_count INTEGER NOT NULL DEFAULT 0,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vector_chunks (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB NOT NULL,
      source_updated_at TEXT NOT NULL,
      UNIQUE(source_id, chunk_index)
    );

    CREATE INDEX IF NOT EXISTS idx_volumes_project_order
      ON volumes(project_id, order_index);
    CREATE INDEX IF NOT EXISTS idx_chapters_volume_order
      ON chapters(volume_id, order_index);
    CREATE INDEX IF NOT EXISTS idx_style_sources_updated
      ON style_sources(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_style_profiles_scope_updated
      ON style_profiles(kind, project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_style_profiles_source_version
      ON style_profiles(source_id, version DESC);
    CREATE INDEX IF NOT EXISTS idx_chapter_drafts_chapter_updated
      ON chapter_drafts(chapter_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_project_created
      ON chat_messages(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_characters_project_updated
      ON characters(project_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_world_entries_book_order
      ON world_info_entries(world_info_id, entry_order);
    CREATE INDEX IF NOT EXISTS idx_vector_chunks_project_source
      ON vector_chunks(project_id, source_type, source_id);
  `);
  await database.execAsync(`
    INSERT OR IGNORE INTO style_profiles(
      id, series_id, project_id, source_id, kind, name, version, guide, created_at, updated_at
    )
    SELECT
      'legacy-author-' || project.id,
      'author-' || project.id,
      project.id,
      NULL,
      'author',
      '我的作者文风',
      1,
      setting.value,
      project.updated_at,
      project.updated_at
    FROM projects project
    JOIN app_settings setting
      ON setting.key = 'plugin.lorn-style-evolution.guide.' || project.id
    WHERE TRIM(setting.value) <> '';

    INSERT OR IGNORE INTO app_settings(key, value)
    SELECT
      'style.activeProfile.' || project.id,
      'legacy-author-' || project.id
    FROM projects project
    JOIN style_profiles profile
      ON profile.id = 'legacy-author-' || project.id;

    DELETE FROM app_settings
    WHERE key LIKE 'plugin.lorn-style-evolution.guide.%';
  `);
  await migrateChatSessions(database);
}

export function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = SQLite.openDatabaseAsync("openfic.db", {
      // FTS owns internal statements that Expo's connection cleanup can otherwise finalize twice.
      finalizeUnusedStatementsBeforeClosing: false,
    }).then(async (database) => {
      await migrate(database);
      return database;
    });
  }
  return databasePromise;
}
