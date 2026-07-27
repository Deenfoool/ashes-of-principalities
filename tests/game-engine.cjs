const assert = require('node:assert/strict')

class StorageMock {
  constructor() { this.map = new Map() }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null }
  setItem(key, value) { this.map.set(key, String(value)) }
  removeItem(key) { this.map.delete(key) }
}

global.localStorage = new StorageMock()
const engine = require('../.test-build/engine.js')
const content = require('../.test-build/content.js')

let game = engine.createGame('Мирослав', 'hunter', engine.loadLegacy())
assert.equal(game.version, 2)
assert.equal(game.playerName, 'Мирослав')
assert.equal(game.stamina, 10)
assert.equal(game.inventory.includes('Короткий охотничий лук'), true)

game = { ...game, sceneId: 'tavern', coins: 20, inventory: [...game.inventory, 'Печать основателя'] }
const taxChoice = content.scenes.tavern.choices.find((choice) => choice.id === 'taxman-contract')
game = engine.applyChoice(game, taxChoice)
assert.equal(game.activeQuestId, 'taxman')
assert.equal(game.sceneId, 'taxman-road')

const guildResult = engine.createGuild(game, 'Серые вороны', 'СВ')
assert.equal(guildResult.error, null)
assert.equal(guildResult.guild.name, 'Серые вороны')
assert.equal(guildResult.game.coins, 8)
const upgraded = engine.upgradeGuildBranch(guildResult.guild, 'warband')
assert.equal(upgraded.guild.branches.warband, 1)
assert.equal(upgraded.guild.treePoints, 0)

let combatGame = { ...guildResult.game, sceneId: 'taxman-camp', stamina: 10 }
const fight = content.scenes['taxman-camp'].choices.find((choice) => choice.id === 'tax-attack')
combatGame = engine.applyChoice(combatGame, fight)
assert.ok(combatGame.combat)
for (let turn = 0; turn < 20 && combatGame.combat && !combatGame.isDead; turn += 1) {
  combatGame = engine.performCombatAction(combatGame, turn === 0 ? 'profession' : 'strike')
}
assert.ok(combatGame.isDead || combatGame.sceneId === 'taxman-verdict')

const completed = { ...game, completedQuestIds: ['taxman'], activeQuestId: null, sceneId: 'tavern' }
assert.equal(engine.canChoose(completed, taxChoice), false)
console.log('game engine smoke tests passed')
