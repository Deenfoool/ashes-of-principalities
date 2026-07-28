const quotedIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`

function executableSql(sql) {
  return String(sql ?? '')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

export function findBrokenLegacyEncounterTriggers(db) {
  return db.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'trigger'
      AND tbl_name = 'player_expeditions'
      AND sql IS NOT NULL
    ORDER BY name
  `).all().filter((row) => /\bpositional\b/i.test(executableSql(row.sql)))
}

export function installLegacyStoryFixes(db, logger = console) {
  const broken = findBrokenLegacyEncounterTriggers(db)
  for (const trigger of broken) {
    db.exec(`DROP TRIGGER IF EXISTS ${quotedIdentifier(trigger.name)}`)
  }
  if (broken.length > 0) {
    logger.warn?.(`Removed incompatible expedition trigger(s): ${broken.map((trigger) => trigger.name).join(', ')}`)
  }
  return broken.map((trigger) => trigger.name)
}
