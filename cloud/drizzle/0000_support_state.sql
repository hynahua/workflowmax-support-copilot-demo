CREATE TABLE support_state (namespace TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,kind,id));
--> statement-breakpoint
CREATE TABLE support_events (event_id TEXT PRIMARY KEY NOT NULL, namespace TEXT NOT NULL, kind TEXT NOT NULL, item_id TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL);
