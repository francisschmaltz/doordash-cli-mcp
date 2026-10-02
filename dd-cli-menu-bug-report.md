# `menu --store-id` fails for Starbucks and Chick-fil-A across multiple markets

## Summary

`dd-cli menu --store-id` consistently fails for open Starbucks and Chick-fil-A stores across Austin, Los Angeles, and New York. The stores resolve correctly through `store-details`, and DoorDash's consumer ordering and targeted restaurant-item paths still work, but the bulk restaurant-menu tool returns an empty menu with a generic failure.

This blocks discovery of new restaurant items and therefore breaks reorder-then-customize workflows whenever the desired item was not already present in order history.

## Environment

- `dd-cli, version 0.2.1`
- `Darwin 25.5.0 arm64`
- Tested: 2026-07-31
- Authenticated consumer session

## Reproduction

```shell
./dd-cli --json-output menu \
  --store-id 33970061 \
  --intent $'Summary: Help the user inspect a restaurant menu\nuser prompt/purpose: "Show the restaurant menu"'
```

Repeat with any store ID in the table below.

## Failing stores

| Market | Brand | Store ID | Address |
|---|---|---:|---|
| Austin, TX | Starbucks | `33970061` | 2505 W Parmer Ln, Austin, TX 78758 |
| Austin, TX | Chick-fil-A | `961710` | 12501 N Mopac Expy, Austin, TX 78758 |
| Los Angeles, CA | Starbucks | `34313572` | 11401 Santa Monica Blvd, Los Angeles, CA 90025 |
| Los Angeles, CA | Chick-fil-A | `6072` | 3758 S Figueroa St, Los Angeles, CA 90007 |
| New York, NY | Starbucks | `24221016` | 325 Lafayette Ave, Brooklyn, NY 11238 |
| New York, NY | Chick-fil-A | `709490` | 166 Flatbush Ave, Brooklyn, NY 11217 |

`store-details` succeeds for every row and returns the correct brand, store ID, and address. `menu` fails for every row with:

```json
{
  "menu_id": "",
  "items": [],
  "success": false,
  "message": "Something went wrong retrieving the menu for store 33970061. Please try again.",
  "store_is_open": true
}
```

The store ID in the message changes, but the response shape is otherwise identical.

## Expected behavior

For a valid, open restaurant store ID, return the current menu, including its authoritative `menu_id` and item IDs. If the upstream operation fails, return the underlying diagnostic and exit nonzero.

## Working control

The same command, binary, authentication, and intent succeed for KFC store `17482` at 4501 San Pablo Ave, Emeryville, CA:

```json
{
  "success": true,
  "menu_id": "83596355",
  "item_count": 92,
  "store_is_open": true,
  "message": "Retrieved 132 items for store ID 17482"
}
```

This rules out a general authentication, command-syntax, numeric-store-ID, or restaurant-menu outage.

## Additional isolation

- Multiple additional Starbucks and Chick-fil-A locations fail identically.
- Multiple non-Starbucks/non-Chick-fil-A restaurants succeed, including larger McDonald's menus; raw item count alone does not explain the failure.
- A known Chick-fil-A item can still be fetched through `restaurant-item-details` using store `25021439`, menu `25103748`, and item `9459662774`.
- A known Starbucks item can still be fetched through `restaurant-item-details` for store `24585160` and item `23410603143`.
- DoorDash's public storefronts expose live menus for these locations, and consumer orders can still be placed.
- Calling the upstream `doordash_get_restaurant_menu` tool with `query`, `store_name`, `include_extras`, and pickup/delivery variants does not change the failure.

The failure therefore appears isolated to bulk menu aggregation/projection for at least the Starbucks and Chick-fil-A catalog schemas, not catalog availability in general. The server currently hides the actual exception behind the generic `success:false` response.

## Secondary defect: incorrect process exit status

Despite returning `structuredContent.success:false`, `dd-cli` exits with status `0`. The outer MCP response has `isError:false`, and the CLI appears to trust that flag without checking the operation-level `success` field.

## Requested fixes

1. Repair `doordash_get_restaurant_menu` for Starbucks and Chick-fil-A menu payloads.
2. Preserve a useful upstream error or correlation ID instead of replacing the failure with the generic message.
3. Make `dd-cli` exit nonzero whenever the returned operation has `success:false`, even if MCP `isError` is false.
4. Add regression coverage using representative Starbucks and Chick-fil-A stores from different markets.
