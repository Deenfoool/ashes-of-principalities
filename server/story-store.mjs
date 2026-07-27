import { createHash, randomUUID } from 'node:crypto'
import { StoreError } from './store.mjs'
import { expeditionContracts } from './player-store.mjs'
import { storyQuests, storyQuestIds, storyScenes } from './story-content.mjs'

const contractById = Object.fromEntries(expeditionContracts.map((contract) => [contract.id, contract]))

const parseList = (value) => {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

const stableNumber = (value) => createHash('sha256').update(value).digest().readUInt32BE(0)
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value))

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

export class StoryStore {
  constructor(gameStore, playerStore) {
    this.gameStore = gameStore
    this.playerStore = playerStore
    this.db = gameStore.db
    this.createSchema()
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS player_story_state (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        scene_id TEXT NOT NULL,
        flags_json TEXT NOT NULL DEFAULT '[]',
        history_json TEXT NOT NULL DEFAULT '[]',
        decision_count INTEGER NOT NULL DEFAULT 0,
        chapter_complete INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS player_story_quests (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        quest_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'completed')),
        outcome TEXT,
        contract_counted INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        PRIMARY KEY(user_id, quest_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS player_story_pending_encounters (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        expedition_id TEXT NOT NULL UNIQUE REFERENCES player_expeditions(id) ON DELETE CASCADE,
        quest_id TEXT NOT NULL,
        victory_scene_id TEXT NOT NULL,
        flee_scene_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
    `)
  }

  resetForGeneration(userId, generation) {
    const now = Date.now()
    this.db.prepare('DELETE FROM player_story_pending_encounters WHERE user_id = ?').run(userId)
    this.db.prepare('DELETE FROM player_story_quests WHERE user_id = ?').run(userId)
    this.db.prepare(`
      INSERT INTO player_story_state(
        user_id, generation, scene_id, flags_json, history_json,
        decision_count, chapter_complete, updated_at
      ) VALUES (?, ?, 'crossroads', '[]', ?, 0, 0, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        generation = excluded.generation,
        scene_id = 'crossroads',
        flags_json = '[]',
        history_json = excluded.history_json,
        decision_count = 0,
        chapter_complete = 0,
        updated_at = excluded.updated_at
    `).run(userId, generation, JSON.stringify(['Новая дорога начинается у северной развилки.']), now)

    const ration = this.db.prepare(`
      SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = 'dry-ration'
    `).get(userId)
    if (!ration) this.playerStore.addInventory(userId, 'dry-ration', 'Сухой паёк', 1)
  }

  ensureState(userId) {
    const character = this.db.prepare('SELECT generation FROM player_characters WHERE user_id = ?').get(userId)
    if (!character) return null
    const state = this.db.prepare('SELECT * FROM player_story_state WHERE user_id = ?').get(userId)
    if (!state || Number(state.generation) !== Number(character.generation)) {
      this.resetForGeneration(userId, Number(character.generation))
      return this.db.prepare('SELECT * FROM player_story_state WHERE user_id = ?').get(userId)
    }
    return state
  }

  getQuestRows(userId) {
    return this.db.prepare('SELECT * FROM player_story_quests WHERE user_id = ?').all(userId)
  }

  getInventoryIds(userId) {
    return new Set(this.db.prepare('SELECT item_id FROM player_inventory WHERE user_id = ? AND quantity > 0').all(userId).map((row) => row.item_id))
  }

  reconcileEncounter(userId) {
    const pending = this.db.prepare(`
      SELECT p.*, e.status FROM player_story_pending_encounters p
      JOIN player_expeditions e ON e.id = p.expedition_id
      WHERE p.user_id = ?
    `).get(userId)
    if (!pending || pending.status === 'active') return

    const state = this.ensureState(userId)
    if (!state) return
    const history = parseList(state.history_json)
    let sceneId = state.scene_id
    if (pending.status === 'won') {
      sceneId = pending.victory_scene_id
      history.unshift('Столкновение завершилось победой. Теперь придётся решить, что делать с правдой.')
      this.db.prepare(`
        UPDATE player_story_quests SET contract_counted = 1
        WHERE user_id = ? AND quest_id = ? AND status = 'active'
      `).run(userId, pending.quest_id)
    } else if (pending.status === 'fled') {
      sceneId = pending.flee_scene_id
      history.unshift('Ты вернулся живым, но контракт остался незавершённым.')
    } else if (pending.status === 'dead') {
      history.unshift('Эта глава оборвалась вместе с жизнью героя.')
    }
    this.db.prepare(`
      UPDATE player_story_state SET scene_id = ?, history_json = ?, updated_at = ? WHERE user_id = ?
    `).run(sceneId, JSON.stringify(history.slice(0, 24)), Date.now(), userId)
    this.db.prepare('DELETE FROM player_story_pending_encounters WHERE user_id = ?').run(userId)
  }

  requirementForChoice(userId, choice, character, flags, questRows, inventoryIds) {
    const requirement = choice.requires ?? {}
    if (requirement.profession && character.profession !== requirement.profession) return `Требуется ремесло: ${requirement.profession}`
    if (requirement.item && !inventoryIds.has(requirement.item)) return 'Требуется особый предмет'
    if (requirement.flag && !flags.has(requirement.flag)) return 'Не хватает найденного доказательства'
    if (requirement.minCoins && Number(character.coins) < requirement.minCoins) return `Нужно монет: ${requirement.minCoins}`
    if (requirement.minStamina && Number(character.stamina) < requirement.minStamina) return `Нужно сил: ${requirement.minStamina}`
    if (requirement.allQuests) {
      const completed = questRows.filter((quest) => quest.status === 'completed').length
      if (completed < storyQuests.length) return 'Сначала заверши все три контракта'
    }
    if (requirement.questAvailable) {
      const target = questRows.find((quest) => quest.quest_id === requirement.questAvailable)
      if (target?.status === 'completed') return 'Контракт уже завершён'
      const anotherActive = questRows.some((quest) => quest.status === 'active' && quest.quest_id !== requirement.questAvailable)
      if (anotherActive) return 'Сначала заверши текущий контракт'
    }
    if (choice.effects?.stamina && Number(character.stamina) + Number(choice.effects.stamina) < 0) return 'Недостаточно сил'
    if (choice.effects?.coins && Number(character.coins) + Number(choice.effects.coins) < 0) return 'Недостаточно монет'
    return null
  }

  publicStory(userId) {
    this.reconcileEncounter(userId)
    const state = this.ensureState(userId)
    if (!state) return null
    const character = this.db.prepare('SELECT * FROM player_characters WHERE user_id = ?').get(userId)
    const scene = storyScenes[state.scene_id] ?? storyScenes.crossroads
    const flags = new Set(parseList(state.flags_json))
    const questRows = this.getQuestRows(userId)
    const inventoryIds = this.getInventoryIds(userId)
    const pending = this.db.prepare('SELECT expedition_id FROM player_story_pending_encounters WHERE user_id = ?').get(userId)
    return {
      generation: Number(state.generation),
      scene: {
        id: scene.id,
        region: scene.region,
        title: scene.title,
        text: scene.text,
        choices: scene.choices.map((choice) => {
          const requirement = this.requirementForChoice(userId, choice, character, flags, questRows, inventoryIds)
          return { id: choice.id, label: choice.label, available: !requirement && !pending, requirement }
        }),
      },
      quests: storyQuests.map((definition) => publicQuest(questRows.find((row) => row.quest_id === definition.id), definition)),
      history: parseList(state.history_json),
      flags: [...flags],
      decisionCount: Number(state.decision_count),
      chapterComplete: Boolean(state.chapter_complete),
      pendingEncounter: Boolean(pending),
    }
  }

  applyEffects(userId, effects = {}) {
    const row = this.db.prepare('SELECT * FROM player_characters WHERE user_id = ?').get(userId)
    if (!row) throw new StoreError('character-required', 'Сначала создай серверного героя.', 404)
    let maxHealth = Number(row.max_health)
    let maxStamina = Number(row.max_stamina)
    let health = Number(row.health)
    let stamina = Number(row.stamina)
    let insight = Number(row.insight)
    let reputation = Number(row.reputation)
    let coins = Number(row.coins)
    let level = Number(row.level)
    let experience = Number(row.experience)

    if (effects.fullRest) {
      health = maxHealth
      stamina = maxStamina
    }
    health = clamp(health + Number(effects.health ?? 0), 0, maxHealth)
    stamina = clamp(stamina + Number(effects.stamina ?? 0), 0, maxStamina)
    insight = clamp(insight + Number(effects.insight ?? 0), 0, 20)
    reputation = clamp(reputation + Number(effects.reputation ?? 0), -20, 100)
    coins += Number(effects.coins ?? 0)
    if (coins < 0) throw new StoreError('not-enough-coins', 'У героя недостаточно монет.', 409)

    const gainedExperience = Math.max(0, Math.floor(Number(effects.experience ?? 0)))
    if (gainedExperience > 0) {
      const progression = this.playerStore.grantExperience(row, gainedExperience)
      level = progression.level
      experience = progression.experience
      maxHealth = progression.maxHealth
      maxStamina = progression.maxStamina
      health = Math.min(maxHealth, health)
      stamina = Math.min(maxStamina, stamina)
    }

    const now = Date.now()
    if (health <= 0) {
      const glory = level + Math.floor(Math.max(0, reputation) / 5)
      this.db.prepare(`
        UPDATE player_characters SET level = ?, experience = ?, max_health = ?, health = 0,
          max_stamina = ?, stamina = ?, insight = ?, reputation = ?, coins = ?, alive = 0,
          deaths = deaths + 1, legacy_glory = legacy_glory + ?, updated_at = ? WHERE user_id = ?
      `).run(level, experience, maxHealth, maxStamina, stamina, insight, reputation, coins, glory, now, userId)
      return
    }

    this.db.prepare(`
      UPDATE player_characters SET level = ?, experience = ?, max_health = ?, health = ?,
        max_stamina = ?, stamina = ?, insight = ?, reputation = ?, coins = ?, updated_at = ?
      WHERE user_id = ?
    `).run(level, experience, maxHealth, health, maxStamina, stamina, insight, reputation, coins, now, userId)
  }

  removeInventory(userId, itemId) {
    const row = this.db.prepare('SELECT quantity FROM player_inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId)
    if (!row || Number(row.quantity) < 1) throw new StoreError('item-required', 'Нужный предмет отсутствует.', 409)
    if (Number(row.quantity) === 1) this.db.prepare('DELETE FROM player_inventory WHERE user_id = ? AND item_id = ?').run(userId, itemId)
    else this.db.prepare('UPDATE player_inventory SET quantity = quantity - 1 WHERE user_id = ? AND item_id = ?').run(userId, itemId)
  }

  completeQuest(userId, completion) {
    if (!storyQuestIds.has(completion.id)) throw new StoreError('quest-not-found', 'Неизвестный сюжетный контракт.', 404)
    const quest = this.db.prepare('SELECT * FROM player_story_quests WHERE user_id = ? AND quest_id = ?').get(userId, completion.id)
    if (!quest || quest.status !== 'active') throw new StoreError('quest-not-active', 'Этот контракт сейчас не активен.', 409)
    const now = Date.now()
    this.db.prepare(`
      UPDATE player_story_quests SET status = 'completed', outcome = ?, completed_at = ?
      WHERE user_id = ? AND quest_id = ?
    `).run(String(completion.outcome ?? 'unknown').slice(0, 40), now, userId, completion.id)

    if (!Number(quest.contract_counted)) {
      this.db.prepare('UPDATE player_characters SET completed_contracts = completed_contracts + 1, updated_at = ? WHERE user_id = ?').run(now, userId)
      const role = this.gameStore.getRoleForUser(userId)
      if (role) this.gameStore.progressTaskByGuild(role.guild_id, 'contracts', 1)
    }
  }

  startEncounter(userId, encounter, flags) {
    if (this.playerStore.getActiveRun(userId)) throw new StoreError('expedition-active', 'Сначала заверши текущее столкновение.', 409)
    const character = this.db.prepare('SELECT * FROM player_characters WHERE user_id = ?').get(userId)
    if (!character?.alive) throw new StoreError('character-dead', 'Погибший герой не может сражаться.', 409)
    const contract = contractById[encounter.contractId]
    if (!contract) throw new StoreError('encounter-not-found', 'Сюжетное столкновение не найдено.', 500)

    const advantage = flags.has('well-weakened') || flags.has('beast-advantage') || flags.has('taxman-ambush')
    const enemyHealth = Math.max(5, Number(contract.enemyHealth) - (advantage ? 3 : 0))
    const id = randomUUID()
    const now = Date.now()
    const intent = advantage ? 'guard' : ['attack', 'heavy'][stableNumber(`${id}:story`) % 2]
    this.db.prepare(`
      INSERT INTO player_expeditions(
        id, user_id, contract_id, status, turn, enemy_id, enemy_name,
        enemy_health, enemy_max_health, enemy_intent, last_log_json, started_at, updated_at
      ) VALUES (?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, userId, contract.id, contract.enemyId, contract.enemyName,
      enemyHealth, enemyHealth, intent,
      JSON.stringify([advantage ? 'Подготовка дала тебе преимущество в начале боя.' : 'Слова закончились. Начинается бой.']),
      now, now,
    )
    this.db.prepare(`
      INSERT INTO player_story_pending_encounters(
        user_id, expedition_id, quest_id, victory_scene_id, flee_scene_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, id, encounter.questId, encounter.victorySceneId, encounter.fleeSceneId, now)
  }

  choose(userId, input) {
    const choiceId = String(input.choiceId ?? '')
    return this.playerStore.withReceipt(userId, input.requestId, `story:${choiceId}`, () => {
      this.reconcileEncounter(userId)
      const state = this.ensureState(userId)
      if (!state) throw new StoreError('character-required', 'Сначала создай серверного героя.', 404)
      const character = this.db.prepare('SELECT * FROM player_characters WHERE user_id = ?').get(userId)
      if (!character.alive) throw new StoreError('character-dead', 'Этот герой погиб. Продолжить историю сможет наследник.', 409)
      if (this.playerStore.getActiveRun(userId)) throw new StoreError('expedition-active', 'Сначала заверши текущее столкновение.', 409)
      const scene = storyScenes[state.scene_id]
      const choice = scene?.choices.find((item) => item.id === choiceId)
      if (!choice) throw new StoreError('choice-not-found', 'Такого решения в текущей сцене нет.', 404)

      const flags = new Set(parseList(state.flags_json))
      const questRows = this.getQuestRows(userId)
      const inventoryIds = this.getInventoryIds(userId)
      const requirement = this.requirementForChoice(userId, choice, character, flags, questRows, inventoryIds)
      if (requirement) throw new StoreError('choice-unavailable', requirement, 409)

      if (choice.startQuest) {
        if (!storyQuestIds.has(choice.startQuest)) throw new StoreError('quest-not-found', 'Неизвестный контракт.', 404)
        const existingQuest = this.db.prepare('SELECT status FROM player_story_quests WHERE user_id = ? AND quest_id = ?').get(userId, choice.startQuest)
        if (!existingQuest) {
          const now = Date.now()
          this.db.prepare(`
            INSERT INTO player_story_quests(user_id, quest_id, status, started_at)
            VALUES (?, ?, 'active', ?)
          `).run(userId, choice.startQuest, now)
        }
      }

      this.applyEffects(userId, choice.effects)
      if (choice.addItem) this.playerStore.addInventory(userId, choice.addItem.id, choice.addItem.name, 1)
      if (choice.removeItem) this.removeInventory(userId, choice.removeItem)
      if (choice.addFlag) flags.add(choice.addFlag)
      if (choice.completeQuest) this.completeQuest(userId, choice.completeQuest)
      if (choice.encounter) this.startEncounter(userId, choice.encounter, flags)

      const history = parseList(state.history_json)
      history.unshift(choice.consequence)
      const completedCount = this.db.prepare(`
        SELECT COUNT(*) AS count FROM player_story_quests WHERE user_id = ? AND status = 'completed'
      `).get(userId)
      const chapterComplete = choice.chapterComplete || Number(completedCount.count) >= storyQuests.length && choice.nextSceneId === 'chapter-end'
      this.db.prepare(`
        UPDATE player_story_state SET scene_id = ?, flags_json = ?, history_json = ?,
          decision_count = decision_count + 1, chapter_complete = ?, updated_at = ? WHERE user_id = ?
      `).run(
        choice.encounter ? state.scene_id : choice.nextSceneId,
        JSON.stringify([...flags]),
        JSON.stringify(history.slice(0, 24)),
        chapterComplete ? 1 : Number(state.chapter_complete),
        Date.now(),
        userId,
      )
      return { character: this.playerStore.getCharacter(userId), story: this.publicStory(userId) }
    })
  }
}
