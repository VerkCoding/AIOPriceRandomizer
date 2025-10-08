"use strict";

const { loadAndValidateConfig } = require("./aio-price-randomizer-loader");

/**
 * Mulberry32 seeded PRNG
 * Returns a deterministic random number generator
 */
function seededRandom(seed) {
  let state = seed >>> 0;
  
  return function() {
    state += 0x6D2B79F5;
    state = Math.imul(state ^ (state >>> 15), state | 1);
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Round number based on mode
 */
function round(value, mode) {
  if (mode === "floor") return Math.floor(value);
  if (mode === "ceil") return Math.ceil(value);
  return Math.round(value);
}

class PriceRandomizer {
  constructor() {
    this.modName = "AIOPriceRandomizer";
    this.logger = console;
    this.config = null;
    this.rng = null;
    this.intervalTimer = null;
    
    // Price caches for performance
    this.baselinePrices = new Map();
    this.priceCache = new Map();
    this.currencyCache = new Map();
  }

  loadMod() {
    this.logger.info(`[${this.modName}] Mod loaded`);
  }

  /**
   * Resolve logger from dependency container
   */
  _getLogger(container) {
    try {
      return container.resolve("PrimaryLogger");
    } catch (e) {
      try {
        return container.resolve("WinstonLogger");
      } catch (e) {
        return console;
      }
    }
  }

  /**
   * Look up template price from database with caching
   */
  _lookupPrice(db, templateId) {
    if (this.priceCache.has(templateId)) {
      return this.priceCache.get(templateId);
    }

    let price = null;
    const templates = db.templates || {};
    const prices = templates.prices;

    // Try prices table first
    if (prices) {
      if (Array.isArray(prices)) {
        const entry = prices.find(p => p.Id === templateId || p.id === templateId);
        price = entry?.Price || entry?.price;
      } else if (prices[templateId]) {
        const entry = prices[templateId];
        price = entry.Price || entry.price || entry.DefaultPrice || entry.basePrice;
        if (typeof price === "string") {
          price = Number(price);
        }
      }
    }

    // Fallback to handbook
    if (!price && templates.handbook?.Items) {
      const handbook = templates.handbook.Items;
      const entry = Array.isArray(handbook)
        ? handbook.find(h => h.Id === templateId || h.id === templateId)
        : handbook[templateId];
      
      price = entry?.Price || entry?.price;
      if (typeof price === "string") {
        price = Number(price);
      }
    }

    // Cache the result
    const finalPrice = (price && price > 0) ? price : null;
    this.priceCache.set(templateId, finalPrice);
    return finalPrice;
  }

  /**
   * Build baseline prices from trader assortments
   */
  _buildBaselines(db, traderIds) {
    if (this.config.stickToBaseline && this.baselinePrices.size > 0) {
      return; // Already built, don't rebuild
    }

    this.baselinePrices.clear();
    const allTemplates = new Set();

    // Collect all unique templates from traders
    for (const traderId of traderIds) {
      const trader = db.traders?.[traderId];
      if (!trader?.assort?.items) continue;

      for (const item of trader.assort.items) {
        if (item?._tpl) {
          allTemplates.add(item._tpl);
        }
      }
    }

    // Look up prices for all templates
    for (const templateId of allTemplates) {
      const price = this._lookupPrice(db, templateId);
      if (price && price > 0) {
        this.baselinePrices.set(templateId, price);
      }
    }

    this.logger.info(`[${this.modName}] Built baselines for ${this.baselinePrices.size} items`);
  }

  /**
   * Convert ruble price to target currency
   */
  _convertCurrency(db, rubles, currencyTpl) {
    if (!this.currencyCache.has(currencyTpl)) {
      const rate = this._lookupPrice(db, currencyTpl);
      this.currencyCache.set(currencyTpl, rate || null);
    }

    const rate = this.currencyCache.get(currencyTpl);
    if (!rate || rate <= 0) return null;

    const converted = rubles / rate;
    if (!Number.isFinite(converted)) return null;

    return round(converted, this.config.CurrencyConversion.rounding);
  }

  /**
   * Find currency offer in trade list
   */
  _findCurrencyOffer(offers) {
    if (!Array.isArray(offers)) return null;

    const currencies = Object.values(this.config.currencyTpls);
    for (const offer of offers) {
      if (offer?._tpl && currencies.includes(offer._tpl)) {
        return offer;
      }
    }
    return null;
  }

  /**
   * Calculate randomized price based on baseline
   */
  _randomizePrice(baseline) {
    const min = this.config.minMultiplier;
    const max = this.config.maxMultiplier;
    const multiplier = this.rng() * (max - min) + min;
    
    let price = baseline * multiplier;

    // Apply absolute bounds if configured
    if (this.config.minAbsolute > 0) {
      price = Math.max(price, this.config.minAbsolute);
    }
    if (this.config.maxAbsolute > 0) {
      price = Math.min(price, this.config.maxAbsolute);
    }

    return round(price, this.config.rounding);
  }

  /**
   * Update trade offer with new price
   */
  _updateOffer(offers, rubles, db) {
    let target;
    
    if (this.config.onlyCashTrades) {
      target = this._findCurrencyOffer(offers);
      if (!target) return false;
    } else {
      target = offers[0];
      if (!target) return false;
    }

    // Update the offer count
    if (target._tpl === this.config.currencyTpls.ruble) {
      target.count = Math.max(1, rubles);
    } else {
      const converted = this._convertCurrency(db, rubles, target._tpl);
      target.count = Math.max(1, converted || Math.floor(rubles));
    }

    return true;
  }

  /**
   * Auto-discover AIO traders by nickname
   */
  _discoverTraders(db) {
    const found = [];
    const traders = db.traders || {};

    for (const [traderId, trader] of Object.entries(traders)) {
      const nickname = (trader?.base?.nickname || "").toLowerCase();
      
      if (nickname.includes("aio") || 
          nickname.includes("bluehead") || 
          nickname.includes("aiotrader")) {
        found.push(traderId);
      }
    }

    if (this.config.debug) {
      this.logger.debug(`[${this.modName}] Auto-discovered ${found.length} traders`);
    }

    return found;
  }

  /**
   * Process a single trader's assortment
   */
  _processTrader(trader, db) {
    if (!trader?.assort?.items) return 0;

    const barters = trader.assort.barter_scheme || {};
    let updatedCount = 0;

    for (const item of trader.assort.items) {
      if (!item?._tpl || !item?._id) continue;

      const baseline = this.baselinePrices.get(item._tpl);
      if (!baseline || baseline <= 0) continue;

      const newPrice = this._randomizePrice(baseline);
      const scheme = barters[item._id];
      if (!scheme) continue;

      const offers = Array.isArray(scheme[0]) ? scheme[0] : scheme;
      if (this._updateOffer(offers, newPrice, db)) {
        updatedCount++;
      }
    }

    if (updatedCount > 0 && this.config.debug) {
      const traderName = trader.base?.nickname || "Unknown";
      this.logger.info(`[${this.modName}] ${traderName}: updated ${updatedCount} offers`);
    }

    return updatedCount;
  }

  /**
   * Run one randomization cycle
   */
  _runCycle(db) {
    if (!this.config.enabled) {
      this.logger.info(`[${this.modName}] Disabled, skipping cycle`);
      return;
    }

    // Determine which traders to process
    let traderIds = this.config.traderIds.slice();
    if (this.config.autoDiscoverTraderIds) {
      const discovered = this._discoverTraders(db);
      if (discovered.length > 0) {
        traderIds = discovered;
      }
    }

    // Build baseline prices
    this._buildBaselines(db, traderIds);

    // Process each trader
    for (const traderId of traderIds) {
      const trader = db.traders?.[traderId];
      if (!trader) {
        this.logger.warn(`[${this.modName}] Trader not found: ${traderId}`);
        continue;
      }

      try {
        this._processTrader(trader, db);
      } catch (err) {
        this.logger.error(`[${this.modName}] Failed to process ${traderId}: ${err.message}`);
      }
    }
  }

  /**
   * Schedule periodic randomization
   */
  _schedule(db) {
    // Clear existing timer
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }

    // Run immediately
    this._runCycle(db);

    // Schedule periodic runs
    if (this.config.intervalSeconds > 0) {
      this.intervalTimer = setInterval(() => {
        try {
          this._runCycle(db);
        } catch (err) {
          this.logger.error(`[${this.modName}] Cycle error: ${err.message}`);
        }
      }, this.config.intervalSeconds * 1000);

      this.logger.info(`[${this.modName}] Scheduled cycle every ${this.config.intervalSeconds}s`);
    }
  }

  /**
   * SPT mod entry point - called after database load
   */
  postDBLoad(container) {
    // Initialize logger
    this.logger = this._getLogger(container);

    // Load and validate configuration
    const { config } = loadAndValidateConfig(__dirname, this.logger);
    this.config = config;

    // Initialize RNG with seed
    this.rng = seededRandom(this.config.seed);

    // Get database
    const db = container.resolve("DatabaseServer").getTables();

    if (this.config.debug) {
      const traderCount = Object.keys(db.traders || {}).length;
      this.logger.info(`[${this.modName}] Found ${traderCount} traders in database`);
    }

    // Start randomization
    try {
      this._schedule(db);
      this.logger.info(`[${this.modName}] Initialized successfully`);
    } catch (err) {
      this.logger.error(`[${this.modName}] Initialization failed: ${err.message}`);
    }
  }
}

module.exports = { mod: new PriceRandomizer() };