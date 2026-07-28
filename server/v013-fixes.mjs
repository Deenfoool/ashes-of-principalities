import { StoreError } from './store.mjs'

export function installV013CombatFixes(combat) {
  // actSquad already owns mutable enemy rows for the transaction. Reading the
  // same rows again before persistence would replace fresh damage with stale DB values.
  combat.activeEnemyRows = () => []

  const originalDecorateRun = combat.decorateRun.bind(combat)
  combat.decorateRun = (base, row) => {
    const decorated = originalDecorateRun(base, row)
    if (!decorated || !Array.isArray(decorated.enemies)) return decorated
    const zoneControl = decorated.enemies
      .filter((enemy) => !enemy.defeated && Number(enemy.distance) === 0)
      .reduce((sum, enemy) => sum + Number(enemy.zonePower ?? 0), 0)
    return { ...decorated, zoneControl }
  }

  const originalActSquad = combat.actSquad.bind(combat)
  combat.actSquad = (userId, input, tacticMode = false) => {
    const requestId = String(input.requestId ?? '').trim()
    const targetId = String(input.targetId ?? '').slice(0, 96)
    const action = String(input.action ?? '')
    const expectedAction = tacticMode
      ? `expedition:tactic:${action}`
      : `expedition:${action}:${targetId || 'auto'}`
    const existing = requestId
      ? combat.db.prepare(`
          SELECT action, result_json FROM player_action_receipts
          WHERE user_id = ? AND request_id = ?
        `).get(userId, requestId)
      : null
    if (existing) {
      if (existing.action !== expectedAction) {
        throw new StoreError('request-id-conflict', 'Этот идентификатор уже использован для другого действия.', 409)
      }
      return JSON.parse(existing.result_json)
    }

    if (!tacticMode && action === 'profession') {
      const mainHand = combat.db.prepare(`
        SELECT durability FROM unique_items
        WHERE owner_user_id = ? AND equipment_slot = 'main-hand' AND equipped = 1
        LIMIT 1
      `).get(userId)
      if (mainHand && Number(mainHand.durability) <= 0) {
        throw new StoreError('tool-broken', 'Оружие или ремесленный инструмент сломан. Сначала отремонтируй его.', 409)
      }
    }
    return originalActSquad(userId, input, tacticMode)
  }

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
