//! Local SQLite store: the offline change queue and the entity cache.
//!
//! Secrets (API keys, session tokens) never go in here — they belong to the OS secure store.

use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("Local storage error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("A queued change must be a JSON object with a non-empty string \"id\".")]
    MissingId,
    #[error("Invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
}

pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        Self::init(Connection::open(path)?)
    }

    pub fn in_memory() -> Result<Self, StoreError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self, StoreError> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS queue (
                 seq  INTEGER PRIMARY KEY AUTOINCREMENT,
                 id   TEXT NOT NULL UNIQUE,
                 body TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS cache (
                 key   TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );",
        )?;
        Ok(Self { conn })
    }

    /// Appends a change to the offline queue. The change's `id` is its idempotency key:
    /// queueing the same change twice keeps one copy, so a replay can never duplicate a write.
    /// Returns `true` when the change was new.
    pub fn queue_push(&self, change: &serde_json::Value) -> Result<bool, StoreError> {
        let id = change
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or(StoreError::MissingId)?;
        let n = self.conn.execute(
            "INSERT OR IGNORE INTO queue (id, body) VALUES (?1, ?2)",
            params![id, change.to_string()],
        )?;
        Ok(n == 1)
    }

    /// All queued changes, oldest first — the order they must be replayed in.
    pub fn queue_all(&self) -> Result<Vec<serde_json::Value>, StoreError> {
        let mut stmt = self.conn.prepare("SELECT body FROM queue ORDER BY seq")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for body in rows {
            out.push(serde_json::from_str(&body?)?);
        }
        Ok(out)
    }

    /// Drops changes the server has acknowledged.
    pub fn queue_remove(&mut self, ids: &[String]) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        for id in ids {
            tx.execute("DELETE FROM queue WHERE id = ?1", params![id])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn queue_len(&self) -> Result<u32, StoreError> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM queue", [], |r| r.get(0))?)
    }

    pub fn cache_put(&self, key: &str, value: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO cache (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn cache_get(&self, key: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn
            .query_row("SELECT value FROM cache WHERE key = ?1", params![key], |r| r.get(0))
            .optional()?)
    }

    pub fn cache_delete(&self, key: &str) -> Result<(), StoreError> {
        self.conn.execute("DELETE FROM cache WHERE key = ?1", params![key])?;
        Ok(())
    }

    /// Removes cached workspace data (used when the device is deactivated).
    /// Keys starting with `_` are device-level bookkeeping and are kept.
    pub fn cache_clear(&self) -> Result<(), StoreError> {
        self.conn.execute("DELETE FROM cache WHERE key NOT LIKE '\\_%' ESCAPE '\\'", [])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn change(id: &str, n: u32) -> serde_json::Value {
        json!({ "id": id, "entity": "post", "op": "upsert", "entityId": "p1", "data": { "n": n } })
    }

    #[test]
    fn replays_in_the_order_changes_were_made() {
        let s = Store::in_memory().unwrap();
        for (i, id) in ["c", "a", "b"].iter().enumerate() {
            assert!(s.queue_push(&change(id, i as u32)).unwrap());
        }
        let ids: Vec<_> = s.queue_all().unwrap().iter().map(|c| c["id"].as_str().unwrap().to_owned()).collect();
        assert_eq!(ids, ["c", "a", "b"]);
        assert_eq!(s.queue_len().unwrap(), 3);
    }

    #[test]
    fn the_same_change_is_only_queued_once() {
        let s = Store::in_memory().unwrap();
        assert!(s.queue_push(&change("k1", 1)).unwrap());
        assert!(!s.queue_push(&change("k1", 2)).unwrap());
        let all = s.queue_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0]["data"]["n"], 1, "the first copy wins");
    }

    #[test]
    fn rejects_a_change_without_an_idempotency_key() {
        let s = Store::in_memory().unwrap();
        assert!(matches!(s.queue_push(&json!({ "entity": "post" })), Err(StoreError::MissingId)));
        assert!(matches!(s.queue_push(&json!({ "id": "" })), Err(StoreError::MissingId)));
    }

    #[test]
    fn acknowledged_changes_leave_the_queue() {
        let mut s = Store::in_memory().unwrap();
        for id in ["a", "b", "c"] {
            s.queue_push(&change(id, 0)).unwrap();
        }
        s.queue_remove(&["a".into(), "c".into(), "missing".into()]).unwrap();
        assert_eq!(s.queue_len().unwrap(), 1);
        assert_eq!(s.queue_all().unwrap()[0]["id"], "b");
    }

    #[test]
    fn queue_and_cache_survive_a_restart() {
        let dir = std::env::temp_dir().join(format!("nexora-core-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("local.db");
        {
            let s = Store::open(&path).unwrap();
            s.queue_push(&change("a", 1)).unwrap();
            s.cache_put("workspace", "{\"v\":1}").unwrap();
        }
        let s = Store::open(&path).unwrap();
        assert_eq!(s.queue_len().unwrap(), 1);
        assert_eq!(s.cache_get("workspace").unwrap().as_deref(), Some("{\"v\":1}"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cache_overwrites_and_clear_keeps_device_bookkeeping() {
        let s = Store::in_memory().unwrap();
        s.cache_put("workspace", "1").unwrap();
        s.cache_put("workspace", "2").unwrap();
        s.cache_put("_device", "d").unwrap();
        assert_eq!(s.cache_get("workspace").unwrap().as_deref(), Some("2"));
        s.cache_clear().unwrap();
        assert_eq!(s.cache_get("workspace").unwrap(), None);
        assert_eq!(s.cache_get("_device").unwrap().as_deref(), Some("d"));
        assert_eq!(s.cache_get("nope").unwrap(), None);
    }
}
