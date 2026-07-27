import { createHash, randomUUID } from 'node:crypto'
import { marshQuests, marshQuestIds, marshScenes } from './marsh-content.mjs'
import { StoreError } from './store.mjs'

const parseList = (value) => {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

const stableNumber = (value) => createHash('sha256').update(value).digest().readUInt32BE(0)
const intentFor = (id, turn, style) => {
  const intents = style === 'ranged'
    ? ['attack', 'guard', 'hex', 'attack']
    : style === 'skirmisher'
      ? ['attack', 'heavy', 'guard', 'attack']
      : ['attack', 'heavy', 'attack', 'guard']
  return intents[stableNumber(`${id}:${turn}:marsh-story`) % intents.length]
}

function publicQuest(row, definition) {
  return {
    id: definition.id,
    title: definition.title,
    summary: definition.summary,
    status: row?.status ?? 'available',
    outcome: row?.outcome ?? null,
    startedAt: row ? Number(row.started_at) : null,
    completedAt: row?.completed_at ? Number(row.completed_at) : null,
  }
}

export class MarshStoryStore {
  constructor(gameStore, players, stories, regions) {
    this.gameStore = gameStore
    this.players = players
    this.stories = stories
    this.regions = regions
    this.db = gameStore.db
  }

  isUnlocked(userId) {
    this.regions.unlockRegions(userId)
    return Boolean(this.db.prepare(`
      SELECT 1 FROM player_region_progress WHERE user_id = ? AND region_id = 'salt-marsh'
    `).get(userId))
  }

  resetForGeneration(userId, generation) {
    const now = Date.now()
    this.db.prepare('DELETE FROM player_marsh_pending_encounters WHERE user_id = ?').run(userId)
    this.db.prepare('DELETE FROM player_marsh_story_quests WHERE user_id = ?').run(userId)
    this.db.prepare(`
      INSERT INTO player_marsh_story_state(
        user_id, generation, scene_id, flags_json, history_json, decision_count,
        started, chapter_complete, ending, updated_at
      ) VALUES (?, ?, 'marsh-threshold', '[]', ?, 0, 0, 0, NULL, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        generation = excluded.generation,
        scene_id = 'marsh-threshold',
        flags_json = '[]',
        history_json = excluded.history_json,
        decision_count = 0,
        started = 0,
        chapter_complete = 0,
        ending = NULL,
        updated_at = excluded.updated_at
    `).run(userId, generation, JSON.stringify(['Новый наследник ещё не оставил следа в Соляных топях.']), now)
  }

  ensureState(userId) {
    const character = this.db.prepare('SELECT generation FROM player_characters WHERE user_id = ?').get(userId)
    if (!character || !this.isUnlocked(userId)) return null
    const current = this.db.prepare('SELECT * FROM player_marsh_story_state WHERE user_id = ?').get(userId)
    if (!current || Number(current.generation) !== Number(character.generation)) {
      this.resetForGeneration(userId, Number(character.generation))
      return this.db.prepare('SELECT * FROM player_marsh_story_state WHERE user_id = ?').get(userId)
    }
    return current
  }

  questRows(userId) {
    return this.db.prepare('SELECT * FROM player_marsh_story_quests WHERE user_id = ?').all(userId)
  }

  inventoryIds(userId) {
    return new Set(this.db.prepare(`
      SELECT item_id FROM player_inventory WHERE user_id = ? AND quantity > 0
    `).all(userId).map((row) => row.item_id))
  }

  reconcileEncounter(userId) {
    const pending = this.db.prepare(`
      SELECT pending.*, expedition.status
      FROM player_marsh_pending_encounters pending
      JOIN player_expeditions expedition ON expedition.id = pending.expedition_id
      WHERE pending.user_id = ?
    `).get(userId)
    if (!pending || pending.status === 'active') return
    const state = this.ensureState(userId)
    if (!state) return
    const history = parseList(state.history_json)
    let sceneId = state.scene_id
    if (pending.status === 'won') {
      sceneId = pending.victory_scene_id
      history.unshift('Столкновение в топях завершилось победой, но решение о долге ещё впереди.')
      this.db.prepare(`
        UPDATE player_marsh_story_quests SET contract_counted = 1
        WHERE user_id = ? AND quest_id = ? AND status = 'active'
      `).run(userId, pending.quest_id)
    } else if (pending.status === 'fled') {
      sceneId = pending.flee_scene_id
      history.unshift('Ты покинул бой и вернулся к сухому огню. Контракт остался незавершённым.')
    } else if (pending.status === 'dead') {
      history.unshift('Вторая глава оборвалась в белой воде вместе с жизнью героя.')
    }
    this.db.prepare(`
      UPDATE player_marsh_story_state SET scene_id = ?, history_json = ?, updated_at = ?
      WHERE user_id = ?
    `).run(sceneId, JSON.stringify(history.slice(0, 30)), Date.now(), userId)
    this.db.prepare('DELETE FROM player_marsh_pending_encounters WHERE user_id = ?').run(userId)
  }

  requirement(choice, character, flags, questRows, inventoryIds) {
    const requirement = choice.requires ?? {}
    if (requirement.profession && character.profession !== requirement.profession) return `Требуется ремесло: ${requirement.profession}`
    if (requirement.item && !inventoryIds.has(requirement.item)) return 'Требуется особый предмет'
    if (requirement.flag && !flags.has(requirement.flag)) return 'Не хватает найденного доказательства'
    if (requirement.minCoins && Number(character.coins) < requirement.minCoins) return `Нужно монет: ${requirement.minCoins}`
    if (requirement.allQuests) {
      const completed = questRows.filter((quest) => quest.status === 'completed').length
      if (completed < marshQuests.length) return 'Сначала заверши все три расследования топей'
    }
    if (requirement.questAvailable) {
      const target = questRows.find((quest) => quest.quest_id === requirement.questAvailable)
      if (target?.status === 'completed') return 'Расследование уже завершено'
      const another = questRows.some((quest) => quest.status === 'active' && quest.quest_id !== requirement.questAvailable)
      if (another) return 'Сначала заверши текущее расследование'
    }
    if (choice.effects?.coins && Number(character.coins) + Number(choice.effects.coins) < 0) return 'Недостаточно монет'
    if (choice.effects?.stamina && Number(character.stamina) + Number(choice.effects.stamina) < 0) return 'Недостаточно сил'
    return null
  }

  publicStory(userId) {
    const character = this.players.getCharacter(userId)
    if (!character) return { available: false, unlocked: false, started: false, chapterComplete: false }
    const unlocked = this.isUnlocked(userId)
    if (!unlocked) return { available: false, unlocked: false, started: false, chapterComplete: false }
    this.reconcileEncounter(userId)
    const state = this.ensureState(userId)
    const rawCharacter = this.db.prepare('SELECT * FROM player_characters WHERE user_id = ?').get(userId)
    const scene = marshScenes[state.scene_id] ?? marshScenes['marsh-threshold']
    const flags = new Set(parseList(state.flags_json))
    const questRows = this.questRows(userId)
    const inventoryIds = this.inventoryIds(userId)
    const pending = this.db.prepare('SELECT expedition_id FROM player_marsh_pending_encounters WHERE user_id = ?').get(userId)
    const activeRun = this.players.getActiveRun(userId)
    return {
      available: true,
      unlocked: true,
      generation: Number(state.generation),
      started: Boolean(state.started),
      chapterComplete: Boolean(state.chapter_complete),
      ending: state.ending ?? null,
      decisionCount: Number(state.decision_count),
      pendingEncounter: Boolean(pending),
      scene: {
        id: scene.id,
        region: scene.region,
        title: scene.title,
        text: scene.text,
        choices: scene.choices.map((choice) => {
          const reason = this.requirement(choice, rawCharacter, flags, questRows, inventoryIds)
          return { id: choice.id, label: choice.label, available: !reason && !pending && !activeRun, requirement: reason }
        }),
      },
      quests: marshQuests.map((definition) => publicQuest(questRows.find((row) => row.quest_id === definition.id), definition)),
      history: parseList(state.history_json),
      flags: [...flags],
    }
  }

  removeInventory(userId, itemId) {
    const row = this.db.prepare('SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId)
    if (!row || Number(row.quantity) < 1) throw new StoreError('item-required', 'Нужный предмет отсутствует.', 409)
    if (Number(row.quantity) === 1) this.db.prepare('DELETE FROM player_inventory WHERE user_id = ? AND item_id = ?').run(userId, itemId)
    else this.db.prepare('UPDATE player_inventory SET quantity = quantity - 1 WHERE user_id = ? AND item_id = ?').run(userId, itemId)
  }

  addInjury(userId, injury) {
    const now = Date.now()
    const interval = injury.kind === 'salt-burn' ? 8 * 60 * 60 * 1000
      : injury.kind === 'marsh-fever' ? 18 * 60 * 60 * 1000
        : 24 * 60 * 60 * 1000
    const existing = this.db.prepare(`
      SELECT id, severity FROM player_injuries WHERE user_id = ? AND kind = ? AND status = 'active'
    `).get(userId, injury.kind)
    if (existing) {
      this.db.prepare(`
        UPDATE player_injuries SET severity = MIN(3, MAX(severity, ?)), source = ?,
          natural_heal_at = ?, recovery_interval = ? WHERE id = ?
      `).run(injury.severity, injury.source, now + interval, interval, existing.id)
      return
    }
    this.db.prepare(`
      INSERT INTO player_injuries(
        id, user_id, kind, title, severity, status, source, created_at,
        natural_heal_at, recovery_interval, recovery_note
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), userId, injury.kind, injury.title, injury.severity, injury.source,
      now, now + interval, interval, 'Покой и безопасный ночлег постепенно уменьшают тяжесть травмы.',
    )
  }

  completeQuest(userId, completion) {
    if (!marshQuestIds.has(completion.id)) throw new StoreError('quest-not-found', 'Неизвестное расследование топей.', 404)
    const quest = this.db.prepare(`
      SELECT * FROM player_marsh_story_quests WHERE user_id = ? AND quest_id = ?
    `).get(userId, completion.id)
    if (!quest || quest.status !== 'active') throw new StoreError('quest-not-active', 'Это расследование сейчас не активно.', 409)
    const now = Date.now()
    this.db.prepare(`
      UPDATE player_marsh_story_quests SET status = 'completed', outcome = ?, completed_at = ?
      WHERE user_id = ? AND quest_id = ?
    `).run(String(completion.outcome ?? 'unknown').slice(0, 48), now, userId, completion.id)
    if (!Number(quest.contract_counted)) {
      this.db.prepare(`
        UPDATE player_characters SET completed_contracts = completed_contracts + 1, updated_at = ?
        WHERE user_id = ?
      `).run(now, userId)
      const role = this.gameStore.getRoleForUser(userId)
      if (role) this.gameStore.progressTaskByGuild(role.guild_id, 'contracts', 1)
    }
  }

  startEncounter(userId, encounter, flags) {
    if (this.players.getActiveRun(userId)) throw new StoreError('expedition-active', 'Сначала заверши текущее столкновение.', 409)
    const character = this.db.prepare('SELECT * FROM player_characters WHERE user_id = ?').get(userId)
    if (!character?.alive) throw new StoreError('character-dead', 'Погибший герой не может сражаться.', 409)
    if (Number(character.stamina) < 2) throw new StoreError('not-enough-stamina', 'Для сюжетного столкновения нужно 2 силы.', 409)

    const expeditionId = randomUUID()
    const offerId = randomUUID()
    const now = Date.now()
    const advantage = flags.has('bell-silenced') || flags.has('chapel-flank') || flags.has('marked-path') || flags.has('hunter-respect')
    const enemyHealth = Math.max(6, Number(encounter.enemyHealth) - (advantage ? 3 : 0))
    const snapshot = {
      objectiveId: 'story',
      objectiveName: 'Сюжетное столкновение',
      terrainName: encounter.terrainName,
      complicationId: advantage ? 'prepared-route' : 'story-danger',
      complicationName: advantage ? 'подготовленный подход' : 'неизвестная угроза',
      movementCost: encounter.movementCost,
      enemyStyle: encounter.enemyStyle,
      storyEncounter: true,
    }

    this.db.prepare('UPDATE player_characters SET stamina = stamina - 2, updated_at = ? WHERE user_id = ?').run(now, userId)
    this.db.prepare(`
      INSERT INTO player_contract_offers(
        id, user_id, rotation_key, slot, region_id, title, description,
        enemy_id, enemy_name, enemy_style, enemy_health, difficulty,
        reward_coins, reward_experience, trophy_id, trophy_name, trophy_quantity,
        terrain_id, initial_distance, max_distance, movement_cost, snapshot_json,
        status, created_at, expires_at, accepted_at
      ) VALUES (?, ?, ?, 0, 'salt-marsh', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?)
    `).run(
      offerId, userId, `story:${character.generation}:${encounter.questId}:${offerId}`,
      `Сюжет: ${encounter.enemyName}`, 'Столкновение второй главы Соляных топей.',
      encounter.enemyId, encounter.enemyName, encounter.enemyStyle, enemyHealth, encounter.difficulty,
      6 + encounter.difficulty * 3, 18 + encounter.difficulty * 10,
      encounter.trophyId, encounter.trophyName, encounter.terrainId,
      encounter.initialDistance, encounter.maxDistance, encounter.movementCost,
      JSON.stringify(snapshot), now, now + 7 * 24 * 60 * 60 * 1000, now,
    )
    this.db.prepare(`
      INSERT INTO player_expeditions(
        id, user_id, contract_id, status, turn, enemy_id, enemy_name,
        enemy_health, enemy_max_health, enemy_intent, last_log_json, started_at, updated_at,
        region_id, offer_id, distance, max_distance, terrain_id, enemy_style, contract_snapshot_json
      ) VALUES (?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?, ?, ?, 'salt-marsh', ?, ?, ?, ?, ?, ?)
    `).run(
      expeditionId, userId, offerId, encounter.enemyId, encounter.enemyName,
      enemyHealth, enemyHealth, advantage ? 'guard' : intentFor(expeditionId, 1, encounter.enemyStyle),
      JSON.stringify([
        advantage ? 'Подготовка дала тебе выгодную позицию.' : 'Топи не оставили времени на подготовку.',
        `Местность: ${encounter.terrainName}.`,
      ]), now, now, offerId, encounter.initialDistance, encounter.maxDistance,
      encounter.terrainId, encounter.enemyStyle, JSON.stringify(snapshot),
    )
    this.db.prepare(`
      INSERT INTO player_marsh_pending_encounters(
        user_id, expedition_id, quest_id, victory_scene_id, flee_scene_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, expeditionId, encounter.questId, encounter.victorySceneId, encounter.fleeSceneId, now)
  }

  choose(userId, input) {
    const choiceId = String(input.choiceId ?? '')
    return this.players.withReceipt(userId, input.requestId, `marsh-story:${choiceId}`, () => {
      if (!this.isUnlocked(userId)) throw new StoreError('marsh-locked', 'Соляные топи ещё не открыты этому роду.', 409)
      this.reconcileEncounter(userId)
      const state = this.ensureState(userId)
      const character = this.db.prepare('SELECT * FROM player_characters WHERE user_id = ?').get(userId)
      if (!character?.alive) throw new StoreError('character-dead', 'Продолжить вторую главу сможет наследник.', 409)
      if (this.players.getActiveRun(userId)) throw new StoreError('expedition-active', 'Сначала заверши текущее столкновение.', 409)
      const scene = marshScenes[state.scene_id]
      const choice = scene?.choices.find((item) => item.id === choiceId)
      if (!choice) throw new StoreError('choice-not-found', 'Такого решения в текущей сцене нет.', 404)

      const flags = new Set(parseList(state.flags_json))
      const questRows = this.questRows(userId)
      const inventoryIds = this.inventoryIds(userId)
      const reason = this.requirement(choice, character, flags, questRows, inventoryIds)
      if (reason) throw new StoreError('choice-unavailable', reason, 409)

      if (choice.startQuest) {
        if (!marshQuestIds.has(choice.startQuest)) throw new StoreError('quest-not-found', 'Неизвестное расследование.', 404)
        this.db.prepare(`
          INSERT OR IGNORE INTO player_marsh_story_quests(user_id, quest_id, status, started_at)
          VALUES (?, ?, 'active', ?)
        `).run(userId, choice.startQuest, Date.now())
      }

      this.stories.applyEffects(userId, choice.effects)
      if (choice.addItem) this.players.addInventory(userId, choice.addItem.id, choice.addItem.name, 1)
      if (choice.removeItem) this.removeInventory(userId, choice.removeItem)
      if (choice.injury) this.addInjury(userId, choice.injury)
      if (choice.addFlag) flags.add(choice.addFlag)
      if (choice.completeQuest) this.completeQuest(userId, choice.completeQuest)
      if (choice.encounter) this.startEncounter(userId, choice.encounter, flags)

      const history = parseList(state.history_json)
      history.unshift(choice.consequence)
      const started = choice.startChapter ? 1 : Number(state.started)
      const chapterComplete = choice.chapterComplete ? 1 : Number(state.chapter_complete)
      this.db.prepare(`
        UPDATE player_marsh_story_state SET scene_id = ?, flags_json = ?, history_json = ?,
          decision_count = decision_count + 1, started = ?, chapter_complete = ?, ending = ?, updated_at = ?
        WHERE user_id = ?
      `).run(
        choice.encounter ? state.scene_id : choice.nextSceneId,
        JSON.stringify([...flags]), JSON.stringify(history.slice(0, 30)), started,
        chapterComplete, choice.ending ?? state.ending ?? null, Date.now(), userId,
      )
      return { character: this.players.getCharacter(userId), marshStory: this.publicStory(userId) }
    })
  }
}
