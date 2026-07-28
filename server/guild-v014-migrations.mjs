import { applyMigration } from './migrations.mjs'

export function installGuildV014Migrations(db) {
  return applyMigration(db, '017_guild_resources_leadership_and_raids', () => {
    db.exec(`
      ALTER TABLE guild_members ADD COLUMN last_active_at INTEGER NOT NULL DEFAULT 0;
      UPDATE guild_members SET last_active_at = CASE WHEN joined_at > 0 THEN joined_at ELSE unixepoch('subsec') * 1000 END
      WHERE last_active_at = 0;

      CREATE TABLE guild_resource_stock (
        guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        item_name TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
        reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0 AND reserved <= quantity),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(guild_id, item_id)
      ) STRICT;

      CREATE TABLE guild_resource_log (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        operation TEXT NOT NULL CHECK(operation IN ('deposit', 'withdraw', 'reserve', 'consume', 'reward')),
        item_id TEXT NOT NULL,
        item_name TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK(quantity > 0),
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE guild_leadership_log (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        previous_leader_id TEXT NOT NULL REFERENCES users(id),
        next_leader_id TEXT NOT NULL REFERENCES users(id),
        reason TEXT NOT NULL CHECK(reason IN ('voluntary', 'inactivity')),
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE guild_raid_projects (
        guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        boss_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'preparing'
          CHECK(status IN ('preparing', 'ready', 'active', 'won', 'failed', 'cooldown')),
        health INTEGER NOT NULL DEFAULT 120 CHECK(health >= 0),
        max_health INTEGER NOT NULL DEFAULT 120 CHECK(max_health > 0),
        shield INTEGER NOT NULL DEFAULT 40 CHECK(shield >= 0),
        max_shield INTEGER NOT NULL DEFAULT 40 CHECK(max_shield >= 0),
        morale INTEGER NOT NULL DEFAULT 140 CHECK(morale >= 0),
        max_morale INTEGER NOT NULL DEFAULT 140 CHECK(max_morale > 0),
        round INTEGER NOT NULL DEFAULT 1 CHECK(round > 0),
        intent TEXT NOT NULL DEFAULT 'crush',
        requirements_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        victories INTEGER NOT NULL DEFAULT 0 CHECK(victories >= 0),
        prepared_by TEXT REFERENCES users(id),
        started_by TEXT REFERENCES users(id),
        prepared_at INTEGER,
        started_at INTEGER,
        ended_at INTEGER,
        cooldown_until INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(guild_id, boss_id)
      ) STRICT;

      CREATE TABLE guild_raid_participants (
        guild_id TEXT NOT NULL,
        boss_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at INTEGER NOT NULL,
        actions INTEGER NOT NULL DEFAULT 0 CHECK(actions >= 0),
        damage INTEGER NOT NULL DEFAULT 0 CHECK(damage >= 0),
        support INTEGER NOT NULL DEFAULT 0 CHECK(support >= 0),
        reward_claimed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(guild_id, boss_id, user_id),
        FOREIGN KEY(guild_id, boss_id) REFERENCES guild_raid_projects(guild_id, boss_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE guild_raid_log (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        boss_id TEXT NOT NULL,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        round INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(guild_id, boss_id) REFERENCES guild_raid_projects(guild_id, boss_id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX idx_guild_resource_log_time ON guild_resource_log(guild_id, created_at DESC);
      CREATE INDEX idx_guild_members_activity ON guild_members(guild_id, last_active_at DESC);
      CREATE INDEX idx_guild_leadership_time ON guild_leadership_log(guild_id, created_at DESC);
      CREATE INDEX idx_guild_raid_log_time ON guild_raid_log(guild_id, boss_id, created_at DESC);
    `)
  })
}
