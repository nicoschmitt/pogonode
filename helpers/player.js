const POGOProtos = require('node-pogo-protos');
const GoogleMapsAPI = require('googlemaps');
const _ = require('lodash');
const Promise = require('bluebird');
const logger = require('winston');

Promise.promisifyAll(GoogleMapsAPI.prototype);
const EncounterResult = POGOProtos.Networking.Responses.EncounterResponse.Status;

const APIHelper = require('./api');

const POKE_BALLS = [1, 2, 3, 4];
const INCUBATORS = [901, 902];

/**
 * Helper class to deal with our walker.
 */
class Player {

    /**
     * @constructor
     * @param {object} config - global config object
     * @param {object} state - global state object
     */
    constructor(config, state) {
        this.config = config;
        this.state = state;
        this.apihelper = new APIHelper(config, state);
    }

    /**
     * Encounter all pokemons in range (based on current state)
     * @param {bool} catchPokemon true to catch pokemons, by default only encounter them
     * @return {Promise}
     */
    encounterPokemons(catchPokemon) {
        let pokemons = this.state.map.catchable_pokemons;
        pokemons = _.uniqBy(pokemons, pk => pk.encounter_id);
        pokemons = _.filter(pokemons, pk => this.state.encountered.indexOf(pk.encounter_id) < 0);

        if (pokemons.length == 0) return Promise.resolve(0);

        logger.debug('Start encounters...');
        let client = this.state.client;
        return Promise.map(pokemons, pk => {
                    logger.debug('  encounter %s', pk.pokemon_id);
                    let batch = client.batchStart();
                    batch.encounter(pk.encounter_id, pk.spawn_point_id);
                    this.apihelper.always(batch);
                    return batch.batchCall().then(responses => {
                        return this.apihelper.parse(responses);

                    }).then(info => {
                        if (info.status == EncounterResult.POKEMON_INVENTORY_FULL) {
                            logger.warn('Pokemon bag full.');
                        } else if (info.status != EncounterResult.ENCOUNTER_SUCCESS) {
                            logger.warn('Error while encountering pokemon: %d', info.status);
                        } else {
                            // encounter success
                            this.state.encountered.push(pk.encounter_id);
                            this.state.events.emit('encounter', info.pokemon);

                            return {
                                encounter_id: pk.encounter_id,
                                spawn_point_id: pk.spawn_point_id,
                                pokemon_id: pk.pokemon_id,
                            };
                        }

                    }).delay(this.config.delay.encounter * 1000)
                    .then(encounter => {
                        if (catchPokemon) {
                            return this.catchPokemon(encounter);
                        } else {
                            return encounter;
                        }
                    });
                }, {concurrency: 1})
            .then(done => {
                if (done) logger.debug('Encounter done.');
                return done;
            });
    }

    /**
     * Get throw parameter.
     * Ball has some effect but is not curved.
     * Player is not a bad thrower but not a good one either.
     * @param {int} pokemonId Pokemon Id
     * @return {object} throw parameters
     */
    getThrowParameter(pokemonId) {
        let ball = this.getPokeBallForPokemon(encounter.pokemon_id);
        let lancer = {
            ball: ball,
            reticleSize: 1.25 + 0.70 * Math.random(),
            hit: true,
            spinModifier: 0.3 * Math.random(),
            normalizedHitPosition: 0,
        };

        if (Math.random() > 0.9) {
            // excellent throw
            lancer.reticleSize = 1.70 + 0.25 * Math.random();
            lancer.normalizedHitPosition = 1;
        } else if (Math.random() > 0.8) {
            // great throw
            lancer.reticleSize = 1.30 + 0.399 * Math.random();
            lancer.normalizedHitPosition = 1;
        } else if (Math.random() > 0.7) {
            // nice throw
            lancer.reticleSize = 1.00 + 0.299 * Math.random();
            lancer.normalizedHitPosition = 1;
        }

        return lancer;
    }

    /**
     * Catch pokemon passed in parameters.
     * @param {object} encounter Encounter result
     * @return {Promise}
     */
    catchPokemon(encounter) {
        if (!encounter) return Promise.resolve();

        let lancer = this.getThrowParameter(encounter.pokemon_id);
        if (lancer.ball < 0) {
            logger.warn('  no pokéball found for catching.');
            return;
        }

        logger.debug('  catch pokemon', encounter);

        let batch = this.state.client.batchStart();
        batch.catchPokemon(
            encounter.encounter_id,
            lancer.ball,
            lancer.reticleSize,
            encounter.spawn_point_id,
            lancer.hit,
            lancer.spinModifier,
            lancer.normalizedHitPosition
        );

        return this.apihelper.always(batch).batchCall()
                .then(responses => {
                    let info = this.apihelper.parse(responses);
                    if (info.caught) {
                        let pokemon = _.find(this.state.inventory.pokemon, pk => pk.id == info.id);
                        logger.info('Pokemon caught.', {pokemon_id: pokemon.pokemon_id});
                        this.state.events.emit('pokemon_caught', pokemon);
                    } else {
                        logger.info('Pokemon missed.', info);
                    }
                });
    }

    /**
     * Get a Pokéball from inventory for pokemon passed in params.
     * @param {int} pokemondId pokemon id to get a ball for
     * @return {int} id of pokemon
     */
    getPokeBallForPokemon(pokemondId) {
        let balls = _.filter(this.state.inventory.items, i => i.count > 0 && _.includes(POKE_BALLS, i.item_id));
        if (balls.length) {
            return _.head(balls).item_id;
        } else {
            return -1;
        }
    }
}

module.exports = Player;
