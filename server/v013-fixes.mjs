export function installV013CombatFixes(combat) {
  // actSquad already owns the mutable enemy rows for the transaction. Returning
  // database rows here would replace freshly changed health with stale values.
  combat.activeEnemyRows = () => []

  const originalPhaseChange = combat.maybeChangeBossPhase.bind(combat)
  combat.maybeChangeBossPhase = (run, enemies, log) => {
    if (run.encounter_type === 'boss' && Number(run.boss_phase) < 2) {
      const boss = enemies.find((enemy) => enemy.enemy_role === 'boss')
      if (boss && Number(boss.health) <= 0) {
        boss.health = 1
        boss.status = 'active'
        log.push('Белый панцирь Глухобора не даёт завершить бой одним ударом.')
      }
    }
    return originalPhaseChange(run, enemies, log)
  }
}
