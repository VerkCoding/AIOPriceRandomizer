# AIOPriceRandomizer

A readable, robust price randomizer mod for BlueHeadAIO Mod || SPT/FIKA.  
Features: seeded RNG, config defaults + overrides, currency conversion (RUB/USD/EUR), per-trader baseline handling, periodic scheduling, safe barter edits, and debug logging.

## Files

- `src/mod.js` — main mod file (drop-in)
- `src/aio-price-randomizer-loader.js` — AIOPriceRandomizerLoader configuration system
- `config.example.json` — commented human-readable example (for users)
- `config/config.json` — runtime config (create/edit; pure JSON)

## Installation

1) Extract this mod into your Root SPT folder aka ./[YourSPT]
2) Make sure AIOPriceRandomizer folder inside [YourSPT]/user/mods/

## Dependencies

- bluehead's AIO Trader (SPT 3.11.4) by bluehead — required
  - Download: https://forge.sp-tarkov.com/mod/374/blueheads-aio-trader

## Debugging

- Set `"debug": true` in `config/config.json` to see diagnostic logs and config search paths.
- If traders are blank:
  - Enable debug and check startup logs for errors and the `assort` dumps.
  - Make sure other mods don't mutate traders *after* `postDBLoad` (if they do, we can add hooks).

## Notes

- `config.example.json` contains comments — do not use it as runtime config.
- `config/config.json` must be valid JSON (no comments).

## Credits

- Shout-out to bluehead for bluehead's AIO Trader — this mod was built to work alongside their trader.
  - https://forge.sp-tarkov.com/mod/374/blueheads-aio-trader
