-- Redis Lua Script: Atomic Stock Reservation
-- Validates that the stock key exists and contains an integer >= requested amount,
-- then decrements the stock atomically using DECRBY.
--
-- KEYS[1]: stock:{productId}
-- ARGV[1]: requestedAmount (positive integer)

local stockKey = KEYS[1]
local requested = tonumber(ARGV[1])

if not requested or requested <= 0 then
  return redis.error_reply("ERR_INVALID_AMOUNT: requested quantity must be a positive integer")
end

local exists = redis.call('EXISTS', stockKey)
if exists == 0 then
  return {0, -1, "ERR_STOCK_KEY_NOT_FOUND"}
end

local currentStock = tonumber(redis.call('GET', stockKey))
if not currentStock then
  return {0, -1, "ERR_MALFORMED_STOCK_VALUE"}
end

if currentStock < requested then
  return {0, currentStock, "ERR_INSUFFICIENT_STOCK"}
end

local remaining = redis.call('DECRBY', stockKey, requested)
return {1, remaining, "SUCCESS"}
